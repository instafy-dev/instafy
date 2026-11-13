import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The login-shell values, beside PATH, that a turn may use (D26). */
export const CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS = Object.freeze([
  "CLAUDE_CONFIG_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
] as const);

export type ClaudeCodeLoginShellEnvKey = (typeof CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS)[number];
export type ClaudeCodeLoginShellEnv = Readonly<Partial<Record<ClaudeCodeLoginShellEnvKey, string>>>;

export type ClaudeCodeLoginShellReport = Readonly<{
  /** What `command -v claude` printed, when that is an absolute path. An alias or a function is not. */
  binaryPath: string | null;
  pathEntries: readonly string[];
  env: ClaudeCodeLoginShellEnv;
}>;

export type ClaudeCodeDetection = Readonly<{
  binaryPath: string | null;
  source: "login_shell" | "candidate" | null;
  pathEntries: readonly string[];
  env: ClaudeCodeLoginShellEnv;
}>;

export const CLAUDE_CODE_DETECT_TIMEOUT_MS = 10_000;
export const CLAUDE_CODE_DETECT_OUTPUT_CAP_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 4096;
const MAX_PATH_ENTRIES = 256;

/** Whether a string holds a control character, a newline or NUL included. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function marker(nonce: string, name: string): string {
  return `<<instafy-detect-${nonce}-${name}>>`;
}

/**
 * The command the login shell runs. Each value follows its own marker, and
 * every marker carries a per-run nonce, so nothing an rc file prints can pose
 * as one. printenv reads the exported environment, so PATH comes out
 * colon-separated whatever the shell, and only the named values are printed.
 */
export function buildClaudeCodeDetectScript(nonce: string): string {
  const printMarker = (name: string) => `printf '%s\\n' '${marker(nonce, name)}'`;
  return [
    printMarker("begin"),
    printMarker("bin"),
    "command -v claude",
    printMarker("PATH"),
    "/usr/bin/printenv PATH",
    ...CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS.flatMap((key) => [
      printMarker(key),
      `/usr/bin/printenv ${key}`,
    ]),
    printMarker("end"),
  ].join("; ");
}

function singleLineValue(lines: readonly string[] | undefined): string | null {
  if (!lines || lines.length !== 1) {
    return null;
  }
  const value = lines[0] ?? "";
  return value.length > 0 && value.length <= MAX_VALUE_CHARS && !hasControlCharacter(value)
    ? value
    : null;
}

/**
 * Read the values between this run's markers. Output before the first marker
 * or after the last, such as an rc file's greeting, is ignored. Without both
 * markers the run failed and nothing counts.
 */
export function parseClaudeCodeDetectOutput(
  output: string,
  nonce: string,
): ClaudeCodeLoginShellReport | null {
  const sections = new Map<string, string[]>();
  const sectionByMarker = new Map(
    ["bin", "PATH", ...CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS].map((name) => [marker(nonce, name), name]),
  );
  const begin = marker(nonce, "begin");
  const end = marker(nonce, "end");
  let started = false;
  let finished = false;
  let currentLines: string[] | null = null;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!started) {
      started = line === begin;
      continue;
    }
    if (line === end) {
      finished = true;
      break;
    }
    const section = sectionByMarker.get(line);
    if (section !== undefined) {
      currentLines = [];
      sections.set(section, currentLines);
      continue;
    }
    currentLines?.push(line);
  }
  if (!finished) {
    return null;
  }

  // Only an absolute path counts: for an alias or a function, `command -v`
  // prints the alias or the bare name instead.
  const bin = singleLineValue(sections.get("bin"));
  const binaryPath = bin && bin.startsWith("/") ? bin : null;

  const pathEntries: string[] = [];
  for (const entry of singleLineValue(sections.get("PATH"))?.split(":") ?? []) {
    if (entry.startsWith("/") && !pathEntries.includes(entry) && pathEntries.length < MAX_PATH_ENTRIES) {
      pathEntries.push(entry);
    }
  }

  const env: Partial<Record<ClaudeCodeLoginShellEnvKey, string>> = {};
  for (const key of CLAUDE_CODE_LOGIN_SHELL_ENV_KEYS) {
    const value = singleLineValue(sections.get(key));
    if (value) {
      env[key] = value;
    }
  }
  return Object.freeze({
    binaryPath,
    pathEntries: Object.freeze(pathEntries),
    env: Object.freeze(env),
  });
}

