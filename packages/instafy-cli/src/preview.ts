import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import kleur from "kleur";
import { resolveRatholeBinaryForCli } from "./runtime.js";
import { loadCredentialFreeEnv } from "./bind.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";
import { extractControllerErrorMessage, formatAuthRejectedError } from "./errors.js";
import {
  PREVIEW_EXIT_NOT_LISTENING,
  PREVIEW_EXIT_PORT_NOT_ALLOWED,
  PreviewCommandError,
  noAnswerMessage,
  parsePreviewPort,
  probeLocalSite,
  reservedPreviewPorts,
  type LocalSiteProbe,
} from "./local-site.js";
import {
  captureSiteThumbnail,
  readThumbnailFile,
  sniffImage,
  type Thumbnail,
  type ThumbnailAttempt,
} from "./preview-thumbnail.js";
import {
  buildRatholeConfig,
  cleanUrl,
  isRatholeClientFor,
  readEnv,
  readProcessCommandLine,
  resolveControllerToken,
  resolveProject,
  resolveTunnelControllerUrl,
  spawnRatholeDetached,
  stopRatholeClient,
  waitForProcessExit,
  type ResolvedTunnelToken,
} from "./tunnel.js";

// `instafy preview` shows a site running in this space inside Studio. Unlike `instafy tunnel`,
// the tunnel is private: the controller records a preview card in the conversation and only space
// members can open it. The CLI never learns or prints a URL for it. Once the site is live, the card
// gets a picture of it (preview-thumbnail.ts), uploaded to the controller like the rest.

export { PREVIEW_EXIT_NOT_LISTENING, PREVIEW_EXIT_PORT_NOT_ALLOWED, PreviewCommandError };
export const PREVIEW_EXIT_UNAVAILABLE = 5;

export const PREVIEWS_UNAVAILABLE_MESSAGE = "Previews are not available on this server";

export type PreviewOpenOptions = {
  project?: string;
  controllerUrl?: string;
  controllerToken?: string;
  conversationId?: string;
  // The site's port. Required, except with `start`, which picks a free one when it is left out.
  port?: string | number;
  title?: string;
  path?: string;
  ratholeBin?: string;
  // How to start the site again when the process that started it exits, or the space sleeps, when it cannot be read
  // from the process on the port (`--serve-cmd "<command>"`). One command and its arguments, run from the current
  // directory, never a shell. `{port}` in it is the site's port.
  serveCmd?: string;
  // The directory `serveCmd` runs from (default: the current directory).
  cwd?: string;
  // `--start`: start `serveCmd` in the background, in its own session, without Instafy credentials, logging to
  // .instafy/agent/logs, and wait for the port. Without `port` it picks a free port and puts it in `{port}`. A port that
  // already answers is used only when it runs this same site; any other site there is refused.
  start?: boolean;
  // How long `start` waits for the port (default 60 s, as a wake does).
  startTimeoutMs?: number;
  // `--replace`: show this site on the port even when the port's open preview shows another site (another title or
  // folder). Without it the server refuses that open, so one site never takes over another's card.
  replace?: boolean;
  // Test hook: where the process listening on a port is read from (Linux /proc).
  procRoot?: string;
  // One short line of facts for the card (`--summary`), e.g. "Trip · 3 days · 14 places".
  summary?: string;
  // `--no-thumbnail` (false): no picture on the card. `thumbnailFile`: a picture a skill made itself.
  thumbnail?: boolean;
  thumbnailFile?: string;
};

export type PreviewListOptions = {
  project?: string;
  controllerUrl?: string;
  controllerToken?: string;
};

export type PreviewCloseOptions = PreviewListOptions & {
  previewId?: string;
};

export type PreviewCloseResult = {
  ok: true;
  previewId: string;
  // Whether the site `--start` started for it was stopped too.
  siteStopped: boolean;
};

export type PreviewSummary = {
  previewId: string;
  title: string;
  port: number;
  path: string;
  // Whether the preview is open (the tunnel grant's status), not whether the site answers.
  status: string;
  // Whether Open in Studio starts the site again, when the server says.
  restartable?: boolean;
};

export type PreviewOpenResult = PreviewSummary & {
  messageId: string | null;
  // The HTTP status the server's own check of the site got through the tunnel, or null when it got none
  // or did not say. That check sends `Host: localhost`, so a dev server's host check never shows up here.
  httpStatus: number | null;
  // Everything after `p-<label>--<id>.` in the host viewers reach the site under, or null when the
  // server does not say. A dev server that checks the Host header must allow this suffix.
  viewerHostSuffix: string | null;
  // Open in Studio can start the site again when the process that started it exits, or the space sleeps (a start
  // command was recorded).
  restartable: boolean;
  // Why it is not restartable, when it is not.
  restartNote?: string;
  // With `--start` only: the pid of the site this command started, or null when this same site already answered on
  // its port and nothing was started; and that site's log file (null when nothing was started).
  startedPid?: number | null;
  logFile?: string | null;
  // The card's picture: uploaded, skipped (and why), or failed (and why). It never changes the exit code.
  thumbnail: ThumbnailOutcome["status"];
  thumbnailReason?: string;
};

