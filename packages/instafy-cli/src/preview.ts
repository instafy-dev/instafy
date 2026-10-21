import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import kleur from "kleur";
import { resolveRatholeBinaryForCli } from "./runtime.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";
import { extractControllerErrorMessage, formatAuthRejectedError } from "./errors.js";
import {
  PREVIEW_EXIT_NOT_LISTENING,
  PREVIEW_EXIT_PORT_NOT_ALLOWED,
  PreviewCommandError,
  noAnswerMessage,
  parsePreviewPort,
  probeLocalSite,
  type LocalSiteProbe,
} from "./local-site.js";
import {
  buildRatholeConfig,
  cleanUrl,
  isRatholeClientFor,
  readEnv,
  resolveControllerToken,
  resolveProject,
  resolveTunnelControllerUrl,
  spawnRatholeDetached,
  stopRatholeClient,
  type ResolvedTunnelToken,
} from "./tunnel.js";

// `instafy preview` shows a site running in this space inside Studio. Unlike `instafy tunnel`,
// the tunnel is private: the controller records a "Ready to preview" card in the conversation and
// only space members can open it. The CLI never learns or prints a URL for it.

export { PREVIEW_EXIT_NOT_LISTENING, PREVIEW_EXIT_PORT_NOT_ALLOWED, PreviewCommandError };
export const PREVIEW_EXIT_UNAVAILABLE = 5;

export const PREVIEWS_UNAVAILABLE_MESSAGE = "Previews are not available on this server";

export type PreviewOpenOptions = {
  project?: string;
  controllerUrl?: string;
  controllerToken?: string;
  conversationId?: string;
  port?: string | number;
  title?: string;
  path?: string;
  ratholeBin?: string;
  // How to start the site again after the space sleeps, when it cannot be read from the process on the port
  // (`--serve-cmd "<command>"`). One command and its arguments, run from the current directory, never a shell.
  serveCmd?: string;
  // The directory `serveCmd` runs from (default: the current directory).
  cwd?: string;
};

export type PreviewListOptions = {
  project?: string;
  controllerUrl?: string;
  controllerToken?: string;
};

export type PreviewCloseOptions = PreviewListOptions & {
  previewId?: string;
};

export type PreviewSummary = {
  previewId: string;
  title: string;
  port: number;
  path: string;
  status: string;
};

export type PreviewOpenResult = PreviewSummary & {
  messageId: string | null;
  // The HTTP status the server's own check of the site got through the tunnel, or null when it got none
  // or did not say. That check sends `Host: localhost`, so a dev server's host check never shows up here.
  httpStatus: number | null;
  // Everything after `p-<label>--<id>.` in the host viewers reach the site under, or null when the
  // server does not say. A dev server that checks the Host header must allow this suffix.
  viewerHostSuffix: string | null;
  // Open in Studio can start the site again after the space sleeps (a start command was recorded).
  restartable: boolean;
  // Why it is not restartable, when it is not.
  restartNote?: string;
};

// How the site was started, as the controller records it: argv (never a shell) and the directory relative to the
// space's workspace. A wake runs exactly this on the runtime, without a model turn.
export type PreviewServe = { argv: string[]; cwd: string };

type PreviewStateEntry = {
  previewId: string;
  projectId: string;
  title: string;
  localPort: number;
  path: string;
  controllerUrl: string;
  pid: number;
  logFile: string;
  workdir: string;
  startedAt: string;
  /** the rathole binary that was spawned; absent in entries from older CLIs */
  binary?: string;
  // The controller's viewerHostSuffix for this preview. A tokenless local site (`instafy bind serve --preview`)
  // accepts the capability host only on exactly this domain: the preview id alone is not a secret.
  hostSuffix?: string;
  // The origin Studio frames this preview from (the controller's studioOrigin). A bound site in the preview accepts
  // frame messages (Ask Octo, location, follow mode) from this origin only, and none when it is missing.
  studioOrigin?: string;
};

type PreviewStateFile = {
  version: 1;
  previews: PreviewStateEntry[];
};

// The rathole client dials the site at 127.0.0.1, so that is the only address the probe accepts.
const RATHOLE_LOCAL_HOSTS = ["127.0.0.1"] as const;
// Same limits as the server's.
const MAX_TITLE_LENGTH = 120;
const MAX_PATH_LENGTH = 512;
// How long `open` waits for another `instafy preview` command on this machine before giving up, and when a lock left
// by a command that died is taken over.
const STATE_LOCK_WAIT_MS = 120_000;
const STATE_LOCK_STALE_MS = 10 * 60_000;

function instafyDir(): string {
  return path.join(os.homedir(), ".instafy");
}

function previewStateFile(): string {
  return path.join(instafyDir(), "cli-preview-state.json");
}

function previewStateLockFile(): string {
  return path.join(instafyDir(), "cli-preview-state.lock");
}