/** Whether a shell is an absolute path that /etc/shells lists. */
export function isListedLoginShell(shell: string, etcShells: string): boolean {
  if (!shell.startsWith("/")) {
    return false;
  }
  return etcShells
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#") && line === shell);
}

function collectLoginShellOutput(
  shell: string,
  script: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    outputCapBytes: number;
    endMarker: string;
  },
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exited = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const text = () => Buffer.concat(chunks).toString("utf8");

    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so a timeout or an oversized output can stop
      // the shell and anything its rc files started.
      child = spawn(shell, ["-ilc", script], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const stopGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (!exited) {
        stopGroup();
      }
      child.stdout?.destroy();
      resolve(value);
    };
    timer = setTimeout(() => finish(text()), options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.outputCapBytes) {
        finish(null);
        return;
      }
      chunks.push(chunk);
      if (exited && text().includes(options.endMarker)) {
        finish(text());
      }
    });
    child.once("error", () => finish(null));
    child.once("exit", () => {
      exited = true;
      // A job an rc file left in the background can hold the pipe open after
      // the shell exits; once the last marker is in, nothing else is needed.
      if (text().includes(options.endMarker)) {
        finish(text());
      }
    });
    child.once("close", () => finish(text()));
  });
}

export type RunClaudeCodeLoginShellOptions = {
  shell: string | null;
  homeDir: string;
  user: string;
  lang?: string;
  etcShellsPath?: string;
  timeoutMs?: number;
  outputCapBytes?: number;
  nonce?: string;
};

/**
 * Run the person's login shell once, interactively, as a terminal would, and
 * read where `claude` resolves, its PATH and the D26 values. It gets a
 * minimal environment, their home folder as its working directory and no
 * stdin. Null when the shell is not usable or printed no complete answer.
 */
export async function runClaudeCodeLoginShell(
  options: RunClaudeCodeLoginShellOptions,
): Promise<ClaudeCodeLoginShellReport | null> {
  const shell = options.shell?.trim() ?? "";
  let etcShells: string;
  try {
    etcShells = await fs.promises.readFile(options.etcShellsPath ?? "/etc/shells", "utf8");
  } catch {
    return null;
  }
  if (!isListedLoginShell(shell, etcShells) || !path.isAbsolute(options.homeDir)) {
    return null;
  }
  const nonce = options.nonce ?? randomBytes(8).toString("hex");
  const env: NodeJS.ProcessEnv = { HOME: options.homeDir, USER: options.user, SHELL: shell };
  if (options.lang) {
    env.LANG = options.lang;
  }
  const output = await collectLoginShellOutput(shell, buildClaudeCodeDetectScript(nonce), {
    cwd: options.homeDir,
    env,
    timeoutMs: options.timeoutMs ?? CLAUDE_CODE_DETECT_TIMEOUT_MS,
    outputCapBytes: options.outputCapBytes ?? CLAUDE_CODE_DETECT_OUTPUT_CAP_BYTES,
    endMarker: marker(nonce, "end"),
  });
  return output === null ? null : parseClaudeCodeDetectOutput(output, nonce);
}

/**
 * Where an install usually puts `claude`, checked only when the login shell
 * gave no path. Unverified locations; nothing under ~/.claude is one.
 */
export function claudeCodeCandidatePaths(homeDir: string): string[] {
  return [
    path.join(homeDir, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

export async function detectClaudeCode(
  options: RunClaudeCodeLoginShellOptions & {
    lstat?: (file: string) => { isFile(): boolean; isSymbolicLink(): boolean };
  },
): Promise<ClaudeCodeDetection> {
  const report = await runClaudeCodeLoginShell(options).catch(() => null);
  if (report?.binaryPath) {
    return Object.freeze({ ...report, source: "login_shell" as const });
  }
  const lstat = options.lstat ?? fs.lstatSync;
  let candidate: string | null = null;
  for (const file of claudeCodeCandidatePaths(options.homeDir)) {
    try {
      const stats = lstat(file);
      if (stats.isFile() || stats.isSymbolicLink()) {
        candidate = file;
        break;
      }
    } catch {
      // Not there.
    }
  }
  return Object.freeze({
    binaryPath: candidate,
    source: candidate ? ("candidate" as const) : null,
    pathEntries: report?.pathEntries ?? Object.freeze([]),
    env: report?.env ?? Object.freeze({}),
  });
}
