/**
 * The small, versioned contract between Studio and a site shown in a preview
 * pane. It is the same for every site (a map, a shop, a dashboard): nothing
 * here knows what the site is, and a site that never answers keeps working as
 * a plain page.
 *
 * Studio → site: `{source:"instafy-host", v:1, type:"layout", caps, theme}`
 * says what Studio offers the frame: its theme, and that the site may ask
 * Studio for the person's location (`caps.location: "host"`), since the frame
 * itself may not use the browser's geolocation.
 * Site → Studio: `{source:<the site's kit>, v:1, type, payload}`. Location has
 * its own pair in `locationBroker.ts`; follow mode reads `layout-ack` (what the
 * site supports), `view`, `tap` and `interact`. Messages are data, never
 * commands, and the pane reads them only from its own frame at the viewer's
 * origin.
 */

export const HOST_MESSAGE_SOURCE = "instafy-host";
export const HOST_MESSAGE_VERSION = 1;

/**
 * Read by sites at boot so they can wait for the host's layout before asking
 * for location. Host-neutral on purpose: Studio frames any site.
 */
export const HOST_QUERY_PARAM = "instafy_host";
export const HOST_QUERY_VALUE = "studio";

/**
 * Any site kit names itself in `source` (a short lowercase name). The name is
 * not trusted for anything: the frame and origin checks are what count, so no
 * kit is listed here, only Studio's own name is refused.
 */
export function isSiteMessageSource(value: unknown): value is string {
  return typeof value === "string" && value !== HOST_MESSAGE_SOURCE && /^[a-z][a-z0-9-]{0,39}$/.test(value);
}

export type HostLayoutMessage = {
  source: typeof HOST_MESSAGE_SOURCE;
  v: typeof HOST_MESSAGE_VERSION;
  type: "layout";
  /**
   * `location: "host"`: the person's location is available through Studio
   * (`location-request`), never through `navigator.geolocation`, which the
   * frame is not allowed to use.
   */
  caps: { location: "host" };
  /** Studio's theme, so a site can match it. */
  theme: "light" | "dark";
};

export function buildHostLayoutMessage(theme: "light" | "dark"): HostLayoutMessage {
  return { source: HOST_MESSAGE_SOURCE, v: HOST_MESSAGE_VERSION, type: "layout", caps: { location: "host" }, theme };
}

/**
 * The iframe's address: the minted capability URL plus `?instafy_host=studio`.
 * The controller mints the URL and only reads the host when it revokes, so the
 * query is added here, on the frame's `src` only.
 */
export function withHostQuery(viewerUrl: string): string {
  try {
    const url = new URL(viewerUrl);
    url.searchParams.set(HOST_QUERY_PARAM, HOST_QUERY_VALUE);
    return url.toString();
  } catch {
    return viewerUrl;
  }
}

export function currentStudioTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  const root = document.documentElement;
  if (root.classList.contains("dark") || root.dataset.theme === "dark") return "dark";
  return "light";
}

// ---------------------------------------------------------------------------
// Site → Studio

export type SiteEvent =
  /** What the site supports, e.g. "view" and "tap" for follow mode. */
  | { type: "layout-ack"; supports: string[] }
  /**
   * Follow mode (docs/Follow-Mode.md). `view` is opaque JSON describing what is
   * visible, sent only while Studio told the site it presents; `tap` is where
   * the presenter tapped; `interact` is the person's own gesture on the site.
   * Studio checks size and shape in followMode.ts and never runs them.
   */
  | { type: "view"; seq: number | null; payload: unknown }
  | { type: "tap"; seq: number | null; payload: unknown }
  | { type: "interact" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAX_SUPPORTS = 16;

/** What a site says it can do (`layout-ack` `supports`): short lowercase names, at most 16. */
function readSupports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.filter((item): item is string => typeof item === "string" && /^[a-z][a-z0-9-]{0,23}$/.test(item));
  return [...new Set(names)].slice(0, MAX_SUPPORTS);
}

/**
 * Reads one site message. The caller has already checked that it came from
 * this pane's frame at the viewer's origin; this only checks its shape.
 * Unknown types and anything malformed return null.
 */
export function parseSiteMessage(data: unknown): SiteEvent | null {
  if (!isRecord(data) || !isSiteMessageSource(data.source)) return null;
  if (data.v !== HOST_MESSAGE_VERSION || typeof data.type !== "string") return null;
  const payload = isRecord(data.payload) ? data.payload : {};
  switch (data.type) {
    case "layout-ack":
      return { type: "layout-ack", supports: readSupports(payload.supports) };
    case "view":
    case "tap": {
      // The payload stays as the site sent it (opaque); followMode.ts drops anything that is not small plain JSON.
      if (!("payload" in data) || data.payload === undefined) return null;
      const seq = typeof data.seq === "number" && Number.isFinite(data.seq) ? data.seq : null;
      return { type: data.type, seq, payload: data.payload };
    }
    case "interact":
      return { type: "interact" };
    default:
      return null;
  }
}

/**
 * A message in the site envelope (`{source:<kit>, v:1, type}`), whatever its
 * type. The caller has already checked that it came from this pane's frame at
 * the viewer's origin; this only checks the shape. Studio reads nothing else
 * from it: a site that speaks before it got the layout is sent the layout again.
 */
export function isSiteEnvelope(data: unknown): boolean {
  return isRecord(data) && isSiteMessageSource(data.source) && data.v === HOST_MESSAGE_VERSION && typeof data.type === "string";
}