export type ThumbnailOutcome = { status: "uploaded" | "skipped" | "failed"; reason?: string };

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
  // How `--start` starts this site: `--serve-cmd` as given (its `{port}` left in) and the directory it runs from. A later
  // `--start` of the same command from the same directory is the same site, and gets this preview's port again.
  start?: PreviewServe;
  // The process that leads the site's own session, as `--start` (or a wake) started it, and its command line once the
  // site answered: `instafy preview close` stops that site too, but only while that pid still runs that command line.
  startedPid?: number;
  startedCommand?: string;
  // The site's folder in the workspace (`.` for the workspace itself), as the process serving it runs from, when that
  // was read; and when the site was last pictured for the card (ms since the epoch, as its page load began): when the
  // picture on the card was taken, or a later try that could not take one. The runtime reads both when a turn ends: a
  // turn that changed a file in that folder after that checks the site again (`instafy preview check`), which takes a
  // new picture. A preview with no recorded folder is left as it is.
  siteDir?: string;
  pictureAt?: number;
  // Opened with `--no-thumbnail`: no picture of the site goes on its card, from a check or at a turn's end either.
  noThumbnail?: boolean;
};

type PreviewStateFile = {
  version: 1;
  previews: PreviewStateEntry[];
};

// The rathole client dials the site at 127.0.0.1, so that is the only address the probe accepts.
const RATHOLE_LOCAL_HOSTS = ["127.0.0.1"] as const;
// Same limits as the server's.
const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 80;
const MAX_PATH_LENGTH = 512;
// An upload of the card's picture waits at most this long; the preview is open either way.
const THUMBNAIL_UPLOAD_TIMEOUT_MS = 15_000;
// How long `open` waits for another `instafy preview` command on this machine before giving up, and when a lock left
// by a command that died is taken over.
const STATE_LOCK_WAIT_MS = 120_000;
const STATE_LOCK_STALE_MS = 10 * 60_000;

/** Where the site's port goes in `--serve-cmd`: `--start` writes the port it picked there. */
export const PORT_PLACEHOLDER = "{port}";
// What to do when another site holds the port.
const PORT_TAKEN_HINT =
  "Run it with --start and without --port, so this site gets a free port of its own, or pass --replace to show this site on that port instead.";
// The same, on a port `--start` picked itself: leaving out --port again would pick it again.
const PICKED_PORT_TAKEN_HINT =
  "Pass --replace if this site replaces that one (this same site under a new title, for example); otherwise give this site a title of its own.";
// Where `--start` looks for a free port when no --port is given: away from the ports dev servers take by themselves
// (3000, 4173, 5173, 8000, 8080…) and below the ports a Linux machine hands out for outgoing connections (32768 and
// up), so a site started again after the space slept still finds its port free.
const AUTO_PORT_FIRST = 20_000;
const AUTO_PORT_COUNT = 10_000;
// How many ports `--start` tries, from the site's own, before it gives up.
const AUTO_PORT_TRIES = 64;

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

// Characters that change the direction of text around them.
const BIDI_CHARS_RE = /[\u202A-\u202E\u2066-\u2069]/;

