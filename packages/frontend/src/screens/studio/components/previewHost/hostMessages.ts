/**
 * The small, versioned contract between Studio and a site shown in a preview
 * pane. It is the same for every site (a map, a shop, a dashboard): nothing
 * here knows what the site is, and a site that never answers keeps working as
 * a plain page.
 *
 * Studio → site: `{source:"instafy-host", v:1, type:"layout", …}` says what
 * Studio offers the frame: its theme, that its bar already names the site, and
 * that the site may ask Studio for the person's location (`caps.location:
 * "host"`), since the frame itself may not use the browser's geolocation.
 * Site → Studio: `{source:<the site's kit>, v:1, type, payload}`. Location has
 * its own pair in `locationBroker.ts`. Messages are data, never commands, and
 * the pane reads them only from its own frame at the viewer's origin.
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

export type HostInsets = { top: number; right: number; bottom: number; left: number };
/** Studio pads the frame itself (the pane sits above the composer), so it covers none of it. */
export const ZERO_INSETS: HostInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export type HostLayoutMessage = {
  source: typeof HOST_MESSAGE_SOURCE;
  v: typeof HOST_MESSAGE_VERSION;
  type: "layout";
  insets: HostInsets;
  chrome: "host";
  /** "shown": Studio's bar names the site, so the site may hide its own title. */
  title: "shown";
  /**
   * `geolocation`: the site may ask for the person's location. `location: "host"`: ask Studio
   * (`location-request`), not `navigator.geolocation`, which the frame is not allowed to use.
   */
  caps: { geolocation: boolean; location?: "host" };
  theme: "light" | "dark";
};

export function buildHostLayoutMessage(input: { theme: "light" | "dark"; location: boolean }): HostLayoutMessage {
  return {
    source: HOST_MESSAGE_SOURCE,
    v: HOST_MESSAGE_VERSION,
    type: "layout",
    insets: ZERO_INSETS,
    chrome: "host",
    title: "shown",
    caps: input.location ? { geolocation: true, location: "host" } : { geolocation: false },
    theme: input.theme,
  };
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A message in the site envelope (`{source:<kit>, v:1, type}`), whatever its
 * type. The caller has already checked that it came from this pane's frame at
 * the viewer's origin; this only checks the shape. Studio reads nothing else
 * from it: a site that speaks before it got the layout is sent the layout again.
 */
export function isSiteEnvelope(data: unknown): boolean {
  return isRecord(data) && isSiteMessageSource(data.source) && data.v === HOST_MESSAGE_VERSION && typeof data.type === "string";
}
