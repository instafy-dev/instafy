import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import kleur from "kleur";
import { buildInstafyGitCredentialHelperValue } from "./git-helper.js";
import {
  resolveRuntimeControllerCredential,
  resolveRuntimeBoundControllerUrl,
} from "./runtime-controller-binding.js";

export type InstafyGitContext = {
  workTree: string;
  gitDir: string;
};

function pathExists(candidate: string): boolean {
  try {
    fs.statSync(candidate);
    return true;
  } catch {
    return false;
  }
}

export function findInstafyGitContext(startDir: string): InstafyGitContext | null {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  while (true) {
    const gitDir = path.join(current, ".instafy", ".git");
    if (pathExists(gitDir)) {
      return { workTree: current, gitDir };
    }
    if (current === root) break;
    current = path.dirname(current);
  }
  return null;
}

type GitCommandSplit = {
  globalArgs: string[];
  command: string | null;
  commandArgs: string[];
};

function splitGitCommand(userArgs: string[]): GitCommandSplit {
  const globalArgs: string[] = [];
  let index = 0;
  while (index < userArgs.length) {
    const arg = userArgs[index] ?? "";
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      break;
    }
    globalArgs.push(arg);

    // Skip values for global options that consume the next token.
    if (arg === "-c" || arg === "--config-env" || arg === "--exec-path" || arg === "--namespace") {
      if (index + 1 < userArgs.length) {
        globalArgs.push(userArgs[index + 1] ?? "");
        index += 2;
        continue;
      }
    }
    index += 1;
  }

  const command = index < userArgs.length ? (userArgs[index] ?? null) : null;
  const commandArgs = command ? userArgs.slice(index + 1) : [];
  return { globalArgs, command, commandArgs };
}

function validateGitArgs(userArgs: string[]) {
  let parsingGlobalOptions = true;
  for (let index = 0; index < userArgs.length; index += 1) {
    const arg = userArgs[index] ?? "";
    if (!parsingGlobalOptions) {
      continue;
    }
    if (arg === "--") {
      parsingGlobalOptions = false;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") {
      parsingGlobalOptions = false;
      continue;
    }

    if (arg === "--git-dir" || arg.startsWith("--git-dir=") || arg === "--work-tree" || arg.startsWith("--work-tree=") || arg === "-C") {
      throw new Error(
        `Unsupported argument "${arg}". Use ${kleur.cyan(
          "cd",
        )} instead; ${kleur.cyan("instafy git")} manages --git-dir/--work-tree automatically.`,
      );
    }

    // Skip the value for global options that consume the next token.
    if (arg === "-c" || arg === "--config-env" || arg === "--exec-path" || arg === "--namespace") {
      index += 1;
    }
  }
}

export function buildInstafyGitArgs(context: InstafyGitContext, userArgs: string[]): string[] {
  validateGitArgs(userArgs);
  return ["--git-dir", context.gitDir, "--work-tree", context.workTree, ...userArgs];
}

