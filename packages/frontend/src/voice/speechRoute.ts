export type SpeechRouteHostMode = "desktop" | "cli" | "server";

export type SpeechRouteSource = "project" | "env" | "desktop_lan_discovery";

export type SpeechRoute = {
  baseUrl: string;
  authToken: string | null;
  connectionType: string | null;
  hostMode: SpeechRouteHostMode | null;
  updatedAt: string | null;
  source: SpeechRouteSource;
};

export type SpeechRouteTransport =
  | "desktop_lan"
  | "desktop_tunnel"
  | "server"
  | "direct"
  | "unknown";

type ReachableSpeechRouteOptions = {
  fetchImpl?: typeof fetch;
  probeImpl?: (route: SpeechRoute) => Promise<boolean | null | undefined> | boolean | null | undefined;
  timeoutMs?: number;
  fallbackToPreferred?: boolean;
};

type SpeechRouteEnv = Partial<
  Pick<ImportMetaEnv, "VITE_INSTAFY_SPEECH_BASE_URL" | "VITE_INSTAFY_SPEECH_TOKEN">
>;

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function normalizeSpeechRouteString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeSpeechRouteBaseUrl(value: unknown) {
  const trimmed = normalizeSpeechRouteString(value);
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

export function normalizeSpeechRouteHostMode(value: unknown): SpeechRouteHostMode | null {
  return value === "desktop" || value === "cli" || value === "server" ? value : null;
}

export function normalizeSpeechRouteConnectionType(value: unknown) {
  const normalized = normalizeSpeechRouteString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function createSpeechRoute(input: {
  baseUrl: unknown;
  authToken?: unknown;
  connectionType?: unknown;
  hostMode?: unknown;
  updatedAt?: unknown;
  source: SpeechRouteSource;
}): SpeechRoute | null {
  const baseUrl = normalizeSpeechRouteBaseUrl(input.baseUrl);
  if (!baseUrl) {
    return null;
  }
  return {
    baseUrl,
    authToken: normalizeSpeechRouteString(input.authToken),
    connectionType: normalizeSpeechRouteConnectionType(input.connectionType),
    hostMode: normalizeSpeechRouteHostMode(input.hostMode),
    updatedAt: normalizeSpeechRouteString(input.updatedAt),
    source: input.source,
  };
}

export function inferSpeechRouteConnectionTypeFromBaseUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    return isLoopbackHostname(parsed.hostname) ? "local" : "direct";
  } catch {
    return null;
  }
}

export function createEnvSpeechRoute(env: SpeechRouteEnv = import.meta.env): SpeechRoute | null {
  const baseUrl = normalizeSpeechRouteBaseUrl(env.VITE_INSTAFY_SPEECH_BASE_URL);
  if (!baseUrl) {
    return null;
  }
  return createSpeechRoute({
    baseUrl,
    authToken: env.VITE_INSTAFY_SPEECH_TOKEN,
    connectionType: inferSpeechRouteConnectionTypeFromBaseUrl(baseUrl),
    source: "env",
  });
}

export function describeSpeechRouteTransport(route: SpeechRoute): SpeechRouteTransport {
  const connectionType = normalizeSpeechRouteConnectionType(route.connectionType);
  if (route.hostMode === "desktop" && connectionType === "lan") {
    return "desktop_lan";
  }
  if (route.hostMode === "desktop" && connectionType === "tunnel") {
    return "desktop_tunnel";
  }
  if (route.hostMode === "server") {
    return "server";
  }
  if (connectionType === "local" || connectionType === "lan" || connectionType === "direct") {
    return "direct";
  }
  return "unknown";
}

function getSpeechRouteSourcePriority(route: SpeechRoute) {
  switch (route.source) {
    case "desktop_lan_discovery":
      return 300;
    case "project":
      return 200;
    case "env":
      return 100;
    default:
      return 0;
  }
}

function getSpeechRouteTransportPriority(route: SpeechRoute) {
  switch (describeSpeechRouteTransport(route)) {
    case "desktop_lan":
      return 50;
    case "desktop_tunnel":
      return 40;
    case "server":
      return 30;
    case "direct":
      return 20;
    case "unknown":
    default:
      return 10;
  }
}

function getSpeechRouteUpdatedAtPriority(route: SpeechRoute) {
  if (!route.updatedAt) {
    return 0;
  }
  const timestamp = Date.parse(route.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getSpeechRoutePriority(route: SpeechRoute) {
  return (
    getSpeechRouteSourcePriority(route) * 1_000_000_000_000 +
    getSpeechRouteTransportPriority(route) * 1_000_000_000 +
    getSpeechRouteUpdatedAtPriority(route)
  );
}

export function selectPreferredSpeechRoute(routes: Array<SpeechRoute | null | undefined>): SpeechRoute | null {
  const candidates = routes.filter((route): route is SpeechRoute => Boolean(route?.baseUrl));
  if (!candidates.length) {
    return null;
  }
  return [...candidates].sort((left, right) => getSpeechRoutePriority(right) - getSpeechRoutePriority(left))[0] ?? null;
}

export function buildSpeechRouteHealthUrl(route: SpeechRoute | null | undefined) {
  if (!route?.baseUrl) {
    return null;
  }
  return `${route.baseUrl.replace(/\/+$/, "")}/health`;
}

async function probeSpeechRoute(route: SpeechRoute, options: ReachableSpeechRouteOptions = {}) {
  const preferredProbe = await options.probeImpl?.(route);
  if (typeof preferredProbe === "boolean") {
    return preferredProbe;
  }
  const healthUrl = buildSpeechRouteHealthUrl(route);
  if (!healthUrl) {
    return false;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1_500;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout =
    controller && timeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;
  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET",
      headers: {
        "cache-control": "no-store",
      },
      signal: controller?.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function selectReachableSpeechRoute(
  routes: Array<SpeechRoute | null | undefined>,
  options: ReachableSpeechRouteOptions = {},
): Promise<SpeechRoute | null> {
  const candidates = routes.filter((route): route is SpeechRoute => Boolean(route?.baseUrl));
  if (!candidates.length) {
    return null;
  }
  const sorted = [...candidates].sort((left, right) => getSpeechRoutePriority(right) - getSpeechRoutePriority(left));
  for (const candidate of sorted) {
    if (await probeSpeechRoute(candidate, options)) {
      return candidate;
    }
  }
  if (options.fallbackToPreferred === false) {
    return null;
  }
  return sorted[0] ?? null;
}

export function isSameSpeechRoute(
  route: SpeechRoute | null | undefined,
  expected: {
    baseUrl: string;
    hostMode?: SpeechRouteHostMode | null;
    connectionType?: string | null;
  },
) {
  if (!route) {
    return false;
  }
  const expectedBaseUrl = normalizeSpeechRouteBaseUrl(expected.baseUrl);
  if (!expectedBaseUrl || route.baseUrl !== expectedBaseUrl) {
    return false;
  }
  if (expected.hostMode !== undefined && route.hostMode !== expected.hostMode) {
    return false;
  }
  if (
    expected.connectionType !== undefined &&
    route.connectionType !== normalizeSpeechRouteConnectionType(expected.connectionType)
  ) {
    return false;
  }
  return true;
}

export function toSpeechRouteOverride(route: SpeechRoute | null | undefined) {
  if (!route) {
    return undefined;
  }
  return {
    baseUrl: route.baseUrl,
    authToken: route.authToken,
  };
}