function workdirsRoot(): string {
  return path.join(instafyDir(), "cli-preview-workdirs");
}

function workdirFor(previewId: string): string {
  return path.join(workdirsRoot(), safePathSegment(previewId));
}

const HOST_SUFFIX_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/;

/** The controller's viewerHostSuffix, lowercased, or undefined when it is missing or not a plain host[:port]. */
export function parseViewerHostSuffix(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const suffix = raw.trim().toLowerCase();
  return suffix.length <= 253 && HOST_SUFFIX_RE.test(suffix) ? suffix : undefined;
}

/** The controller's studioOrigin as a bare http(s) origin, or undefined when it is missing or anything else. */
export function parseStudioOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 300) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
  return url.origin;
}

// C0 and C1 control characters, the ones the server refuses in a title (Rust's char::is_control).
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** The title as the server will accept it: whitespace runs become one space, 1 to 120 characters, no control characters. */
export function parsePreviewTitle(raw: string | undefined): string {
  const title = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!title) {
    throw new Error('A title is required: --title "<name>".');
  }
  if ([...title].length > MAX_TITLE_LENGTH) {
    throw new Error(`Title must be at most ${MAX_TITLE_LENGTH} characters.`);
  }
  if (CONTROL_CHARS_RE.test(title)) {
    throw new Error("Title must not contain control characters.");
  }
  return title;
}

/**
 * The site path as the server will accept it: starts with / (not //), at most 512 characters of printable ASCII with
 * no space, backslash or #. A query string is allowed.
 */
export function parsePreviewPath(raw: string | undefined): string {
  const value = raw?.trim() || "/";
  let printable = true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || code === 0x5c || code === 0x23) {
      printable = false;
      break;
    }
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.length > MAX_PATH_LENGTH || !printable) {
    throw new Error(
      `Path must start with / (not //) and be at most ${MAX_PATH_LENGTH} printable ASCII characters with no spaces, backslashes or #.`,
    );
  }
  return value;
}

function readStateFile(): PreviewStateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(previewStateFile(), "utf8")) as PreviewStateFile;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.previews)) {
      return { version: 1, previews: [] };
    }
    return { version: 1, previews: parsed.previews.filter(Boolean) };
  } catch {
    return { version: 1, previews: [] };
  }
}

function writeStateFile(state: PreviewStateFile) {
  fs.mkdirSync(instafyDir(), { recursive: true });
  fs.writeFileSync(previewStateFile(), JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
}

function upsertPreviewState(entry: PreviewStateEntry) {
  const state = readStateFile();
  const next = state.previews.filter((preview) => preview.previewId !== entry.previewId);
  next.unshift(entry);
  writeStateFile({ version: 1, previews: next });
}

function removePreviewState(previewId: string): PreviewStateEntry | null {
  const state = readStateFile();
  const existing = state.previews.find((preview) => preview.previewId === previewId) ?? null;
  writeStateFile({ version: 1, previews: state.previews.filter((preview) => preview.previewId !== previewId) });
  return existing;
}

// Removes a preview's workdir, which holds its rathole.toml and so its service token. Only this CLI's own workdir
// for that id is removed, whatever path a state file names.
function removeWorkdir(previewId: string) {
  fs.rmSync(workdirFor(previewId), { recursive: true, force: true });
}

// Forgets a preview locally: its state entry and its workdir go together.
function forgetPreview(previewId: string): PreviewStateEntry | null {
  const entry = removePreviewState(previewId);
  removeWorkdir(previewId);
  return entry;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockHolderIsGone(lockFile: string): boolean {
  try {
    const stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) return true;
    const pid = Number.parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - stat.mtimeMs > 5_000;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    // Gone already: the next exclusive create decides.
    return false;
  }
}

/**
 * Runs `fn` while holding the preview state lock, so two `instafy preview` commands on this machine (several Octo
 * turns at once) never both start a client for the same preview or overwrite each other's state. A lock whose holder
 * died is taken over.
 */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockFile = previewStateLockFile();
  fs.mkdirSync(instafyDir(), { recursive: true });
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockHolderIsGone(lockFile)) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("Another instafy preview command on this machine is still running. Retry when it is done.");
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

function configPathFor(workdir: string): string {
  return path.join(workdir, "rathole.toml");
}

// Stops the entry's client only if its pid still runs rathole with the entry's config.
async function stopClient(entry: Pick<PreviewStateEntry, "pid" | "workdir" | "binary">) {
  await stopRatholeClient(entry.pid, configPathFor(entry.workdir), entry.binary);
}

// Single-quoted for a POSIX shell, so a title with quotes still gives a command that can be copied.
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function safePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "preview";
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function previewsUnavailable(): PreviewCommandError {
  return new PreviewCommandError(`${PREVIEWS_UNAVAILABLE_MESSAGE}.`, PREVIEW_EXIT_UNAVAILABLE);
}