function syncOriginRemoteFromEnv(context: InstafyGitContext, cwd: string) {
  const desiredRemote = normalizeToken(process.env["ORIGIN_GIT_REMOTE_URL"]);
  if (!desiredRemote) {
    return;
  }

  const readCurrent = spawnSync(
    "git",
    buildInstafyGitArgs(context, ["config", "--get", "remote.origin.url"]),
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  const currentRemote =
    readCurrent.status === 0 && typeof readCurrent.stdout === "string"
      ? readCurrent.stdout.trim()
      : "";
  if (currentRemote === desiredRemote) {
    return;
  }

  const command = currentRemote
    ? ["remote", "set-url", "origin", desiredRemote]
    : ["remote", "add", "origin", desiredRemote];
  const update = spawnSync("git", buildInstafyGitArgs(context, command), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (update.error) {
    throw new Error(`Failed to update Instafy git origin remote: ${update.error.message}`);
  }
  if (update.status !== 0) {
    throw new Error(`Failed to update Instafy git origin remote: ${update.stderr.trim()}`);
  }
}

function normalizePathSpec(raw: string): string {
  return (raw ?? "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
}

function isReservedSyncPath(pathSpec: string): boolean {
  const normalized = normalizePathSpec(pathSpec);
  if (!normalized) {
    return false;
  }
  if (normalized === ".instafy" || normalized.startsWith(".instafy/")) {
    return true;
  }
  if (normalized === ".instafy/origin-staging" || normalized.startsWith(".instafy/origin-staging/")) {
    return true;
  }
  return normalized.split("/").some((segment) => segment === ".git" || segment.startsWith(".git.instafy-hidden-"));
}

function gitCapture(context: InstafyGitContext, args: string[], options: { cwd: string }) {
  const result = spawnSync("git", ["--git-dir", context.gitDir, "--work-tree", context.workTree, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

function collectDirtyPaths(context: InstafyGitContext, options: { cwd: string }): string[] {
  const result = gitCapture(context, ["status", "--porcelain=v1"], options);
  if (result.error) {
    throw new Error(`Failed to run git status: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git status failed (${result.status}): ${result.stderr.trim()}`);
  }

  const paths: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.length < 4) continue;
    const raw = line.slice(3).trim();
    if (!raw) continue;

    const rename = raw.split(" -> ");
    if (rename.length === 2) {
      for (const entry of rename) {
        const normalized = normalizePathSpec(entry).replace(/\/+$/, "");
        if (normalized) paths.push(normalized);
      }
      continue;
    }

    const normalized = normalizePathSpec(raw).replace(/\/+$/, "");
    if (normalized) paths.push(normalized);
  }

  paths.sort((a, b) => a.localeCompare(b));
  const unique: string[] = [];
  for (const value of paths) {
    if (unique.length === 0 || unique[unique.length - 1] !== value) {
      unique.push(value);
    }
  }
  return unique;
}

function findEmbeddedGitDirs(context: InstafyGitContext, pathSpecs: string[]): string[] {
  const instafyGitDir = path.resolve(context.gitDir);
  const seen = new Set<string>();

  for (const rawPath of pathSpecs) {
    const normalized = normalizePathSpec(rawPath).replace(/\/+$/, "");
    if (!normalized || normalized === "." || normalized === "/") {
      continue;
    }

    let cursor = normalized;
    while (cursor && cursor !== ".") {
      const candidate = path.join(context.workTree, ...cursor.split("/"), ".git");
      if (pathExists(candidate) && path.resolve(candidate) !== instafyGitDir) {
        seen.add(path.resolve(candidate));
      }

      const next = path.posix.dirname(cursor);
      if (next === "." || next === cursor) {
        break;
      }
      cursor = next;
    }
  }

  const candidates = Array.from(seen);
  candidates.sort((a, b) => {
    const depthA = a.split(path.sep).length;
    const depthB = b.split(path.sep).length;
    return depthB - depthA;
  });
  return candidates;
}

function hideEmbeddedGitDirs(context: InstafyGitContext, pathSpecs: string[]): Array<{ original: string; hidden: string }> {
  const candidates = findEmbeddedGitDirs(context, pathSpecs);
  if (candidates.length === 0) {
    return [];
  }

  const stagingBase = path.join(context.workTree, ".instafy", "origin-staging", "embedded-git");
  fs.mkdirSync(stagingBase, { recursive: true });

  const renames: Array<{ original: string; hidden: string }> = [];
  for (const candidate of candidates) {
    let hidden = path.join(stagingBase, randomUUID());
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!pathExists(hidden)) break;
      hidden = path.join(stagingBase, randomUUID());
    }
    fs.renameSync(candidate, hidden);
    renames.push({ original: candidate, hidden });
  }
  return renames;
}

function restoreEmbeddedGitDirs(renames: Array<{ original: string; hidden: string }>) {
  for (let index = renames.length - 1; index >= 0; index -= 1) {
    const rename = renames[index];
    if (!rename) continue;
    try {
      fs.renameSync(rename.hidden, rename.original);
    } catch {
      // ignore restore failures; leave evidence in .instafy/origin-staging for debugging
    }
  }
}

function parseAddArgs(commandArgs: string[]): { addOptions: string[]; pathSpecs: string[] } {
  const addOptions: string[] = [];
  const pathSpecs: string[] = [];
  let inPaths = false;

  for (const arg of commandArgs) {
    if (inPaths) {
      pathSpecs.push(arg);
      continue;
    }
    if (arg === "--") {
      inPaths = true;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      addOptions.push(arg);
      continue;
    }
    inPaths = true;
    pathSpecs.push(arg);
  }

  return { addOptions, pathSpecs };
}

function runInstafyGitAdd(context: InstafyGitContext, globalArgs: string[], commandArgs: string[], options: { cwd: string }): number {
  const parsed = parseAddArgs(commandArgs);
  const normalizedPathSpecs = parsed.pathSpecs
    .map((spec) => normalizePathSpec(spec))
    .filter((spec) => spec && spec !== "." && spec !== "/");

  const stageAll = normalizedPathSpecs.length === 0;
  const stagePaths = stageAll
    ? collectDirtyPaths(context, options).filter((entry) => !isReservedSyncPath(entry))
    : normalizedPathSpecs.filter((entry) => !isReservedSyncPath(entry));

  if (stagePaths.length === 0) {
    return 0;
  }

  const addOptions = [...parsed.addOptions];
  if (stageAll && !addOptions.some((opt) => opt === "-A" || opt === "--all")) {
    addOptions.unshift("-A");
  }

  const renames = hideEmbeddedGitDirs(context, stagePaths);
  try {
    const result = spawnSync(
      "git",
      [
        "--git-dir",
        context.gitDir,
        "--work-tree",
        context.workTree,
        ...globalArgs,
        "add",
        ...addOptions,
        "--",
        ...stagePaths,
      ],
      { stdio: "inherit", cwd: options.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );

    if (result.error) {
      throw new Error(`Failed to run git add: ${result.error.message}`);
    }
    return typeof result.status === "number" ? result.status : 1;
  } finally {
    restoreEmbeddedGitDirs(renames);
  }
}

export function runInstafyGit(userArgs: string[], options?: { cwd?: string }): number {
  const cwd = options?.cwd ?? process.cwd();
  if (userArgs.length === 0 || userArgs[0] === "--help" || userArgs[0] === "-h") {
    // Keep this minimal so it doesn't diverge from Git help output.
    console.log("instafy git <git-args...>");
    console.log("");
    console.log(
      `Runs ${kleur.cyan("git")} against the Instafy canonical repo at ${kleur.cyan(
        ".instafy/.git",
      )} (auto-detected by walking up from cwd).`,
    );
    console.log("");
    console.log("Example:");
    console.log(`  ${kleur.cyan('instafy git status')}`);
    console.log(`  ${kleur.cyan('instafy git add -A')}`);
    console.log(`  ${kleur.cyan('instafy git commit -am "instafy: checkpoint"')}`);
    return 0;
  }

  const context = findInstafyGitContext(cwd);
  if (!context) {
    throw new Error(
      [
        "No Instafy canonical git checkout found (expected .instafy/.git).",
        "",
        "Tips:",
        `- Run this inside a git-canonical workspace (where ${kleur.cyan(".instafy/.git")} exists).`,
        `- If you're trying to operate on a user repo, use normal ${kleur.cyan("git")} (it uses .git).`,
      ].join("\n"),
    );
  }

  validateGitArgs(userArgs);
  syncOriginRemoteFromEnv(context, cwd);
  const split = splitGitCommand(userArgs);
  if (split.command === "add") {
    return runInstafyGitAdd(context, split.globalArgs, split.commandArgs, { cwd });
  }

  const args = buildInstafyGitArgs(context, [
    "-c",
    `credential.helper=${buildInstafyGitCredentialHelperValue()}`,
    ...userArgs,
  ]);
  const result = spawnSync("git", args, {
    stdio: "inherit",
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    throw new Error(`Failed to run git: ${result.error.message}`);
  }
  return typeof result.status === "number" ? result.status : 1;
}

type GitSyncArgs = {
  message: string;
  json: boolean;
  originEndpointOverride: string | null;
  originTokenOverride: string | null;
  paths: string[] | null;
};

function printGitSyncHelp() {
  console.log("instafy git sync [options]");
  console.log("");
  console.log("Calls the Origin git sync endpoint (POST /git/sync) for the current runtime/workspace.");
  console.log("");
  console.log("Options:");
  console.log("  -m, --message <msg>       Commit message (recommended)");
  console.log("  --path <relativePath>     Only sync selected path(s) (repeatable)");
  console.log("  --origin-endpoint <url>   Override Origin base URL (default: $ORIGIN_ENDPOINT or localhost)");
  console.log(
    "  --origin-token <token>    Override Origin bearer token (default: $ORIGIN_ACCESS_TOKEN)",
  );
  console.log("  --json                    Output JSON");
  console.log("");
  console.log("Env fallback:");
  console.log(
    "  ORIGIN_ENDPOINT, ORIGIN_BIND_PORT, ORIGIN_ACCESS_TOKEN, ORIGIN_INTERNAL_TOKEN",
  );
  console.log("  An authorized runtime-machine context may mint a short-lived Origin token.");
}

function normalizeToken(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function isInvalidOriginAudienceError(status: number, body: string): boolean {
  if (status !== 401) {
    return false;
  }
  const normalized = body.toLowerCase();
  return normalized.includes("invalid origin token") || normalized.includes("invalidaudience");
}

type OriginMintCredential = {
  token: string;
  controllerUrl: string;
};

function resolveOriginMintCredential(): OriginMintCredential | null {
  const runtimeCredential = resolveRuntimeControllerCredential();
  if (!runtimeCredential || runtimeCredential.kind === "job") {
    // Human sessions and model/job credentials are intentionally not Origin
    // write-token minting capabilities. A caller outside a runtime-machine
    // lease must supply an explicit or provisioned Origin token instead.
    return null;
  }
  return {
    token: runtimeCredential.token,
    controllerUrl: resolveRuntimeBoundControllerUrl(runtimeCredential),
  };
}

function resolveProjectId(): string | null {
  return (
    normalizeToken(process.env["PROJECT_ID"]) ??
    normalizeToken(process.env["SPACE_ID"]) ??
    null
  );
}

function resolveOriginEndpoint(override: string | null): string {
  const direct = normalizeToken(override) ?? normalizeToken(process.env["ORIGIN_ENDPOINT"]);
  if (direct) {
    return normalizeUrl(direct);
  }

  const portRaw = normalizeToken(process.env["ORIGIN_BIND_PORT"]);
  const port = portRaw ? Number.parseInt(portRaw, 10) : 54332;
  const resolvedPort = Number.isFinite(port) && port > 0 ? port : 54332;
  return `http://127.0.0.1:${resolvedPort}`;
}

function httpOrigin(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error(`${label} must use http or https and must not contain credentials.`);
  }
  return parsed.origin;
}

function assertOriginEndpointBinding(selected: string, provisioned: string): void {
  if (
    httpOrigin(selected, "The selected Origin endpoint") !==
    httpOrigin(provisioned, "The provisioned Origin endpoint")
  ) {
    throw new Error(
      "Refusing to send an environment-provided Origin credential to an endpoint other than ORIGIN_ENDPOINT.",
    );
  }
}

type MintedOriginAccessToken = {
  endpoint: string;
  token: string;
};

function resolveLeaseId(): string | null {
  return (
    normalizeToken(process.env["RUNTIME_LEASE_ID"]) ??
    normalizeToken(process.env["LEASE_ID"]) ??
    null
  );
}

async function mintOriginAccessTokenForCli(): Promise<MintedOriginAccessToken | null> {
  const projectId = resolveProjectId();
  const controllerCredential = resolveOriginMintCredential();
  const leaseId = resolveLeaseId();
  if (!projectId || !controllerCredential || !leaseId) {
    return null;
  }

  const controllerUrl = controllerCredential.controllerUrl;

  const response = await fetch(`${controllerUrl.replace(/\/+$/, "")}/access_token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controllerCredential.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      projectId,
      protocol: "http",
      scopes: ["fs.write"],
      leaseId,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `failed to mint origin access token (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const payload = (await response.json()) as {
    endpoint?: string;
    token?: string;
  };
  const token = normalizeToken(payload.token);
  if (!token) {
    throw new Error("origin access token response missing token");
  }
  return {
    endpoint:
      normalizeToken(payload.endpoint)?.replace(/\/+$/, "") ??
      resolveOriginEndpoint(null),
    token,
  };
}

function parseGitSyncArgs(args: string[]): GitSyncArgs | "help" {
  let message: string | null = null;
  let json = false;
  let originEndpointOverride: string | null = null;
  let originTokenOverride: string | null = null;
  const paths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "-m" || arg === "--message") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${arg} requires a non-empty value`);
      }
      message = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--message=")) {
      const value = arg.slice("--message=".length).trim();
      if (!value) {
        throw new Error("--message requires a non-empty value");
      }
      message = value;
      continue;
    }
    if (arg === "--origin-endpoint") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("--origin-endpoint requires a URL");
      }
      originEndpointOverride = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--origin-endpoint=")) {
      const value = arg.slice("--origin-endpoint=".length).trim();
      if (!value) {
        throw new Error("--origin-endpoint requires a URL");
      }
      originEndpointOverride = value;
      continue;
    }
    if (arg === "--origin-token") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("--origin-token requires a token");
      }
      originTokenOverride = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith("--origin-token=")) {
      const value = arg.slice("--origin-token=".length).trim();
      if (!value) {
        throw new Error("--origin-token requires a token");
      }
      originTokenOverride = value;
      continue;
    }
    if (arg === "--path") {
      const value = args[index + 1];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("--path requires a relative path");
      }
      paths.push(value.trim());
      index += 1;
      continue;
    }
    if (arg.startsWith("--path=")) {
      const value = arg.slice("--path=".length).trim();
      if (!value) {
        throw new Error("--path requires a relative path");
      }
      paths.push(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const resolvedMessage =
    message ?? `instafy: sync ${new Date().toISOString().replace(/\..*$/, "")}Z`;

  return {
    message: resolvedMessage,
    json,
    originEndpointOverride,
    originTokenOverride,
    paths: paths.length > 0 ? paths : null,
  };
}

export async function runInstafyGitSync(args: string[], options?: { cwd?: string }): Promise<number> {
  void options;
  const parsed = parseGitSyncArgs(args);
  if (parsed === "help") {
    printGitSyncHelp();
    return 0;
  }

  const explicitOriginToken = normalizeToken(parsed.originTokenOverride);
  const environmentOriginToken =
    normalizeToken(process.env["ORIGIN_ACCESS_TOKEN"]) ??
    normalizeToken(process.env["ORIGIN_INTERNAL_TOKEN"]);

  let originEndpoint = resolveOriginEndpoint(parsed.originEndpointOverride);
  let originToken: string | null = explicitOriginToken ?? environmentOriginToken;

  if (!explicitOriginToken && environmentOriginToken) {
    const provisionedEndpoint = resolveOriginEndpoint(null);
    assertOriginEndpointBinding(originEndpoint, provisionedEndpoint);
  }

  if (!originToken) {
    try {
      const minted = await mintOriginAccessTokenForCli();
      if (minted) {
        if (parsed.originEndpointOverride) {
          assertOriginEndpointBinding(parsed.originEndpointOverride, minted.endpoint);
        }
        originEndpoint = minted.endpoint;
        originToken = minted.token;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(kleur.yellow(`[instafy git sync] ${message}; falling back to environment token.`));
    }
  }

  if (!originToken) {
    throw new Error(
      [
        "Origin bearer token missing.",
        "",
        "Provide an explicit --origin-token, a provisioned ORIGIN_ACCESS_TOKEN / ORIGIN_INTERNAL_TOKEN, or run from an authorized runtime-machine context.",
      ].join("\n"),
    );
  }

  const requestSync = async (endpoint: string, token: string) => {
    const url = `${endpoint.replace(/\/+$/, "")}/git/sync`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: parsed.message,
        paths: parsed.paths ?? undefined,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    }).catch((error) => {
      throw new Error(`Origin git sync request failed: ${String(error)}`);
    });
    const text = await response.text().catch(() => "");
    return { response, text };
  };

  let { response, text } = await requestSync(originEndpoint, originToken);

  if (
    !parsed.originTokenOverride &&
    environmentOriginToken &&
    isInvalidOriginAudienceError(response.status, text)
  ) {
    try {
      const minted = await mintOriginAccessTokenForCli();
      if (minted) {
        if (parsed.originEndpointOverride) {
          assertOriginEndpointBinding(parsed.originEndpointOverride, minted.endpoint);
        }
        originEndpoint = minted.endpoint;
        originToken = minted.token;
        ({ response, text } = await requestSync(originEndpoint, originToken));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        kleur.yellow(
          `[instafy git sync] failed to recover from invalid origin token: ${message}`,
        ),
      );
    }
  }

  if (!response.ok) {
    const suffix = text.trim() ? `: ${text.trim()}` : "";
    console.error(kleur.red(`Origin git sync failed (${response.status} ${response.statusText})${suffix}`));
    return 1;
  }

  const payload = text.trim() ? (JSON.parse(text) as { rev?: string } | null) : null;
  const rev = typeof payload?.rev === "string" ? payload.rev.trim() : "";
  if (!rev) {
    console.error(kleur.red("Origin git sync response missing rev field."));
    return 1;
  }

  if (parsed.json) {
    console.log(JSON.stringify({ rev }, null, 2));
  } else {
    console.log(rev);
  }
  return 0;
}
