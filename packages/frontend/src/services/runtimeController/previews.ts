import {
  ControllerApiError,
  readControllerApiError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

/** The broker's probe of the site behind a preview. `status` is the HTTP status it answered with, when it did. */
export type SitePreviewHealth = { listening: boolean; status: number | null };

/**
 * A model-free restart of a stopped site (`POST …/wake`): `idle` when none is
 * running, `waking` while the runtime and the site start, `failed` with the
 * reason when the last one did not come up.
 */
export type SitePreviewWakeState = "idle" | "waking" | "failed";
export type SitePreviewWake = { state: SitePreviewWakeState; startedAt: string | null; error: string | null };

/** A site preview as the controller records it. It never carries an address. */
export type ControllerSitePreview = {
  previewId: string;
  title: string;
  port: number;
  path: string;
  runtimeId: string | null;
  /** The preview tunnel's status, for example issuing, active or revoked. */
  status: string;
  health: SitePreviewHealth | null;
  messageId: string | null;
  createdAt: string | null;
  /** Who may open it, as the controller recorded it (`private`: space members only). Absent when it did not say. */
  visibility?: string | null;
  /**
   * `instafy preview open` recorded how to start the site, so Open can wake it without Octo. Always set by
   * `mapControllerSitePreview`; absent means not restartable and no wake.
   */
  restartable?: boolean;
  wake?: SitePreviewWake;
  /**
   * Whether Open may start this preview for the person asking: they may change the space, or its machine is already
   * up (restarting only the site costs nothing). Null when the controller did not say.
   */
  canStart?: boolean | null;
  /** One line of facts for the card, as `instafy preview open --summary` gave it. Plain text. */
  summary?: string | null;
  /** The page's own `<meta name="description">`, read when its picture was taken. Plain text. */
  pageDescription?: string | null;
  /** The site's picture, fetched by preview and version (`getSitePreviewThumbnail`); null when it has none. */
  thumbnail?: SitePreviewThumbnail | null;
};

/** What the controller says about a preview's picture. The bytes come from `getSitePreviewThumbnail`. */
export type SitePreviewThumbnail = { version: string; width: number; height: number; capturedAt: string | null };

/** `preview.thumbnail_updated`: a preview has a new picture. Ids and the version only. */
export const SITE_PREVIEW_THUMBNAIL_EVENT = "instafy:preview-thumbnail-updated";
export type SitePreviewThumbnailEventDetail = { previewId: string; version: string };

export function mapSitePreviewThumbnailEvent(value: unknown): SitePreviewThumbnailEventDetail | null {
  if (!isRecord(value)) return null;
  const previewId = readString(value.previewId);
  const version = readString(value.version);
  return previewId && version && THUMBNAIL_VERSION.test(version) ? { previewId, version } : null;
}

/** A member-only capability address. Keep it in memory only: never store, log or show it. */
export type SitePreviewViewer = {
  viewerUrl: string;
  idleTimeoutSeconds: number | null;
  expiresAt: string | null;
};

/**
 * What the record alone says about the site. `pending` is a tunnel that is not
 * active yet; `unverified` is an active tunnel the broker could not probe.
 */
export type SitePreviewRecordState = "live" | "not_responding" | "stopped" | "pending" | "unverified";

const ENDED_PREVIEW_STATUSES: ReadonlySet<string> = new Set(["revoked", "expired", "closed", "failed"]);

/** The controller's code when previews are not configured on this server. */
export const SITE_PREVIEWS_UNAVAILABLE_CODE = "previews_unavailable";
/**
 * Set by this client on a 404 with no body: the controller has no preview
 * routes at all (an older controller), as opposed to its JSON 404 for a
 * preview that does not exist.
 */
export const SITE_PREVIEW_ROUTES_MISSING_CODE = "preview_routes_missing";

/**
 * Why the controller would not open or describe a preview, from its answer:
 * - `unavailable`: this server does not offer previews (503 `previews_unavailable`, no preview routes,
 *   or no controller configured in this Studio at all);
 * - `missing`: this preview does not exist (any other 404);
 * - `no_access`: this person may not open it (403);
 * - `stopped`: it exists but is no longer running (409, 410).
 * Anything else (a 5xx, a network error) is passing, and `null`.
 */
export type SitePreviewProblem = "unavailable" | "missing" | "no_access" | "stopped";

export function sitePreviewProblem(cause: unknown): SitePreviewProblem | null {
  if (!(cause instanceof ControllerApiError)) return null;
  if (cause.code === SITE_PREVIEWS_UNAVAILABLE_CODE || cause.code === SITE_PREVIEW_ROUTES_MISSING_CODE) return "unavailable";
  if (cause.status === 404) return "missing";
  if (cause.status === 403) return "no_access";
  if (cause.status === 409 || cause.status === 410) return "stopped";
  return null;
}

/** The controller's 429: this person opened too many sessions in the last minute. Asking again later helps. */
export function isSitePreviewRateLimited(cause: unknown): boolean {
  return cause instanceof ControllerApiError && cause.status === 429;
}

export function isSitePreviewsUnavailable(cause: unknown): boolean {
  return sitePreviewProblem(cause) === "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const readString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const readNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const THUMBNAIL_VERSION = /^[0-9a-f]{8,64}$/;
// Characters that change the direction of the text around them.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const FACTS_MAX_CHARS = 80;

/**
 * A line of facts as the card shows it: one line, no control or direction characters, at most 80 characters (an
 * ellipsis when cut). Shown as plain text, never Markdown or a link. Null when nothing is left.
 */
export function sitePreviewFactsText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = Array.from(value.replace(BIDI_CONTROLS, ""), (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length > FACTS_MAX_CHARS ? `${chars.slice(0, FACTS_MAX_CHARS - 1).join("").trimEnd()}…` : text;
}

/** The card's facts line: the skill's summary, else the page's own description. */
export function sitePreviewFacts(preview: Pick<ControllerSitePreview, "summary" | "pageDescription"> | null): string | null {
  return sitePreviewFactsText(preview?.summary) ?? sitePreviewFactsText(preview?.pageDescription);
}

export function mapSitePreviewThumbnail(value: unknown): SitePreviewThumbnail | null {
  if (!isRecord(value)) return null;
  const version = readString(value.version);
  const width = readNumber(value.width);
  const height = readNumber(value.height);
  if (!version || !THUMBNAIL_VERSION.test(version) || !width || !height || width <= 0 || height <= 0) return null;
  return { version, width, height, capturedAt: readString(value.capturedAt) };
}

function previewPath(projectId: string, previewId: string, suffix = "") {
  return `/projects/${encodeURIComponent(projectId)}/previews/${encodeURIComponent(previewId)}${suffix}`;
}

type PreviewRequestOptions = { body?: unknown; signal?: AbortSignal; keepalive?: boolean };

async function previewRequest(path: string, method: "GET" | "POST", fallback: string, { body, signal, keepalive }: PreviewRequestOptions = {}): Promise<unknown> {
  if (!runtimeControllerEnabled) {
    // A Studio with no controller offers no previews: the same answer as a controller with previews switched off.
    throw new ControllerApiError({ status: 503, message: "Runtime controller is not configured.", code: SITE_PREVIEWS_UNAVAILABLE_CODE, details: null });
  }
  const context = await resolveControllerRequestContext(null);
  if (!context.baseUrl || !context.accessToken) {
    throw new ControllerApiError({ status: 401, message: "Missing controller session token.", code: null, details: null });
  }
  const headers: Record<string, string> = { authorization: `Bearer ${context.accessToken}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${context.baseUrl}${path}`, {
    method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body),
    ...(keepalive ? { keepalive: true } : {}),
  });
  if (!response.ok) {
    const routeMissing = response.status === 404 && !(await response.clone().text().catch(() => "")).trim();
    const payload = await readControllerApiError(response, fallback, context);
    throw new ControllerApiError(routeMissing ? { ...payload, code: payload.code ?? SITE_PREVIEW_ROUTES_MISSING_CODE } : payload);
  }
  const text = response.status === 204 ? "" : await response.text();
  return text.trim() ? JSON.parse(text) as unknown : null;
}

export function mapSitePreviewHealth(value: unknown): SitePreviewHealth | null {
  if (!isRecord(value) || typeof value.listening !== "boolean") return null;
  return { listening: value.listening, status: readNumber(value.status) };
}

const IDLE_WAKE: SitePreviewWake = { state: "idle", startedAt: null, error: null };

export function mapSitePreviewWake(value: unknown): SitePreviewWake {
  if (!isRecord(value)) return IDLE_WAKE;
  const state = readString(value.state)?.toLowerCase();
  if (state !== "waking" && state !== "failed") return IDLE_WAKE;
  // Shown on the card as plain text: one short line, nothing more.
  const error = readString(value.error);
  return { state, startedAt: readString(value.startedAt), error: error ? error.replace(/\s+/g, " ").slice(0, 160) : null };
}

export function mapControllerSitePreview(value: unknown): ControllerSitePreview | null {
  if (!isRecord(value)) return null;
  const previewId = readString(value.previewId);
  const port = readNumber(value.port);
  if (!previewId || port === null) return null;
  return {
    previewId,
    title: readString(value.title) ?? "Preview",
    port,
    path: readString(value.path) ?? "/",
    runtimeId: readString(value.runtimeId),
    status: (readString(value.status) ?? "").toLowerCase(),
    health: mapSitePreviewHealth(value.health),
    messageId: readString(value.messageId),
    createdAt: readString(value.createdAt),
    visibility: readString(value.visibility),
    restartable: value.restartable === true,
    wake: mapSitePreviewWake(value.wake),
    canStart: typeof value.canStart === "boolean" ? value.canStart : null,
    summary: sitePreviewFactsText(value.summary),
    pageDescription: sitePreviewFactsText(value.pageDescription),
    thumbnail: mapSitePreviewThumbnail(value.thumbnail),
  };
}

const THUMBNAIL_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * The picture of a preview, with this person's own session: the controller reads it out only to members who may open
 * the preview, never cached on disk. `refused` when this person may not read it or it is gone, `transient` when it
 * could not be fetched now.
 */
export async function getSitePreviewThumbnail(
  projectId: string,
  previewId: string,
  version: string,
  signal?: AbortSignal,
): Promise<{ ok: true; blob: Blob } | { ok: false; reason: "refused" | "transient" }> {
  if (!runtimeControllerEnabled) return { ok: false, reason: "refused" };
  try {
    const context = await resolveControllerRequestContext(null);
    if (!context.baseUrl || !context.accessToken) return { ok: false, reason: "transient" };
    const response = await fetch(`${context.baseUrl}${previewPath(projectId, previewId, `/thumbnail?v=${encodeURIComponent(version)}`)}`, {
      headers: { authorization: `Bearer ${context.accessToken}`, accept: "image/jpeg,image/png,image/webp" },
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    if (response.status === 403 || response.status === 404 || response.status === 410) return { ok: false, reason: "refused" };
    if (!response.ok) return { ok: false, reason: "transient" };
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!THUMBNAIL_TYPES.has(type)) return { ok: false, reason: "refused" };
    const blob = await response.blob();
    return { ok: true, blob: blob.type === type ? blob : new Blob([blob], { type }) };
  } catch {
    return { ok: false, reason: "transient" };
  }
}

/**
 * Only the controller's record decides, and Live needs proof: an ended tunnel
 * is stopped, a tunnel not yet active is pending, an active tunnel with no
 * probe is unverified (the broker could not be asked, which says nothing about
 * the site), a probe that found nothing listening (or the broker's 502 to 504)
 * is not responding, and only a probe that saw the site answer is live.
 */
export function sitePreviewRecordState(preview: Pick<ControllerSitePreview, "status" | "health">): SitePreviewRecordState {
  if (ENDED_PREVIEW_STATUSES.has(preview.status)) return "stopped";
  if (preview.status !== "active") return "pending";
  const health = preview.health;
  if (!health) return "unverified";
  if (!health.listening || (health.status !== null && health.status >= 502 && health.status <= 504)) return "not_responding";
  return "live";
}

/**
 * What the card and the pane both say from the record alone, so one record
 * never reads two ways side by side: a tunnel not active yet, or one the
 * broker could not probe, reads Checking, never Live.
 */
export type SitePreviewShownState = "checking" | "live" | "not_responding" | "stopped";

export function sitePreviewShownState(preview: Pick<ControllerSitePreview, "status" | "health">): SitePreviewShownState {
  const state = sitePreviewRecordState(preview);
  return state === "pending" || state === "unverified" ? "checking" : state;
}

/** `fresh` asks for a new probe (a person's Reload) instead of the controller's short cache. */
export async function getSitePreview(projectId: string, previewId: string, signal?: AbortSignal, options?: { fresh?: boolean }): Promise<ControllerSitePreview> {
  const path = previewPath(projectId, previewId) + (options?.fresh ? "?fresh=1" : "");
  const preview = mapControllerSitePreview(await previewRequest(path, "GET", "Could not check the preview.", { signal }));
  if (!preview) throw new Error("The controller returned an unreadable preview.");
  return preview;
}

const VIEWER_LABEL = /^p-[a-z2-7]{26}--([0-9a-f]{32})$/;

/** Plain http is only for a local stack: loopback or a `.localhost` name. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

/**
 * A shape check on the address the controller returned, before it loads in
 * Studio's pane: the first label must be `p-<label>--<preview id as hex>` (the
 * controller names a preview's host after its tunnel, and a preview's id is
 * its tunnel's id), there must be a parent domain and no user info, and the
 * scheme must be https, or http only on a local stack. It does not pin the
 * preview domain: the controller that minted the address stays the authority
 * on where previews live.
 */
export function isSitePreviewViewerUrl(url: URL, previewId: string): boolean {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) return false;
  if (url.username || url.password || !url.pathname.startsWith("/")) return false;
  const [first, ...rest] = url.hostname.split(".");
  const previewHex = VIEWER_LABEL.exec(first ?? "")?.[1];
  return Boolean(previewHex && rest.length > 0 && previewHex === previewId.toLowerCase().replace(/-/g, ""));
}

/**
 * Mints a fresh capability for this person. The pane keeps its own alive with
 * a heartbeat. `tab` mints one for a separate browser tab, which has no
 * heartbeat: the controller marks it to be extended by its own traffic
 * instead, and it still ends at the session's maximum age.
 */
export async function createSitePreviewViewer(projectId: string, previewId: string, options: { tab?: boolean } = {}): Promise<SitePreviewViewer> {
  const value = await previewRequest(previewPath(projectId, previewId, options.tab ? "/view?tab=true" : "/view"), "POST", "Could not open the preview.", { body: {} });
  const viewerUrl = isRecord(value) ? readString(value.viewerUrl) : null;
  let parsed: URL | null = null;
  try { parsed = viewerUrl ? new URL(viewerUrl) : null; } catch { parsed = null; }
  if (!parsed || !isSitePreviewViewerUrl(parsed, previewId)) {
    throw new Error("The controller returned an unusable preview address.");
  }
  return {
    viewerUrl: parsed.toString(),
    idleTimeoutSeconds: isRecord(value) ? readNumber(value.idleTimeoutSeconds) : null,
    expiresAt: isRecord(value) ? readString(value.expiresAt) : null,
  };
}

/**
 * `keepalive` lets the request outlive the page, for a revoke sent while
 * Studio is being closed or reloaded.
 */
export async function revokeSitePreviewViewer(projectId: string, previewId: string, viewerUrl: string, options: { keepalive?: boolean } = {}): Promise<void> {
  await previewRequest(previewPath(projectId, previewId, "/view/revoke"), "POST", "Could not close the preview session.", { body: { viewerUrl }, keepalive: options.keepalive });
}

/**
 * "Still looking at it": keeps a quiet site's session from idling out while it
 * is on screen. `gone` (410) means the session is no longer live and a new one
 * is needed; any other failure is passing and is thrown.
 */
export async function heartbeatSitePreviewViewer(projectId: string, previewId: string, viewerUrl: string, signal?: AbortSignal): Promise<"live" | "gone"> {
  try {
    await previewRequest(previewPath(projectId, previewId, "/view/heartbeat"), "POST", "Could not keep the preview session.", { body: { viewerUrl }, signal });
    return "live";
  } catch (cause) {
    if (cause instanceof ControllerApiError && cause.status === 410) return "gone";
    throw cause;
  }
}

/** `live`: the site already answers. `waking`: the runtime and the site are starting; follow `wake` on the preview. */
export type SitePreviewWakeResult = { state: "live" | "waking" };

/**
 * Starts a stopped site again the way `instafy preview open` recorded it: no
 * Octo turn, no chat message. Any member who may view it may ask while its
 * machine is up; starting a stopped machine takes someone who may edit the
 * space. Asking twice is harmless.
 */
export async function wakeSitePreview(projectId: string, previewId: string, signal?: AbortSignal): Promise<SitePreviewWakeResult> {
  const value = await previewRequest(previewPath(projectId, previewId, "/wake"), "POST", "Could not start the preview.", { body: {}, signal });
  const state = isRecord(value) ? readString(value.state)?.toLowerCase() : null;
  return { state: state === "live" ? "live" : "waking" };
}