async function controllerRequest(params: {
  controllerUrl: string;
  auth: ResolvedTunnelToken;
  method: "GET" | "POST";
  route: string;
  body?: unknown;
  retryCommand: string;
  // A 404 on the previews collection means the server has no previews API at all (an older server).
  notFoundMeansUnavailable?: boolean;
}): Promise<{ status: number; body: Record<string, unknown> | unknown[] | null }> {
  const { response } = await fetchWithControllerAuth({
    url: `${cleanUrl(params.controllerUrl)}${params.route}`,
    init: {
      method: params.method,
      headers: {
        accept: "application/json",
        ...(params.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
    },
    accessToken: params.auth.token,
    tokenSource: params.auth.source,
    profile: params.auth.profile,
    cwd: process.cwd(),
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    // Previews are off: the server says so (503 previews_unavailable), or it has no previews API at all (404 on
    // the collection). A 503 without that code (a database blip) stays an ordinary, retryable failure.
    const code = errorCode(text);
    if (
      (response.status === 503 && code === "previews_unavailable") ||
      (response.status === 404 && params.notFoundMeansUnavailable && !isStructuredError(text))
    ) {
      throw previewsUnavailable();
    }
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
        retryCommand: params.retryCommand,
      });
    }
    if (response.status === 400 && code === "port_not_allowed") {
      throw new PreviewCommandError(
        `The server does not allow previews on this port: ${extractControllerErrorMessage(text) ?? "port_not_allowed"}`,
        PREVIEW_EXIT_PORT_NOT_ALLOWED,
      );
    }
    const message = extractControllerErrorMessage(text) ?? response.statusText;
    throw new Error(`Preview request failed (${response.status}): ${message}`);
  }
  if (!text.trim()) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> | unknown[] };
  } catch {
    throw new Error(`Preview request returned invalid JSON (${response.status}).`);
  }
}

// Whether the body is the controller's own JSON error (a message or code). A route the server does not
// have answers 404 with no such body; a 404 that carries one ("runtime not found for project", a wrong
// space) is a real error and must not read as "previews are not available".
function isStructuredError(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return ["message", "code", "error"].some((key) => typeof record[key] === "string" && String(record[key]).trim() !== "");
  } catch {
    return false;
  }
}

// The controller's machine-readable error code (`code`, else `error`), when it is a plain token.
function errorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["code", "error"]) {
      const value = parsed?.[key];
      if (typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)) return value;
    }
  } catch {
    // not JSON
  }
  return null;
}

function resolveAuth(opts: { controllerUrl?: string; controllerToken?: string }, retryCommand: string) {
  const auth = resolveControllerToken({ controllerToken: opts.controllerToken }, retryCommand);
  // A job or machine token is pinned to CONTROLLER_BASE_URL; any other --server-url is refused.
  const controllerUrl = resolveTunnelControllerUrl({ controllerUrl: opts.controllerUrl }, auth);
  return { auth, controllerUrl };
}

function previewsRoute(projectId: string, previewId?: string, action?: string): string {
  const base = `/projects/${encodeURIComponent(projectId)}/previews`;
  if (!previewId) return base;
  return `${base}/${encodeURIComponent(previewId)}${action ? `/${action}` : ""}`;
}

async function closePreviewOnServer(
  controllerUrl: string,
  auth: ResolvedTunnelToken,
  projectId: string,
  previewId: string,
) {
  await controllerRequest({
    controllerUrl,
    auth,
    method: "POST",
    route: previewsRoute(projectId, previewId, "close"),
    body: {},
    retryCommand: `instafy preview close ${previewId}`,
  });
}

