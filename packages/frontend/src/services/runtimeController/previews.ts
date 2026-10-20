import {
  ControllerApiError,
  readControllerApiError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

/** The broker's probe of the site behind a preview. `status` is the HTTP status it answered with, when it did. */
export type SitePreviewHealth = { listening: boolean; status: number | null };

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
};

/** A member-only capability address. Keep it in memory only: never store, log or show it. */
export type SitePreviewViewer = {
  viewerUrl: string;
  idleTimeoutSeconds: number | null;
  expiresAt: string | null;
};

/** What the record alone says about the site. */
export type SitePreviewRecordState = "live" | "not_responding" | "stopped";

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
 * - `unavailable`: this server does not offer previews (503 `previews_unavailable`, or no preview routes);
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

export function isSitePreviewsUnavailable(cause: unknown): boolean {
  return sitePreviewProblem(cause) === "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const readString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const readNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

function previewPath(projectId: string, previewId: string, suffix = "") {
  return `/projects/${encodeURIComponent(projectId)}/previews/${encodeURIComponent(previewId)}${suffix}`;
}

async function previewRequest(path: string, method: "GET" | "POST", fallback: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!runtimeControllerEnabled) throw new Error("Runtime controller is not configured.");
  const context = await resolveControllerRequestContext(null);
  if (!context.baseUrl || !context.accessToken) {
    throw new ControllerApiError({ status: 401, message: "Missing controller session token.", code: null, details: null });
  }
  const headers: Record<string, string> = { authorization: `Bearer ${context.accessToken}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${context.baseUrl}${path}`, {
    method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body),
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
  };
}

/**
 * Only the controller's record decides: an ended tunnel is stopped, a probe that
 * found nothing listening (or the broker's 502 to 504) is not responding, and
 * anything else is live. No health means the broker could not be asked, not
 * that the site is down.
 */
export function sitePreviewRecordState(preview: Pick<ControllerSitePreview, "status" | "health">): SitePreviewRecordState {
  if (ENDED_PREVIEW_STATUSES.has(preview.status)) return "stopped";
  const health = preview.health;
  if (health && (!health.listening || (health.status !== null && health.status >= 502 && health.status <= 504))) return "not_responding";
  return "live";
}

/** `fresh` asks for a new probe (a person's Reload) instead of the controller's short cache. */
export async function getSitePreview(projectId: string, previewId: string, signal?: AbortSignal, options?: { fresh?: boolean }): Promise<ControllerSitePreview> {
  const path = previewPath(projectId, previewId) + (options?.fresh ? "?fresh=1" : "");
  const preview = mapControllerSitePreview(await previewRequest(path, "GET", "Could not check the preview.", undefined, signal));
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
  const value = await previewRequest(previewPath(projectId, previewId, options.tab ? "/view?tab=true" : "/view"), "POST", "Could not open the preview.", {});
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

export async function revokeSitePreviewViewer(projectId: string, previewId: string, viewerUrl: string): Promise<void> {
  await previewRequest(previewPath(projectId, previewId, "/view/revoke"), "POST", "Could not close the preview session.", { viewerUrl });
}

/**
 * "Still looking at it": keeps a quiet site's session from idling out while it
 * is on screen. `gone` (410) means the session is no longer live and a new one
 * is needed; any other failure is passing and is thrown.
 */
export async function heartbeatSitePreviewViewer(projectId: string, previewId: string, viewerUrl: string, signal?: AbortSignal): Promise<"live" | "gone"> {
  try {
    await previewRequest(previewPath(projectId, previewId, "/view/heartbeat"), "POST", "Could not keep the preview session.", { viewerUrl }, signal);
    return "live";
  } catch (cause) {
    if (cause instanceof ControllerApiError && cause.status === 410) return "gone";
    throw cause;
  }
}