/** `--summary` as the server will accept it: one line, 1 to 80 characters, no control or direction characters. */
export function parsePreviewSummary(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const summary = raw.replace(/\s+/g, " ").trim();
  if (!summary || [...summary].length > MAX_SUMMARY_LENGTH) {
    throw new Error(`--summary must be 1 to ${MAX_SUMMARY_LENGTH} characters.`);
  }
  if (CONTROL_CHARS_RE.test(summary) || BIDI_CHARS_RE.test(summary)) {
    throw new Error("--summary must not contain control or direction characters.");
  }
  return summary;
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
async function withStateLock<T>(fn: () => Promise<T>, waitMs = STATE_LOCK_WAIT_MS): Promise<T> {
  const lockFile = previewStateLockFile();
  fs.mkdirSync(instafyDir(), { recursive: true });
  const deadline = Date.now() + waitMs;
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
  method: "GET" | "POST" | "PUT";
  route: string;
  body?: unknown;
  retryCommand: string;
  // A 404 on the previews collection means the server has no previews API at all (an older server).
  notFoundMeansUnavailable?: boolean;
  timeoutMs?: number;
  // What to do when the server says another site's preview holds the port (default PORT_TAKEN_HINT).
  portTakenHint?: string;
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
      ...(params.timeoutMs ? { signal: AbortSignal.timeout(params.timeoutMs) } : {}),
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
    // Another site's open preview holds the port: the server names it.
    if (response.status === 409 && code === "port_in_use") {
      throw new PreviewCommandError(
        `${extractControllerErrorMessage(text) ?? "Another site's preview holds this port."} ${params.portTakenHint ?? PORT_TAKEN_HINT}`,
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
 * How to start the site again when the process that started it exits, or the space sleeps: `--serve-cmd` from the
 * current directory, else the argv and directory of the process listening on the port. `note` says why there is none.
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

// How long `--start` waits for the site's port, the same as a wake.
const START_PORT_WAIT_MS = 60_000;
const START_POLL_MS = 300;
const START_PROBE_TIMEOUT_MS = 2_000;
// Where `--start` writes the site's output, under the space's workspace.
const START_LOGS_DIR = path.join(".instafy", "agent", "logs");

/** `file` as the person would type it from the current directory: relative when inside it, else absolute. */
function displayPath(file: string, cwd = process.cwd()): string {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

/**
 * `--start`: runs the recorded start command (argv, never a shell) from its directory under the workspace, in its
 * own session (so it outlives the process that started it, and a terminal's process-group kill), with no terminal
 * input, its output appended to .instafy/agent/logs/preview-<port>.log, and the environment stripped of credentials
 * by the same rule as `instafy bind serve --detach`. Waits until the port answers on 127.0.0.1. Fails with exit 2
 * when the command exits first or the port does not answer in time (then the command is stopped).
 */
export async function startPreviewSite(params: {
  port: number;
  sitePath: string;
  serve: PreviewServe;
  root: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ pid: number; logFile: string }> {
  const { port, sitePath, serve, root } = params;
  const credentialFreeEnv = await loadCredentialFreeEnv();
  const env = credentialFreeEnv(params.env ?? process.env);
  const cwd = path.join(root, serve.cwd);
  const logFile = path.join(root, START_LOGS_DIR, `preview-${port}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a", 0o600);
  let exit: string | null = null;
  let spawnError: string | null = null;
  let pid: number | undefined;
  try {
    fs.writeSync(fd, `\n[instafy preview open --start] ${new Date().toISOString()} ${JSON.stringify(serve.argv)} in ${serve.cwd}\n`);
    const child = spawn(serve.argv[0]!, serve.argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", (error) => {
      spawnError = (error as NodeJS.ErrnoException).code ?? error.message;
    });
    child.on("exit", (code, signal) => {
      exit = signal ? `signal ${signal}` : `exit status ${code}`;
    });
    child.unref();
    pid = child.pid;
  } finally {
    fs.closeSync(fd);
  }
  // A command that cannot be run (ENOENT, EACCES) reports it on the next turn of the event loop.
  await new Promise((resolve) => setImmediate(resolve));
  const shownLog = displayPath(logFile);
  const fail = (why: string) =>
    new PreviewCommandError(`The site ${why} and did not answer on 127.0.0.1:${port}; log: ${shownLog}`, PREVIEW_EXIT_NOT_LISTENING);
  const deadline = Date.now() + (params.timeoutMs ?? START_PORT_WAIT_MS);
  for (;;) {
    if (spawnError || pid === undefined) throw fail(`could not be started (${spawnError ?? "no process"})`);
    if (exit) throw fail(`started with --serve-cmd exited (${exit})`);
    const probe = await probeLocalSite(port, sitePath, START_PROBE_TIMEOUT_MS, RATHOLE_LOCAL_HOSTS);
    if (probe.listening) return { pid, logFile };
    if (exit) throw fail(`started with --serve-cmd exited (${exit})`);
    if (Date.now() >= deadline) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // already gone
      }
      throw fail(`started with --serve-cmd was stopped after ${Math.round((params.timeoutMs ?? START_PORT_WAIT_MS) / 1000)} s`);
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}

/** `argv` with every `{port}` replaced by `port`. */
export function withPort(argv: string[], port: number): string[] {
  return argv.map((arg) => arg.split(PORT_PLACEHOLDER).join(String(port)));
}

function sameArgv(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((arg, index) => arg === b[index]);
}

/** Whether two start commands are the same site's: the same command (as given, `{port}` left in) from the same directory. */
function sameStart(a: PreviewServe | undefined, b: PreviewServe): boolean {
  return Boolean(a && Array.isArray(a.argv) && a.cwd === b.cwd && sameArgv(a.argv, b.argv));
}

/**
 * The port `--start` tries first for a site that has none yet: one of AUTO_PORT_COUNT from AUTO_PORT_FIRST, chosen by its
 * start command and directory, so the same site gets the same port (and so the same preview and card) each time.
 */
export function preferredSitePort(start: PreviewServe): number {
  const digest = createHash("sha256").update(`${start.cwd}\0${start.argv.join("\0")}`).digest();
  return AUTO_PORT_FIRST + (digest.readUInt32BE(0) % AUTO_PORT_COUNT);
}

/**
 * Whether nothing holds `port` on this machine: it can be bound on each loopback and wildcard address there is. Any
 * server on it, answering or not, makes it taken.
 */
export async function portIsFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "0.0.0.0", "::1", "::"]) {
    const result = await new Promise<"free" | "taken" | "absent">((resolve) => {
      const server = net.createServer();
      server.once("error", (error: NodeJS.ErrnoException) =>
        resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT" ? "absent" : "taken"),
      );
      server.listen({ port, host, ...(host === "::" ? { ipv6Only: false } : {}) }, () => server.close(() => resolve("free")));
    });
    if (result === "taken") return false;
  }
  return true;
}

type StartedSite = { pid: number; logFile: string; command: string | null };

/** The port `--start` settled on, the start command as given, and the site it started (null: this same site already ran). */
type SiteStart = { port: number; start: PreviewServe; started: StartedSite | null };

/** Whether the site an entry records still runs: its pid still runs the command line recorded when it answered. */
function startedSiteRuns(entry: Pick<PreviewStateEntry, "startedPid" | "startedCommand">): boolean {
  return Boolean(entry.startedPid && entry.startedPid > 0 && entry.startedCommand) && readProcessCommandLine(entry.startedPid!) === entry.startedCommand;
}

/**
 * What holds `port`, as `--start` sees it: nothing; this same site (a preview of this space records this start command
 * on the port and the site it started still runs, or the process listening there runs exactly this command from this
 * directory of this space's workspace); or another site. One machine can run several spaces as one user (a desktop
 * runtime), so they share the CLI's state and its ports: another space's site is never this one, whatever its command
 * and the name of its folder.
 */
async function siteOnPort(params: {
  port: number;
  start: PreviewServe;
  root: string;
  projectId: string;
  previews: PreviewStateEntry[];
  procRoot?: string;
}): Promise<"none" | "same" | "other"> {
  const { port, start, root, projectId, previews, procRoot } = params;
  if (await portIsFree(port)) return "none";
  if (
    previews.some(
      (entry) => entry.projectId === projectId && entry.localPort === port && sameStart(entry.start, start) && startedSiteRuns(entry),
    )
  ) {
    return "same";
  }
  const listening = detectListeningProcess(port, procRoot);
  if (listening && workspaceRelativeDir(root, listening.cwd) === start.cwd && sameArgv(listening.argv, withPort(start.argv, port))) {
    return "same";
  }
  return "other";
}

/**
 * A port another site holds, named by this space's preview on it when there is one (another space's is not named).
 * Never "already running": it is not this site.
 */
function portTakenError(port: number, previews: PreviewStateEntry[], projectId: string): PreviewCommandError {
  const holder = previews.find((entry) => entry.projectId === projectId && entry.localPort === port && entry.title);
  const what = holder ? `Port ${port} already shows '${holder.title}'.` : `Port ${port} is in use by another server.`;
  return new PreviewCommandError(`${what} Leave out --port: --start picks a free port for this site.`, PREVIEW_EXIT_PORT_NOT_ALLOWED);
}

/**
 * `--start`: the port for the site, and the site on it. With --port, that port: the same site already answering there is
 * used as it is, any other server there is refused, and on a free port the site is started. Without --port, the port
 * this same site had before (when it still has it), else the first free port from its own (`preferredSitePort`) that
 * no other site here holds or has a preview open on, and the site is started there with `{port}` replaced. Runs under
 * the state lock, so two commands never pick the same port.
 */
async function startOrFindSite(params: {
  explicitPort: number | null;
  start: PreviewServe;
  root: string;
  projectId: string;
  title: string;
  sitePath: string;
  timeoutMs?: number;
  procRoot?: string;
  openPorts: () => Promise<Map<number, string>>;
  log: (message: string) => void;
}): Promise<SiteStart> {
  const { explicitPort, start, root, projectId, title, sitePath, procRoot, log } = params;
  const { previews } = readStateFile();
  const onPort = (port: number) => siteOnPort({ port, start, root, projectId, previews, procRoot });
  const launch = async (port: number): Promise<SiteStart> => {
    const serve = { argv: withPort(start.argv, port), cwd: start.cwd };
    const started = await startPreviewSite({ port, sitePath, serve, root, timeoutMs: params.timeoutMs });
    log(`Started the site on port ${port} (pid ${started.pid}); log: ${displayPath(started.logFile)}`);
    // Its command line now that it answers (a launcher may have replaced itself): what `close` checks before stopping it.
    return { port, start, started: { ...started, command: readProcessCommandLine(started.pid) } };
  };

  if (explicitPort !== null) {
    const found = await onPort(explicitPort);
    if (found === "same") return { port: explicitPort, start, started: null };
    if (found === "other") throw portTakenError(explicitPort, previews, projectId);
    return launch(explicitPort);
  }

  const tried = new Set<number>();
  // This same site, started before: its port again, so it keeps its preview and its card.
  const known = previews.find((entry) => entry.projectId === projectId && sameStart(entry.start, start));
  if (known) {
    tried.add(known.localPort);
    const found = await onPort(known.localPort);
    if (found === "same") return { port: known.localPort, start, started: null };
    if (found === "none") return launch(known.localPort);
  }
  const reserved = reservedPreviewPorts();
  // Every port another site has a preview on here: any other start command of this space, and any site of another.
  const held = new Set(
    previews.filter((entry) => entry.projectId !== projectId || !sameStart(entry.start, start)).map((entry) => entry.localPort),
  );
  for (const [port, holder] of await params.openPorts()) {
    if (holder !== title) held.add(port);
  }
  const first = preferredSitePort(start);
  for (let index = 0; index < AUTO_PORT_TRIES; index += 1) {
    const port = AUTO_PORT_FIRST + ((first - AUTO_PORT_FIRST + index) % AUTO_PORT_COUNT);
    if (tried.has(port) || reserved.has(port) || held.has(port)) continue;
    tried.add(port);
    const found = await onPort(port);
    if (found === "same") return { port, start, started: null };
    if (found === "none") return launch(port);
  }
  throw new PreviewCommandError(
    `No free port was found for the site: ${tried.size} ports from ${first} are taken. Stop a site this space no longer needs (instafy preview close <previewId>), then retry.`,
    PREVIEW_EXIT_NOT_LISTENING,
  );
}

/**
 * Stops a site `--start` (or a wake) started: SIGTERM to its whole process group (it leads its own), then SIGKILL after
 * 4 s. Only while `pid` still runs `command`, the command line recorded when the site answered: a pid that now belongs
 * to anything else is never signalled. Whether it was stopped.
 */
async function stopSite(pid: number | undefined, command: string | null | undefined): Promise<boolean> {
  if (!pid || pid <= 0 || !command) return false;
  const ours = () => readProcessCommandLine(pid) === command;
  if (!ours()) return false;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      try {
        process.kill(pid, name);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  if (!(await waitForProcessExit(pid, 4_000)) && ours()) signal("SIGKILL");
  return true;
}

/**
 * What a preview's entry records about its site: the site `--start` just started; else, when the same site was already
 * running on the port (or no `--start`), the record of the site an entry of this space on this port still runs (never
 * another space's: `close` stops the site recorded); else only the start command.
 */
function siteRecordFor(
  site: SiteStart | null,
  previews: PreviewStateEntry[],
  port: number,
  projectId: string,
): Pick<PreviewStateEntry, "start" | "startedPid" | "startedCommand"> {
  if (site?.started) {
    return { start: site.start, startedPid: site.started.pid, ...(site.started.command ? { startedCommand: site.started.command } : {}) };
  }
  const earlier = previews.find(
    (entry) =>
      entry.projectId === projectId && entry.localPort === port && (!site || sameStart(entry.start, site.start)) && startedSiteRuns(entry),
  );
  if (earlier) return { start: earlier.start, startedPid: earlier.startedPid, startedCommand: earlier.startedCommand };
  return site ? { start: site.start } : {};
}

/** This space's open previews on this machine, by port, with their titles. Empty when the server does not say. */
async function openPreviewPorts(params: {
  controllerUrl: string;
  auth: ResolvedTunnelToken;
  projectId: string;
}): Promise<Map<number, string>> {
  const ports = new Map<number, string>();
  let rows: unknown[] = [];
  try {
    const listed = await controllerRequest({
      controllerUrl: params.controllerUrl,
      auth: params.auth,
      method: "GET",
      route: previewsRoute(params.projectId),
      retryCommand: "instafy preview list",
      notFoundMeansUnavailable: true,
      timeoutMs: 10_000,
    });
    rows = Array.isArray(listed.body) ? listed.body : [];
  } catch (error) {
    // Previews are off: say so before anything is started.
    if (error instanceof PreviewCommandError && error.exitCode === PREVIEW_EXIT_UNAVAILABLE) throw error;
    return ports;
  }
  const runtimeId = readEnv("RUNTIME_ID");
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const onRuntime = stringField(record, "runtimeId");
    if (runtimeId && onRuntime && onRuntime !== runtimeId) continue;
    const port = numberField(record, "port");
    if (port) ports.set(port, stringField(record, "title") ?? "");
  }
  return ports;
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
  // `--start`'s site on this port, when it ran.
  site: SiteStart | null;
  // Whether `--start` picked the port itself (no --port was given).
  portPicked: boolean;
}): Promise<{
  grant: Record<string, unknown>;
  previewId: string;
  entry: PreviewStateEntry;
  current: PreviewStateEntry | null;
}> {
  // The server is asked first, so a server without previews exits 5 before a client is
  // downloaded or started here.
  const { opts, port, title, sitePath, projectId, retryCommand, auth, controllerUrl, serverUrl, log, serve, site, portPicked } = params;
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
      ...(opts.summary ? { summary: opts.summary } : {}),
      metadata: { source: "instafy-cli" },
      ...(serve ? { serve } : {}),
      ...(opts.replace ? { replace: true } : {}),
    },
    retryCommand,
    notFoundMeansUnavailable: true,
    ...(portPicked ? { portTakenHint: PICKED_PORT_TAKEN_HINT } : {}),
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
  // Read before an older entry on this port is forgotten below: the site's record moves to this preview.
  const siteRecord = siteRecordFor(site, state.previews, port, projectId);

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
    ...siteRecord,
    ...(serve ? { siteDir: serve.cwd } : {}),
    // The same preview opened again keeps its picture until a new one is uploaded.
    ...(current?.pictureAt ? { pictureAt: current.pictureAt } : {}),
    ...(opts.thumbnail === false ? { noThumbnail: true } : {}),
  };
  upsertPreviewState(entry);
  return { grant, previewId, entry, current };
}

export async function previewOpen(opts: PreviewOpenOptions): Promise<PreviewOpenResult> {
  // A port that is out of range or Instafy's own (the same rules as `preview check`) is refused
  // before anything else: no probe, no request. The server decides as well (400 port_not_allowed).
  const explicitPort = opts.port === undefined || String(opts.port).trim() === "" ? null : parsePreviewPort(opts.port);
  const title = parsePreviewTitle(opts.title);
  const sitePath = parsePreviewPath(opts.path);
  const summary = parsePreviewSummary(opts.summary);
  // A malformed --serve-cmd, or one carrying a secret, is refused before anything is probed or asked for.
  const serveArgv = opts.serveCmd?.trim() ? parseExplicitServeCommand(opts.serveCmd) : null;
  if (opts.start && !serveArgv) {
    throw new PreviewCommandError('--start needs --serve-cmd "<command>" to start the site.', PREVIEW_EXIT_NOT_LISTENING);
  }
  if (explicitPort === null) {
    if (!opts.start) {
      throw new Error(`A port is required: --port <port>. Or start the site with --start and --serve-cmd, which picks a free port.`);
    }
    if (!serveArgv!.some((arg) => arg.includes(PORT_PLACEHOLDER))) {
      throw new Error(
        `--serve-cmd needs ${PORT_PLACEHOLDER} where the site's port goes, e.g. --serve-cmd "python3 -m http.server ${PORT_PLACEHOLDER} --bind 127.0.0.1": --start picks the port.`,
      );
    }
  }
  const projectId = resolveProject({ project: opts.project });
  const retryCommand = `instafy preview open${explicitPort === null ? "" : ` --port ${explicitPort}`} --title ${shellQuote(title)}`;
  const { auth, controllerUrl } = resolveAuth(opts, retryCommand);
  const serverUrl = cleanUrl(controllerUrl);
  // Progress goes to stderr so `--json` output stays parseable.
  const log = (message: string) => console.error(kleur.cyan(message));

  // With --start, the command is checked (one command, from inside the workspace, no secret) before anything runs.
  // Kept as given, `{port}` left in: that, and the directory it runs from, is what makes it this same site next time.
  const start = opts.start
    ? resolvePreviewServe({ port: explicitPort ?? 0, serveCmd: opts.serveCmd, projectId, cwd: opts.cwd }).serve
    : null;

  // From choosing the port to the state write, one `instafy preview` command at a time on this machine: two commands
  // never pick the same port, start the same site twice or start two clients for one preview.
  const { grant, previewId, entry, port, site, serve, restartNote } = await withStateLock(async () => {
    const site = start
      ? await startOrFindSite({
          explicitPort,
          start,
          root: resolveWorkspaceRoot(process.env, projectId)!,
          projectId,
          title,
          sitePath,
          timeoutMs: opts.startTimeoutMs,
          procRoot: opts.procRoot,
          openPorts: () => openPreviewPorts({ controllerUrl, auth, projectId }),
          log,
        })
      : null;
    const port = site?.port ?? explicitPort!;
    try {
      const probe = await probeLocalSite(port, sitePath, undefined, RATHOLE_LOCAL_HOSTS);
      if (!probe.listening) {
        throw await notListeningError(port, sitePath, probe);
      }
      // Read before anything else changes on the port: the process listening now is the one to restart later.
      const { serve, note } = resolvePreviewServe({
        port,
        serveCmd: opts.serveCmd?.split(PORT_PLACEHOLDER).join(String(port)),
        projectId,
        cwd: opts.cwd,
        procRoot: opts.procRoot,
      });
      const created = await createAndStartClient({
        opts: { ...opts, summary },
        port,
        title,
        sitePath,
        projectId,
        retryCommand,
        auth,
        controllerUrl,
        serverUrl,
        log,
        serve,
        site,
        portPicked: explicitPort === null,
      });
      return { ...created, port, site, serve, restartNote: note };
    } catch (error) {
      // A site started for a preview that did not open is stopped again: no card shows it, and it would hold the port.
      if (site?.started) await stopSite(site.started.pid, site.started.command ?? readProcessCommandLine(site.started.pid));
      throw error;
    }
  });

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
  const status = previewStatusFromHealth(readyBody);

  // The card's picture, once the site is live. Whatever happens here, the preview is open: the exit code stays.
  let thumbnail: ThumbnailOutcome;
  if (opts.thumbnail === false) {
    thumbnail = { status: "skipped", reason: "--no-thumbnail" };
  } else if (status !== "live") {
    thumbnail = { status: "skipped", reason: "the site is not live through the preview yet" };
  } else {
    if (!opts.thumbnailFile) log("Taking a picture of the site for its card…");
    const takenAt = Date.now();
    const attempt: ThumbnailAttempt = opts.thumbnailFile
      ? readThumbnailFile(opts.thumbnailFile)
      : await captureSiteThumbnail({ port, path: sitePath, host: "127.0.0.1" });
    thumbnail =
      "thumbnail" in attempt
        ? await uploadPreviewThumbnail({ controllerUrl, auth, projectId, previewId, thumbnail: attempt.thumbnail, retryCommand })
        : { status: attempt.status, reason: attempt.reason };
    // A capture that took or sent no picture counts as tried: a check of the unchanged site would fail the same way.
    if (thumbnail.status === "uploaded" || !opts.thumbnailFile) await recordPictured(previewId, takenAt);
  }

  return {
    previewId,
    title,
    port,
    path: sitePath,
    status,
    httpStatus: previewHttpStatusFromHealth(readyBody),
    messageId: stringField(readyBody, "messageId"),
    viewerHostSuffix: parseViewerHostSuffix(grant["viewerHostSuffix"]) ?? null,
    restartable,
    ...(restartable ? {} : { restartNote: restartNote ?? "the server did not record a start command" }),
    ...(opts.start ? { startedPid: site?.started?.pid ?? null, logFile: site?.started?.logFile ?? null } : {}),
    thumbnail: thumbnail.status,
    ...(thumbnail.reason ? { thumbnailReason: thumbnail.reason } : {}),
  };
}

/**
 * Uploads a preview's picture (`PUT …/thumbnail`). The controller checks the format from the bytes, removes metadata
 * and keeps it for space members who may open the preview. Never throws: a failure is reported, the preview stays open.
 */
export async function uploadPreviewThumbnail(params: {
  controllerUrl: string;
  auth: ResolvedTunnelToken;
  projectId: string;
  previewId: string;
  thumbnail: Thumbnail;
  retryCommand: string;
}): Promise<ThumbnailOutcome> {
  const { thumbnail } = params;
  // Only what the bytes say goes out, whatever the caller claimed.
  const facts = sniffImage(thumbnail.image);
  if (!facts) return { status: "skipped", reason: "the picture is not a JPEG, PNG or WebP" };
  try {
    await controllerRequest({
      controllerUrl: params.controllerUrl,
      auth: params.auth,
      method: "PUT",
      route: previewsRoute(params.projectId, params.previewId, "thumbnail"),
      body: {
        image: thumbnail.image.toString("base64"),
        contentType: facts.contentType,
        source: thumbnail.source,
        ...(thumbnail.description ? { description: thumbnail.description } : {}),
      },
      retryCommand: params.retryCommand,
      timeoutMs: THUMBNAIL_UPLOAD_TIMEOUT_MS,
    });
    return { status: "uploaded" };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    // An older server has no picture route: it answers 404 with no body of its own.
    if (/\(404\)/.test(message)) return { status: "failed", reason: "this server does not keep preview pictures" };
    return { status: "failed", reason: message.slice(0, 300) };
  }
}

// How long recording a picture's time waits for another `instafy preview` command on this machine.
const PICTURE_RECORD_LOCK_WAIT_MS = 5_000;

/**
 * Records when a preview's site was last pictured for its card (the picture now on it was taken, or a try could not
 * take one), so a turn that changes the site after it is known to have left an older picture. Never throws, and waits
 * for another preview command only briefly: an older time recorded only means the site is checked once more when a
 * turn changes it.
 */
async function recordPictured(previewId: string, takenAt: number): Promise<void> {
  try {
    await withStateLock(async () => {
      const state = readStateFile();
      const entry = state.previews.find((preview) => preview.previewId === previewId);
      if (!entry || (entry.pictureAt ?? 0) >= takenAt) return;
      entry.pictureAt = takenAt;
      writeStateFile(state);
    }, PICTURE_RECORD_LOCK_WAIT_MS);
  } catch {
    // Another preview command holds the state.
  }
}

/**
 * The preview this machine has open on a port and path (`instafy preview open` recorded it) whose card takes a picture
 * of the site, or null: none is open there, or it was opened with `--no-thumbnail`.
 */
function openPreviewFor(port: number, sitePath: string): PreviewStateEntry | null {
  const entry = readStateFile().previews.find((preview) => preview.localPort === port && preview.path === sitePath && preview.pid > 0);
  return entry && !entry.noThumbnail ? entry : null;
}

/** Whether `instafy preview check` should take a picture for a card: a preview is open on this port and path. */
export function hasOpenPreviewFor(port: number, sitePath: string): boolean {
  return openPreviewFor(port, sitePath) !== null;
}

/** `instafy preview check` tried to picture the site of the preview open on its port and path, and could not. */
export async function recordCheckPictureTried(input: { port: number; path: string; takenAt: number }): Promise<void> {
  const entry = openPreviewFor(input.port, input.path);
  if (entry) await recordPictured(entry.previewId, input.takenAt);
}

/**
 * `instafy preview check` refreshes the picture of the preview open on its port and path. Null when none is open.
 */
export async function uploadCheckThumbnail(input: {
  port: number;
  path: string;
  image: Buffer;
  description: string | null;
  // When the check began loading the page the picture is of (ms since the epoch).
  takenAt?: number;
}): Promise<ThumbnailOutcome | null> {
  const entry = openPreviewFor(input.port, input.path);
  if (!entry) return null;
  const retryCommand = `instafy preview check --port ${input.port}`;
  let auth: ResolvedTunnelToken;
  let controllerUrl: string;
  try {
    ({ auth, controllerUrl } = resolveAuth({ controllerUrl: entry.controllerUrl }, retryCommand));
  } catch (error) {
    return { status: "skipped", reason: `no Instafy token here: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}` };
  }
  // A token is only ever sent to the server the preview was opened on.
  if (cleanUrl(controllerUrl) !== cleanUrl(entry.controllerUrl)) {
    return { status: "skipped", reason: "the preview was opened on another server" };
  }
  const takenAt = input.takenAt ?? Date.now();
  const facts = sniffImage(input.image);
  if (!facts) {
    await recordPictured(entry.previewId, takenAt);
    return { status: "skipped", reason: "the picture is not a JPEG" };
  }
  const outcome = await uploadPreviewThumbnail({
    controllerUrl,
    auth,
    projectId: entry.projectId,
    previewId: entry.previewId,
    thumbnail: { image: input.image, ...facts, source: "capture", description: input.description },
    retryCommand,
  });
  // A picture the server would not take counts as tried too: the same site would only fail the same way again.
  await recordPictured(entry.previewId, takenAt);
  return outcome;
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
    ...(typeof record["restartable"] === "boolean" ? { restartable: record["restartable"] } : {}),
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

export async function previewClose(opts: PreviewCloseOptions): Promise<PreviewCloseResult> {
  const previewId = opts.previewId?.trim() ?? "";
  if (!previewId) {
    throw new Error("Preview id is required. Use `instafy preview list` to find it.");
  }
  let siteStopped = false;
  const entry = await withStateLock(async () => {
    const removed = removePreviewState(previewId);
    if (removed) {
      await stopClient(removed);
      // The site `--start` (or a wake) started for it stops too; a site started some other way is left running.
      siteStopped = await stopSite(removed.startedPid, removed.startedCommand);
    }
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
    // The local client (and the site) is already stopped; keep a record so a retry by id finds the space.
    if (entry) {
      const { startedPid: _pid, startedCommand: _command, ...rest } = entry;
      await withStateLock(async () => upsertPreviewState({ ...(siteStopped ? rest : entry), pid: -1 }));
    }
    throw error;
  }

  removeWorkdir(previewId);
  return { ok: true, previewId, siteStopped };
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
  console.log(`${label}: ${result.title} (port ${result.port}). Its card is in the conversation.`);
  if (result.thumbnail === "uploaded") {
    console.log(kleur.gray("The card shows a picture of the site; `instafy preview check` takes a new one after a change."));
  } else {
    console.log(kleur.gray(`No picture on the card (${result.thumbnailReason ?? result.thumbnail}).`));
  }
  if (result.startedPid) {
    console.log(kleur.gray(`Started the site in the background (pid ${result.startedPid}); log: ${displayPath(result.logFile ?? "")}`));
  } else if (result.startedPid === null) {
    console.log(kleur.gray("This site was already running on its port; nothing was started."));
  }
  if (result.restartable) {
    console.log(kleur.gray("Open starts the site again when the process that started it exits, or the space sleeps."));
  } else {
    console.log(
      kleur.yellow(
        `When the process that started it exits, or the space sleeps, Open cannot start the site by itself: ${result.restartNote}.`,
      ),
    );
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
  // A machine that stops or restarts revokes its previews: they leave this list, and their cards read Stopped.
  const stoppedNote =
    "A preview whose machine stopped or restarted is not listed; its card reads Stopped, and Open on a restartable card starts the site again.";
  if (previews.length === 0) {
    console.log(kleur.yellow("No open previews."));
    console.log(kleur.gray(stoppedNote));
    return;
  }
  for (const preview of previews) {
    const restart =
      preview.restartable === undefined ? "" : preview.restartable ? " · restartable" : " · not restartable";
    console.log(
      `${preview.previewId} · ${preview.title || "(untitled)"} · port=${preview.port}${preview.path === "/" ? "" : ` · path=${preview.path}`} · preview ${preview.status}${restart}`,
    );
  }
  console.log(
    kleur.gray(
      `This lists open previews; it does not check whether a site answers (${kleur.cyan("instafy preview check --port <port>")} does). ${stoppedNote}`,
    ),
  );
}