async function resolveRathole(ratholeBin: string | undefined, log: (message: string) => void): Promise<string> {
  if (ratholeBin) {
    process.env.RATHOLE_BIN = ratholeBin;
  }
  const rathole = await resolveRatholeBinaryForCli({
    env: process.env,
    version: process.env.RATHOLE_VERSION ?? null,
    cacheDir: process.env.RATHOLE_CACHE_DIR ?? null,
    logger: (message) => log(`[rathole] ${message}`),
    warn: (message) => console.error(kleur.yellow(message)),
  });
  if (!rathole) {
    throw new Error("rathole is required to open a preview. Set RATHOLE_BIN or ensure it is on PATH.");
  }
  return rathole;
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readyHealth(readyBody: Record<string, unknown>): Record<string, unknown> | null {
  return readyBody["health"] && typeof readyBody["health"] === "object" && !Array.isArray(readyBody["health"])
    ? (readyBody["health"] as Record<string, unknown>)
    : null;
}

/** What the server's /ready health says: live, not_responding, or unknown when it reports nothing. */
export function previewStatusFromHealth(readyBody: Record<string, unknown>): "live" | "not_responding" | "unknown" {
  const health = readyHealth(readyBody);
  if (health?.["listening"] === true) return "live";
  if (health?.["listening"] === false) return "not_responding";
  return "unknown";
}

/** The HTTP status in the server's /ready health, or null when it reports none. */
export function previewHttpStatusFromHealth(readyBody: Record<string, unknown>): number | null {
  const status = readyHealth(readyBody)?.["status"];
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

// Why `open` cannot use the site. The tunnel dials 127.0.0.1 only, so a site that answers only on [::1] (a server bound
// to `localhost` that resolves to ::1) is named as such instead of being reported as not running.
async function notListeningError(port: number, sitePath: string, probe: LocalSiteProbe): Promise<PreviewCommandError> {
  const where = `http://127.0.0.1:${port}${sitePath}`;
  if (probe.status !== null) {
    return new PreviewCommandError(
      `The site at ${where} answered HTTP ${probe.status}. Fix the server error, then retry.`,
      PREVIEW_EXIT_NOT_LISTENING,
    );
  }
  // A server took the connection but did not answer in time: it is running on 127.0.0.1, perhaps still compiling.
  if (probe.timedOut) {
    return new PreviewCommandError(noAnswerMessage(port, probe, where, "retry"), PREVIEW_EXIT_NOT_LISTENING);
  }
  const ipv6 = await probeLocalSite(port, sitePath, undefined, ["::1"]);
  if (ipv6.status !== null) {
    return new PreviewCommandError(
      `The site answers only on [::1]:${port}, and the preview reaches it on 127.0.0.1. ` +
        `It is running: do not start it again. Bind it to 127.0.0.1 or 0.0.0.0 instead (for example --host 127.0.0.1), restart it, then retry.`,
      PREVIEW_EXIT_NOT_LISTENING,
    );
  }
  return new PreviewCommandError(noAnswerMessage(port, probe, where, "retry"), PREVIEW_EXIT_NOT_LISTENING);
}

const SERVE_MAX_ARGS = 64;
const SERVE_MAX_ARG_LENGTH = 2048;
// Directories that do not survive the space going to sleep.
const EPHEMERAL_PREFIXES = ["/tmp/", "/var/tmp/", "/dev/shm/", "/run/"];

/**
 * Splits `--serve-cmd` into argv the way a shell would split ONE simple command: whitespace separates words, '...'
 * is literal, "..." allows \" \\ \$ and \`, and a backslash escapes the next character. What a shell would interpret
 * (pipes, `;`, `&&`, redirects, `$(...)`, `$VAR`, backticks) is refused, since the wake runs argv directly: a pipeline
 * belongs in a script. Glob characters are passed through as they are.
 */
export function parseServeCommand(raw: string): string[] {
  const argv: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const text = String(raw ?? "");
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && index + 1 < text.length && '"\\$`'.includes(text[index + 1]!)) {
        current += text[index + 1];
        index += 1;
      } else if (ch === "$" || ch === "`") {
        throw new Error(`--serve-cmd takes one command and its arguments, not shell syntax (found ${ch} in quotes).`);
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\") {
      if (index + 1 >= text.length) throw new Error("--serve-cmd ends with a lone backslash.");
      current += text[index + 1];
      index += 1;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (ch === "\n" || ch === "\r") {
        throw new Error("--serve-cmd takes one command on one line.");
      }
      if (inWord) {
        argv.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    if ("|&;<>()$`".includes(ch)) {
      throw new Error(
        `--serve-cmd takes one command and its arguments, not shell syntax (found ${ch}). Put a pipeline or several commands in a script and pass the script.`,
      );
    }
    current += ch;
    inWord = true;
  }
  if (quote) throw new Error("--serve-cmd has an unterminated quote.");
  if (inWord) argv.push(current);
  if (argv.length === 0) throw new Error("--serve-cmd is empty.");
  if (argv.length > SERVE_MAX_ARGS || argv.some((arg) => arg.length > SERVE_MAX_ARG_LENGTH || arg.includes("\0"))) {
    throw new Error(`--serve-cmd must have at most ${SERVE_MAX_ARGS} arguments of at most ${SERVE_MAX_ARG_LENGTH} characters.`);
  }
  return argv;
}

function realDir(dir: string): string | null {
  try {
    const resolved = fs.realpathSync(dir);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * The space's workspace directory on this runtime, as the runtime agent resolves it: WORKSPACE_PROJECT_DIR, else
 * <WORKSPACE_DIR>/<space id>. Null outside a runtime (nothing there restarts a site after a sleep).
 */
export function resolveWorkspaceRoot(env: NodeJS.ProcessEnv, projectId: string | null): string | null {
  const explicit = env["WORKSPACE_PROJECT_DIR"]?.trim();
  if (explicit) return realDir(explicit);
  const base = env["WORKSPACE_DIR"]?.trim();
  if (!base || !projectId) return null;
  return realDir(path.join(base, projectId));
}

/** `dir` relative to the workspace root (`.` for the root itself), or null when it is outside it. */
export function workspaceRelativeDir(root: string, dir: string): string | null {
  const resolved = realDir(dir);
  if (!resolved) return null;
  const relative = path.relative(root, resolved);
  if (relative === "") return ".";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

type ListeningProcess = { pid: number; argv: string[]; cwd: string };

function listeningSocketInodes(procRoot: string, port: number): Set<string> {
  const inodes = new Set<string>();
  for (const table of ["net/tcp", "net/tcp6"]) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(procRoot, table), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const local = fields[1] ?? "";
      const portHex = local.slice(local.lastIndexOf(":") + 1);
      // st 0A = LISTEN
      if (fields[3] === "0A" && Number.parseInt(portHex, 16) === port && fields[9] !== "0") {
        inodes.add(fields[9]!);
      }
    }
  }
  return inodes;
}

/**
 * The process listening on a TCP port, read from Linux /proc: the socket inode from /proc/net/tcp{,6}, the process
 * holding it from /proc/<pid>/fd, its argv from /proc/<pid>/cmdline and its directory from /proc/<pid>/cwd. Only
 * processes this user may inspect are seen. When several share the socket (a forking server), the lowest pid (the
 * parent, usually) wins. Null elsewhere or when nothing readable holds it.
 */
export function detectListeningProcess(port: number, procRoot = "/proc"): ListeningProcess | null {
  const inodes = listeningSocketInodes(procRoot, port);
  if (inodes.size === 0) return null;
  let pids: number[] = [];
  try {
    pids = fs
      .readdirSync(procRoot)
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds: string[] = [];
    try {
      fds = fs.readdirSync(path.join(procRoot, String(pid), "fd"));
    } catch {
      continue;
    }
    const holds = fds.some((fd) => {
      try {
        const target = fs.readlinkSync(path.join(procRoot, String(pid), "fd", fd));
        const match = /^socket:\[(\d+)\]$/.exec(target);
        return Boolean(match && inodes.has(match[1]!));
      } catch {
        return false;
      }
    });
    if (!holds) continue;
    try {
      const argv = fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8").split("\0");
      while (argv.length > 0 && argv[argv.length - 1] === "") argv.pop();
      const cwd = fs.readlinkSync(path.join(procRoot, String(pid), "cwd"));
      if (argv.length === 0) continue;
      return { pid, argv, cwd };
    } catch {
      continue;
    }
  }
  return null;
}

const SECRET_FLAG = /^-{1,2}(?!-|no-)[\w.-]*(token|secret|passw(or)?d|passwd|api[-_]?key|access[-_]?key|private[-_]?key|credentials?|auth(?![a-z]))[\w.-]*$/i;
const SECRET_ENV = /^(?=[A-Za-z_])\w*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[\w]*=./i;
const SECRET_VALUE = /^(sk|pk|rk)[-_][A-Za-z0-9_-]{12,}|^gh[pousr]_[A-Za-z0-9]{20,}|^xox[abposr]-|^AKIA[0-9A-Z]{12,}|^eyJ[A-Za-z0-9_-]{20,}\./;
const URL_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]*@/i;

/**
 * The argument of a start command that looks like a secret (`--api-key sk-…`, `--token=…`, `API_KEY=…`, a database
 * URL with a password, a known key format), or null. Such a command is not recorded: the controller keeps the
 * recorded command, and the site should read its secret from an env file instead.
 */
export function secretInServeCommand(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("-") ? (eq > 0 ? arg.slice(0, eq) : arg) : null;
    if (flag && SECRET_FLAG.test(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[i + 1];
      if (value && !value.startsWith("-")) return flag;
    }
    if (SECRET_ENV.test(arg)) return arg.slice(0, arg.indexOf("="));
    const bare = eq > 0 && arg.startsWith("-") ? arg.slice(eq + 1) : arg;
    if (URL_USERINFO.test(bare)) return "a URL with a password";
    if (SECRET_VALUE.test(bare)) return "a key";
  }
  return null;
}

/**
 * `--serve-cmd` as argv, refused when it is shell syntax or carries what looks like a secret: the controller keeps
 * the recorded command, so a secret belongs in an env file the site reads.
 */
export function parseExplicitServeCommand(raw: string): string[] {
  const argv = parseServeCommand(raw);
  const secret = secretInServeCommand(argv);
  if (secret) {
    throw new Error(
      `--serve-cmd carries what looks like a secret (${secret}), which is not recorded. Have the site read it from an env file and pass the command without it.`,
    );
  }
  return argv;
}

/**
 * How to start the site again after the space sleeps: `--serve-cmd` from the current directory, else the argv and
 * directory of the process listening on the port. `note` says why there is none.
 */
export function resolvePreviewServe(params: {
  port: number;
  serveCmd?: string;
  projectId: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  procRoot?: string;
  platform?: NodeJS.Platform;
}): { serve: PreviewServe | null; note?: string } {
  const env = params.env ?? process.env;
  const root = resolveWorkspaceRoot(env, params.projectId);
  const explicit = params.serveCmd?.trim();
  if (explicit) {
    const argv = parseExplicitServeCommand(explicit);
    if (!root) {
      throw new Error("--serve-cmd needs the space's workspace (WORKSPACE_DIR); run it inside the space.");
    }
    const cwd = workspaceRelativeDir(root, params.cwd ?? process.cwd());
    if (!cwd) {
      throw new Error(`--serve-cmd runs from the current directory, which must be inside the space's workspace (${root}).`);
    }
    return { serve: { argv, cwd } };
  }
  const notRestartable = (note: string) => ({ serve: null, note });
  const platform = params.platform ?? process.platform;
  if (platform !== "linux" && !params.procRoot) {
    return notRestartable("the start command can only be read on a Linux space; pass --serve-cmd");
  }
  if (!root) return notRestartable("this is not running inside a space's workspace");
  const found = detectListeningProcess(params.port, params.procRoot);
  if (!found) return notRestartable(`could not see which process listens on port ${params.port}; pass --serve-cmd`);
  const cwd = workspaceRelativeDir(root, found.cwd);
  if (!cwd) {
    return notRestartable(`the site runs from ${found.cwd}, outside the workspace, which does not survive a sleep`);
  }
  const ephemeral = found.argv.find((arg) => EPHEMERAL_PREFIXES.some((prefix) => arg.startsWith(prefix)));
  if (ephemeral) {
    return notRestartable(`its command uses ${ephemeral}, which does not survive a sleep; pass --serve-cmd`);
  }
  if (found.argv.length > SERVE_MAX_ARGS || found.argv.some((arg) => arg.length > SERVE_MAX_ARG_LENGTH)) {
    return notRestartable("its command line is too long to record; pass --serve-cmd");
  }
  const secret = secretInServeCommand(found.argv);
  if (secret) {
    return notRestartable(
      `its command line carries what looks like a secret (${secret}), which is not recorded; read it from an env file and pass --serve-cmd`,
    );
  }
  return { serve: { argv: found.argv, cwd } };
}

// Asks the server for the preview and starts (or reuses) its rathole client, then records it. Runs under the state lock.
async function createAndStartClient(params: {
  opts: PreviewOpenOptions;
  port: number;
  title: string;
  sitePath: string;
  projectId: string;
  retryCommand: string;
  auth: ResolvedTunnelToken;
  controllerUrl: string;
  serverUrl: string;
  log: (message: string) => void;
  serve: PreviewServe | null;
}): Promise<{
  grant: Record<string, unknown>;
  previewId: string;
  entry: PreviewStateEntry;
  current: PreviewStateEntry | null;
}> {
  // The server is asked first, so a server without previews exits 5 before anything is
  // downloaded or started here.
  const { opts, port, title, sitePath, projectId, retryCommand, auth, controllerUrl, serverUrl, log, serve } = params;
  const conversationId = opts.conversationId?.trim() || undefined;
  const created = await controllerRequest({
    controllerUrl,
    auth,
    method: "POST",
    route: previewsRoute(projectId),
    body: {
      runtimeId: readEnv("RUNTIME_ID"),
      runtimeLeaseId: readEnv("RUNTIME_LEASE_ID"),
      conversationId,
      port,
      path: sitePath,
      title,
      metadata: { source: "instafy-cli" },
      ...(serve ? { serve } : {}),
    },
    retryCommand,
    notFoundMeansUnavailable: true,
  });
  const grant = (created.body && !Array.isArray(created.body) ? created.body : {}) as Record<string, unknown>;
  const previewId = stringField(grant, "previewId");
  if (!previewId) {
    throw new Error("Preview response is missing previewId.");
  }

  const workdir = workdirFor(previewId);
  const logFile = path.join(instafyDir(), "cli-preview-logs", `preview-${safePathSegment(previewId)}.log`);
  const configPath = configPathFor(workdir);
  const hostSuffix = parseViewerHostSuffix(grant["viewerHostSuffix"]);
  const studioOrigin = parseStudioOrigin(grant["studioOrigin"]);
  const state = readStateFile();
  const current = state.previews.find((preview) => preview.previewId === previewId) ?? null;

  // From here on the server holds a preview. Any failure before the client runs closes it again,
  // so no grant or card is left without a tunnel behind it.
  let pid: number | null = null;
  let binary: string | undefined = current?.binary;
  try {
    const credentials =
      grant["credentials"] && typeof grant["credentials"] === "object"
        ? (grant["credentials"] as Record<string, unknown>)
        : {};
    const configBody = buildRatholeConfig(credentials, port);
    fs.mkdirSync(workdir, { recursive: true });
    fs.mkdirSync(path.dirname(logFile), { recursive: true });

    // The create call is idempotent per runtime, lease and port, so a re-run gets the same preview.
    // Keep its client when it is still our rathole on an unchanged config.
    if (current && readFileOrNull(configPath) === configBody && isRatholeClientFor(current.pid, configPath, current.binary)) {
      pid = current.pid;
    }
    // Replace any other client on this port. An older preview on the port is closed on the
    // server too, so its card does not stay up with nothing behind it.
    for (const stale of state.previews) {
      if (stale.previewId === previewId) {
        if (pid === null) await stopClient(stale);
        continue;
      }
      if (stale.localPort !== port) continue;
      await stopClient(stale);
      forgetPreview(stale.previewId);
      // The token is only ever sent to the server it was resolved for.
      if (cleanUrl(stale.controllerUrl) === serverUrl) {
        await closePreviewOnServer(controllerUrl, auth, stale.projectId, stale.previewId).catch(() => {});
      }
    }

    if (pid === null) {
      const rathole = await resolveRathole(opts.ratholeBin, log);
      fs.writeFileSync(configPath, configBody, { encoding: "utf8", mode: 0o600 });
      binary = rathole;
      const started = await spawnRatholeDetached({ rathole, configPath, workdir, logFile });
      if (started.exit !== null) {
        const suffix = started.logTail ? `\n\nLast logs:\n${started.logTail}` : "";
        throw new Error(`Preview tunnel exited (${started.exit}).${suffix}`);
      }
      pid = started.pid;
    } else {
      log(`Reusing the running preview client (pid ${pid}).`);
    }
  } catch (error) {
    if (pid !== null) await stopRatholeClient(pid, configPath, binary);
    forgetPreview(previewId);
    await closePreviewOnServer(controllerUrl, auth, projectId, previewId).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    const [first, ...rest] = message.split("\n");
    const closed = [`${first} The preview was closed.`, ...rest].join("\n");
    if (error instanceof PreviewCommandError) throw new PreviewCommandError(closed, error.exitCode);
    throw new Error(closed);
  }

  const entry: PreviewStateEntry = {
    previewId,
    projectId,
    title,
    localPort: port,
    path: sitePath,
    controllerUrl: serverUrl,
    pid,
    logFile,
    workdir,
    startedAt: current?.pid === pid ? current.startedAt : new Date().toISOString(),
    ...(binary ? { binary } : {}),
    ...(hostSuffix ? { hostSuffix } : {}),
    ...(studioOrigin ? { studioOrigin } : {}),
  };
  upsertPreviewState(entry);
  return { grant, previewId, entry, current };
}

export async function previewOpen(opts: PreviewOpenOptions): Promise<PreviewOpenResult> {
  // A port that is out of range or Instafy's own (the same rules as `preview check`) is refused
  // before anything else: no probe, no request. The server decides as well (400 port_not_allowed).
  const port = parsePreviewPort(opts.port);
  const title = parsePreviewTitle(opts.title);
  const sitePath = parsePreviewPath(opts.path);
  // A malformed --serve-cmd, or one carrying a secret, is refused before anything is probed or asked for.
  if (opts.serveCmd?.trim()) parseExplicitServeCommand(opts.serveCmd);
  const projectId = resolveProject({ project: opts.project });
  const retryCommand = `instafy preview open --port ${port} --title ${shellQuote(title)}`;
  const { auth, controllerUrl } = resolveAuth(opts, retryCommand);
  const serverUrl = cleanUrl(controllerUrl);
  // Progress goes to stderr so `--json` output stays parseable.
  const log = (message: string) => console.error(kleur.cyan(message));

  const probe = await probeLocalSite(port, sitePath, undefined, RATHOLE_LOCAL_HOSTS);
  if (!probe.listening) {
    throw await notListeningError(port, sitePath, probe);
  }
  // Read before anything else changes on the port: the process listening now is the one to restart later.
  const { serve, note: restartNote } = resolvePreviewServe({ port, serveCmd: opts.serveCmd, projectId, cwd: opts.cwd });

  // From the create call to the state write, one `instafy preview` command at a time on this machine.
  const { grant, previewId, entry } = await withStateLock(() =>
    createAndStartClient({ opts, port, title, sitePath, projectId, retryCommand, auth, controllerUrl, serverUrl, log, serve }),
  );

  // The client stays up if this fails: a re-run reuses it and only repeats the ready call.
  // If the server turned previews off in between, nothing is left running.
  let ready: Awaited<ReturnType<typeof controllerRequest>>;
  try {
    ready = await controllerRequest({
      controllerUrl,
      auth,
      method: "POST",
      route: previewsRoute(projectId, previewId, "ready"),
      body: {},
      retryCommand,
    });
  } catch (error) {
    if (error instanceof PreviewCommandError && error.exitCode === PREVIEW_EXIT_UNAVAILABLE) {
      await withStateLock(async () => {
        await stopClient(entry);
        forgetPreview(previewId);
      });
    }
    throw error;
  }
  const readyBody = (ready.body && !Array.isArray(ready.body) ? ready.body : {}) as Record<string, unknown>;
  // The server decides: an older controller ignores `serve` and answers without `restartable`.
  const restartable = serve !== null && grant["restartable"] === true;

  return {
    previewId,
    title,
    port,
    path: sitePath,
    status: previewStatusFromHealth(readyBody),
    httpStatus: previewHttpStatusFromHealth(readyBody),
    messageId: stringField(readyBody, "messageId"),
    viewerHostSuffix: parseViewerHostSuffix(grant["viewerHostSuffix"]) ?? null,
    restartable,
    ...(restartable ? {} : { restartNote: restartNote ?? "the server did not record a start command" }),
  };
}

function toPreviewSummary(raw: unknown): PreviewSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const previewId = stringField(record, "previewId", "id");
  if (!previewId) return null;
  return {
    previewId,
    title: stringField(record, "title") ?? "",
    port: numberField(record, "port", "localPort") ?? 0,
    path: stringField(record, "path") ?? "/",
    status: stringField(record, "status") ?? "unknown",
  };
}

export async function previewList(opts: PreviewListOptions): Promise<PreviewSummary[]> {
  const projectId = resolveProject({ project: opts.project });
  const { auth, controllerUrl } = resolveAuth(opts, "instafy preview list");
  const listed = await controllerRequest({
    controllerUrl,
    auth,
    method: "GET",
    route: previewsRoute(projectId),
    retryCommand: "instafy preview list",
    notFoundMeansUnavailable: true,
  });
  const rows = Array.isArray(listed.body)
    ? listed.body
    : listed.body && Array.isArray((listed.body as Record<string, unknown>)["previews"])
      ? ((listed.body as Record<string, unknown>)["previews"] as unknown[])
      : [];
  return rows.map(toPreviewSummary).filter((row): row is PreviewSummary => row !== null);
}

export async function previewClose(opts: PreviewCloseOptions): Promise<{ ok: true; previewId: string }> {
  const previewId = opts.previewId?.trim() ?? "";
  if (!previewId) {
    throw new Error("Preview id is required. Use `instafy preview list` to find it.");
  }
  const entry = await withStateLock(async () => {
    const removed = removePreviewState(previewId);
    if (removed) await stopClient(removed);
    return removed;
  });

  const projectId = entry?.projectId ?? resolveProject({ project: opts.project });
  try {
    const { auth, controllerUrl } = resolveAuth(
      { ...opts, controllerUrl: opts.controllerUrl ?? entry?.controllerUrl },
      `instafy preview close ${previewId}`,
    );
    await closePreviewOnServer(controllerUrl, auth, projectId, previewId);
  } catch (error) {
    // The local client is already stopped; keep a record so a retry by id finds the space.
    if (entry) await withStateLock(async () => upsertPreviewState({ ...entry, pid: -1 }));
    throw error;
  }

  removeWorkdir(previewId);
  return { ok: true, previewId };
}

export function printPreviewOpen(result: PreviewOpenResult, json: boolean) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label =
    result.status === "live"
      ? kleur.green("Ready to preview")
      : result.status === "not_responding"
        ? kleur.yellow("Not responding yet")
        : kleur.yellow("Preview opened (the server did not report whether the site answers)");
  console.log(`${label}: ${result.title} (port ${result.port}). Open it from the card in the conversation.`);
  if (result.restartable) {
    console.log(kleur.gray("Open starts the site again after the space sleeps."));
  } else {
    console.log(kleur.yellow(`After the space sleeps, Open cannot start the site by itself: ${result.restartNote}.`));
  }
  console.log(kleur.gray(`previewId=${result.previewId}`));
  if (result.httpStatus !== null && result.httpStatus >= 400) {
    console.log(kleur.yellow(`The site answered HTTP ${result.httpStatus} through the preview.`));
  }
  if (result.viewerHostSuffix) {
    console.log(kleur.gray(`viewerHostSuffix=${result.viewerHostSuffix}`));
  }
  console.log("");
  console.log("Next:");
  console.log(`- ${kleur.cyan("instafy preview list")}`);
  console.log(`- ${kleur.cyan(`instafy preview close ${result.previewId}`)}`);
}

export function printPreviewList(previews: PreviewSummary[], json: boolean) {
  if (json) {
    console.log(JSON.stringify(previews, null, 2));
    return;
  }
  if (previews.length === 0) {
    console.log(kleur.yellow("No previews found."));
    return;
  }
  for (const preview of previews) {
    console.log(
      `${preview.previewId} · ${preview.title || "(untitled)"} · port=${preview.port}${preview.path === "/" ? "" : ` · path=${preview.path}`} · ${preview.status}`,
    );
  }
}
