export type BrowserOriginSocketPath = "vnc" | "screencast" | "input" | "collaboration";
export type BrowserOriginHttpPath = "webrtc/offer";

/**
 * Local development hosts whose Shared Browser traffic goes through the
 * controller. Public tunnel hosts need no list here: the controller's origin
 * access-token response already returns its own `/origin/<id>` endpoint for
 * them, from its `TUNNEL_DOMAIN` setting, so that setting is the only one.
 */
function isLocalOriginHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "rt.test" ||
    normalized.endsWith(".rt.test") ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "host.docker.internal"
  );
}

function controllerOriginUrl(
  endpoint: URL,
  originId: string | null | undefined,
  controllerBaseUrl: string | null | undefined,
  browserPath: string,
): URL | null {
  const id = originId?.trim() ?? "";
  if (!id || !controllerBaseUrl || !isLocalOriginHost(endpoint.hostname)) {
    return null;
  }
  const url = new URL(controllerBaseUrl);
  url.pathname = `/origin/${encodeURIComponent(id)}/browser/${browserPath}`;
  url.search = "";
  return url;
}

function endpointBrowserUrl(endpoint: URL, browserPath: string): URL {
  const url = new URL(endpoint);
  // Preserve any origin proxy prefix (e.g. controller endpoints like /origin/<id>).
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/browser/${browserPath}`;
  url.search = "";
  return url;
}

export function buildBrowserOriginWebSocketUrl(params: {
  endpoint: string;
  token: string;
  browserPath: BrowserOriginSocketPath;
  originId?: string | null;
  pageId?: string | null;
  controllerBaseUrl?: string | null;
}): string {
  const endpoint = new URL(params.endpoint);
  const url =
    controllerOriginUrl(endpoint, params.originId, params.controllerBaseUrl, params.browserPath) ??
    endpointBrowserUrl(endpoint, params.browserPath);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", params.token);
  if (params.pageId?.trim()) {
    url.searchParams.set("pageId", params.pageId.trim());
  }
  return url.toString();
}

export function buildBrowserOriginHttpUrl(params: {
  endpoint: string;
  browserPath: BrowserOriginHttpPath;
  originId?: string | null;
  controllerBaseUrl?: string | null;
}): string {
  const endpoint = new URL(params.endpoint);
  const url =
    controllerOriginUrl(endpoint, params.originId, params.controllerBaseUrl, params.browserPath) ??
    endpointBrowserUrl(endpoint, params.browserPath);
  return url.toString();
}
