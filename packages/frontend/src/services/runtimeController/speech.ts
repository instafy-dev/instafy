import {
  controllerBaseUrl,
  normalizeUuidParam,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

export const CONTROLLER_SPEECH_PROXY_UPSTREAM_AUTH_HEADER =
  "x-instafy-upstream-authorization";

const LOCAL_TUNNEL_DOMAIN_SUFFIX = ".rt.test";
const PROXIED_SPEECH_ENDPOINTS = new Set(["health", "transcribe", "synthesize"]);

function trimUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function splitSpeechProxyTarget(rawUrl: string): {
  proxyBaseUrl: string;
  proxyPath: string;
  query: string;
} | null {
  const trimmed = trimUrl(rawUrl);
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const pathnameSegments = parsed.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const lastSegment = pathnameSegments[pathnameSegments.length - 1] ?? "";
    const proxyPath = PROXIED_SPEECH_ENDPOINTS.has(lastSegment) ? lastSegment : "";
    const baseSegments = proxyPath ? pathnameSegments.slice(0, -1) : pathnameSegments;
    parsed.pathname = baseSegments.length > 0 ? `/${baseSegments.join("/")}` : "/";
    const query = parsed.search;
    parsed.search = "";
    parsed.hash = "";
    return {
      proxyBaseUrl: trimUrl(parsed.toString()),
      proxyPath,
      query,
    };
  } catch {
    return null;
  }
}

function isLocalTunnelSpeechHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized === "rt.test" || normalized.endsWith(LOCAL_TUNNEL_DOMAIN_SUFFIX)
  );
}

export function shouldUseControllerSpeechProxy(baseUrl: string): boolean {
  if (!runtimeControllerEnabled) {
    return false;
  }
  const target = splitSpeechProxyTarget(baseUrl);
  if (!target) {
    return false;
  }
  try {
    return isLocalTunnelSpeechHost(new URL(target.proxyBaseUrl).hostname);
  } catch {
    return false;
  }
}

export function buildControllerSpeechProxyBaseUrl(params: {
  projectId: string | null | undefined;
  baseUrl: string;
  controllerUrl?: string | null;
}): string | null {
  const projectId = normalizeUuidParam(params.projectId);
  if (!projectId || !shouldUseControllerSpeechProxy(params.baseUrl)) {
    return null;
  }
  const controllerBase = (params.controllerUrl ?? controllerBaseUrl)
    .trim()
    .replace(/\/+$/, "");
  if (!controllerBase) {
    return null;
  }
  const target = splitSpeechProxyTarget(params.baseUrl);
  if (!target) {
    return null;
  }
  const encodedBase = encodeURIComponent(target.proxyBaseUrl);
  const proxiedBaseUrl = `${controllerBase}/projects/${encodeURIComponent(
    projectId,
  )}/speech/proxy/${encodedBase}`;
  const proxyPath = target.proxyPath ? `/${target.proxyPath}` : "";
  return `${proxiedBaseUrl}${proxyPath}${target.query}`;
}

export async function resolveControllerSpeechProxyRequest(params: {
  projectId: string | null | undefined;
  baseUrl: string;
  accessToken?: string | null;
  upstreamAuthToken?: string | null;
}): Promise<{
  baseUrl: string;
  headers: HeadersInit;
} | null> {
  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  if (!requestContext.accessToken) {
    return null;
  }
  const proxiedBaseUrl = buildControllerSpeechProxyBaseUrl({
    ...params,
    controllerUrl: requestContext.baseUrl,
  });
  if (!proxiedBaseUrl) {
    return null;
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${requestContext.accessToken}`,
  };
  const upstreamAuthToken =
    typeof params.upstreamAuthToken === "string"
      ? params.upstreamAuthToken.trim()
      : "";
  if (upstreamAuthToken) {
    headers[CONTROLLER_SPEECH_PROXY_UPSTREAM_AUTH_HEADER] =
      `Bearer ${upstreamAuthToken}`;
  }
  return {
    baseUrl: proxiedBaseUrl,
    headers,
  };
}
