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
  parsePreviewPort,
  probeLocalSite,
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
  // Everything after `p-<label>--<id>.` in the host viewers reach the site under, or null when the
  // server does not say. A dev server that checks the Host header must allow this suffix.
  viewerHostSuffix: string | null;
};

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
};

type PreviewStateFile = {
  version: 1;
  previews: PreviewStateEntry[];
};

// The rathole client dials the site at 127.0.0.1, so that is the only address the probe tries.
const RATHOLE_LOCAL_HOSTS = ["127.0.0.1"] as const;
const MAX_TITLE_LENGTH = 120;
const MAX_PATH_LENGTH = 512;

function instafyDir(): string {
  return path.join(os.homedir(), ".instafy");
}

function previewStateFile(): string {
  return path.join(instafyDir(), "cli-preview-state.json");
}

const HOST_SUFFIX_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/;

/** The controller's viewerHostSuffix, lowercased, or undefined when it is missing or not a plain host[:port]. */
export function parseViewerHostSuffix(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const suffix = raw.trim().toLowerCase();
  return suffix.length <= 253 && HOST_SUFFIX_RE.test(suffix) ? suffix : undefined;
}

function parsePreviewTitle(raw: string | undefined): string {
  const title = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!title) {
    throw new Error('A title is required: --title "<name>".');
  }
  if ([...title].length > MAX_TITLE_LENGTH) {
    throw new Error(`Title must be at most ${MAX_TITLE_LENGTH} characters.`);
  }
  return title;
}

function parsePreviewPath(raw: string | undefined): string {
  const value = raw?.trim() || "/";
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > MAX_PATH_LENGTH ||
    /[\s\\?#]/.test(value)
  ) {
    throw new Error("Path must start with / and contain no spaces, backslashes, ? or #.");
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

function configPathFor(workdir: string): string {
  return path.join(workdir, "rathole.toml");
}

// Stops the entry's client only if its pid still runs rathole with the entry's config.
async function stopClient(entry: Pick<PreviewStateEntry, "pid" | "workdir">) {
  await stopRatholeClient(entry.pid, configPathFor(entry.workdir));
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

/** What the server's /ready health says: live, not_responding, or unknown when it reports nothing. */
export function previewStatusFromHealth(readyBody: Record<string, unknown>): "live" | "not_responding" | "unknown" {
  const health =
    readyBody["health"] && typeof readyBody["health"] === "object"
      ? (readyBody["health"] as Record<string, unknown>)
      : null;
  if (health?.["listening"] === true) return "live";
  if (health?.["listening"] === false) return "not_responding";
  return "unknown";
}

export async function previewOpen(opts: PreviewOpenOptions): Promise<PreviewOpenResult> {
  // A port that is out of range or Instafy's own (the same rules as `preview check`) is refused
  // before anything else: no probe, no request. The server decides as well (400 port_not_allowed).
  const port = parsePreviewPort(opts.port);
  const title = parsePreviewTitle(opts.title);
  const sitePath = parsePreviewPath(opts.path);
  const projectId = resolveProject({ project: opts.project });
  const retryCommand = `instafy preview open --port ${port} --title ${shellQuote(title)}`;
  const { auth, controllerUrl } = resolveAuth(opts, retryCommand);
  const serverUrl = cleanUrl(controllerUrl);
  // Progress goes to stderr so `--json` output stays parseable.
  const log = (message: string) => console.error(kleur.cyan(message));

  const probe = await probeLocalSite(port, sitePath, undefined, RATHOLE_LOCAL_HOSTS);
  if (!probe.listening) {
    throw new PreviewCommandError(
      probe.status !== null
        ? `The site at http://127.0.0.1:${port}${sitePath} answered HTTP ${probe.status}. Fix the server error, then retry.`
        : `Nothing is answering on http://127.0.0.1:${port}${sitePath} (${probe.reason ?? "no answer"}). Start the site first, then retry.`,
      PREVIEW_EXIT_NOT_LISTENING,
    );
  }

  // The server is asked first, so a server without previews exits 5 before anything is
  // downloaded or started here.
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
    },
    retryCommand,
    notFoundMeansUnavailable: true,
  });
  const grant = (created.body && !Array.isArray(created.body) ? created.body : {}) as Record<string, unknown>;
  const previewId = stringField(grant, "previewId");
  if (!previewId) {
    throw new Error("Preview response is missing previewId.");
  }

  const workdir = path.join(instafyDir(), "cli-preview-workdirs", safePathSegment(previewId));
  const logFile = path.join(instafyDir(), "cli-preview-logs", `preview-${safePathSegment(previewId)}.log`);
  const configPath = configPathFor(workdir);
  const state = readStateFile();
  const current = state.previews.find((preview) => preview.previewId === previewId) ?? null;

  // From here on the server holds a preview. Any failure before the client runs closes it again,
  // so no grant or card is left without a tunnel behind it.
  let pid: number | null = null;
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
    if (current && readFileOrNull(configPath) === configBody && isRatholeClientFor(current.pid, configPath)) {
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
      removePreviewState(stale.previewId);
      // The token is only ever sent to the server it was resolved for.
      if (cleanUrl(stale.controllerUrl) === serverUrl) {
        await closePreviewOnServer(controllerUrl, auth, stale.projectId, stale.previewId).catch(() => {});
      }
    }

    if (pid === null) {
      const rathole = await resolveRathole(opts.ratholeBin, log);
      fs.writeFileSync(configPath, configBody, { encoding: "utf8", mode: 0o600 });
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
    if (pid !== null) await stopRatholeClient(pid, configPath);
    removePreviewState(previewId);
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
  };
  upsertPreviewState(entry);

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
      removePreviewState(previewId);
      await stopClient(entry);
    }
    throw error;
  }
  const readyBody = (ready.body && !Array.isArray(ready.body) ? ready.body : {}) as Record<string, unknown>;

  return {
    previewId,
    title,
    port,
    path: sitePath,
    status: previewStatusFromHealth(readyBody),
    messageId: stringField(readyBody, "messageId"),
    viewerHostSuffix: parseViewerHostSuffix(grant["viewerHostSuffix"]) ?? null,
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
  const entry = removePreviewState(previewId);
  if (entry) {
    await stopClient(entry);
  }

  const projectId = entry?.projectId ?? resolveProject({ project: opts.project });
  try {
    const { auth, controllerUrl } = resolveAuth(
      { ...opts, controllerUrl: opts.controllerUrl ?? entry?.controllerUrl },
      `instafy preview close ${previewId}`,
    );
    await closePreviewOnServer(controllerUrl, auth, projectId, previewId);
  } catch (error) {
    // The local client is already stopped; keep a record so a retry by id finds the space.
    if (entry) upsertPreviewState({ ...entry, pid: -1 });
    throw error;
  }

  if (entry) {
    fs.rmSync(entry.workdir, { recursive: true, force: true });
  }
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
  console.log(kleur.gray(`previewId=${result.previewId}`));
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
