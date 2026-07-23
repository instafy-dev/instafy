import {
  ensureNativeLanDiscoveryStarted,
  listenForNativeLanDiscovery,
  readNativeLanDiscoveryStatus,
  type NativeLanDiscoverySnapshot,
  type NativeLanDiscoveryService,
} from "../native/nativeLanDiscoveryBridge";
import type { ProjectSpeechRoute } from "./projectSpeechRoute";
import {
  createSpeechRoute,
  describeSpeechRouteTransport,
  type SpeechRoute,
} from "./speechRoute";

type DesktopLanDiscoverySnapshotListener = (snapshot: NativeLanDiscoverySnapshot | null) => void;
const DESKTOP_LAN_DISCOVERY_UI_TEST_HOST_QUERY_PARAM = "uiTestHostedVoiceHost";
const DESKTOP_LAN_DISCOVERY_UI_TEST_TOKEN_QUERY_PARAM = "uiTestHostedVoiceAuthToken";

let latestDiscoverySnapshot: NativeLanDiscoverySnapshot | null = null;
let discoveryBridgeReadyPromise: Promise<void> | null = null;
const discoverySnapshotListeners = new Set<DesktopLanDiscoverySnapshotListener>();

export function describeDesktopLanTokenHint(token: string | null | undefined) {
  if (typeof token !== "string" || token.length < 8) {
    return null;
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function publishDiscoverySnapshot(snapshot: NativeLanDiscoverySnapshot | null) {
  latestDiscoverySnapshot = snapshot;
  for (const listener of discoverySnapshotListeners) {
    listener(snapshot);
  }
}

async function refreshDiscoverySnapshot() {
  const snapshot = await readNativeLanDiscoveryStatus().catch(() => null);
  if (snapshot) {
    publishDiscoverySnapshot(snapshot);
  }
  return snapshot;
}

async function ensureDesktopLanDiscoveryBridgeReady() {
  if (!discoveryBridgeReadyPromise) {
    discoveryBridgeReadyPromise = (async () => {
      await listenForNativeLanDiscovery((snapshot) => {
        publishDiscoverySnapshot(snapshot);
      }).catch(() => null);

      const startedSnapshot = await ensureNativeLanDiscoveryStarted().catch(() => null);
      if (startedSnapshot) {
        publishDiscoverySnapshot(startedSnapshot);
        return;
      }
      await refreshDiscoverySnapshot();
    })();
  }
  await discoveryBridgeReadyPromise.catch(() => undefined);
}

export async function readDesktopLanDiscoverySnapshot() {
  await ensureDesktopLanDiscoveryBridgeReady();
  if (latestDiscoverySnapshot) {
    return latestDiscoverySnapshot;
  }
  return await refreshDiscoverySnapshot();
}

export function subscribeDesktopLanDiscoverySnapshots(
  listener: DesktopLanDiscoverySnapshotListener,
) {
  discoverySnapshotListeners.add(listener);
  listener(latestDiscoverySnapshot);
  void ensureDesktopLanDiscoveryBridgeReady();
  return () => {
    discoverySnapshotListeners.delete(listener);
  };
}

async function waitForDiscoverySnapshot(timeoutMs = 5_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await readDesktopLanDiscoverySnapshot().catch(() => null);
  if (snapshot?.clientReachability === "loopback" && (snapshot.services?.length ?? 0) === 0) {
    return snapshot;
  }
  while (
    snapshot &&
    snapshot.state === "scanning" &&
    (snapshot.services?.length ?? 0) === 0 &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    snapshot = await refreshDiscoverySnapshot();
  }
  return snapshot;
}

function dedupeSpeechRoutes(routes: SpeechRoute[]) {
  const seen = new Set<string>();
  const result: SpeechRoute[] = [];
  for (const route of routes) {
    const key = [route.baseUrl, route.authToken ?? "", route.connectionType ?? "", route.hostMode ?? ""].join("::");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(route);
  }
  return result;
}

function rewriteSpeechRouteHost(route: ProjectSpeechRoute, hostname: string, updatedAt: string | null) {
  try {
    const parsed = new URL(route.baseUrl);
    parsed.hostname = hostname;
    return createSpeechRoute({
      baseUrl: parsed.toString().replace(/\/+$/, ""),
      authToken: route.authToken,
      connectionType: "lan",
      hostMode: "desktop",
      updatedAt: updatedAt ?? route.updatedAt,
      source: "desktop_lan_discovery",
    });
  } catch {
    return null;
  }
}

function readDesktopLanDiscoveryUiTestFallbackRoute() {
  if (typeof window === "undefined") {
    return {
      host: null,
      authToken: null,
    };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const rawHostValue = params.get(DESKTOP_LAN_DISCOVERY_UI_TEST_HOST_QUERY_PARAM);
    const rawTokenValue = params.get(DESKTOP_LAN_DISCOVERY_UI_TEST_TOKEN_QUERY_PARAM);
    return {
      host:
        typeof rawHostValue === "string" && rawHostValue.trim().length > 0
          ? rawHostValue.trim()
          : null,
      authToken:
        typeof rawTokenValue === "string" && rawTokenValue.trim().length > 0
          ? rawTokenValue.trim()
          : null,
    };
  } catch {
    return {
      host: null,
      authToken: null,
    };
  }
}

export function deriveDiscoveredDesktopLanSpeechRoutes(
  projectRoutes: ProjectSpeechRoute[],
  services: NativeLanDiscoveryService[],
  snapshot?: Pick<NativeLanDiscoverySnapshot, "clientReachability" | "updatedAt"> | null,
  fallbackHostOverride?: string | null,
  fallbackAuthTokenOverride?: string | null,
): SpeechRoute[] {
  const desktopLanRoutes = projectRoutes.filter(
    (route) => describeSpeechRouteTransport(route) === "desktop_lan" && Boolean(route.authToken),
  );
  const normalizedFallbackHostOverride = fallbackHostOverride?.trim() || null;
  const normalizedFallbackAuthTokenOverride = fallbackAuthTokenOverride?.trim() || null;
  const directFallbackRoute =
    normalizedFallbackHostOverride && normalizedFallbackAuthTokenOverride
      ? createSpeechRoute({
      baseUrl: `http://${normalizedFallbackHostOverride}`,
      authToken: normalizedFallbackAuthTokenOverride,
      connectionType: "lan",
      hostMode: "desktop",
      updatedAt: snapshot?.updatedAt ?? null,
      source: "desktop_lan_discovery",
        })
      : null;
  if (!desktopLanRoutes.length && directFallbackRoute) {
    return [directFallbackRoute];
  }
  if (!desktopLanRoutes.length || !services.length) {
    const canUseLoopbackFallback =
      desktopLanRoutes.length === 1 &&
      (snapshot?.clientReachability === "loopback" || Boolean(normalizedFallbackHostOverride));
    if (!canUseLoopbackFallback) {
      return directFallbackRoute ? [directFallbackRoute] : [];
    }
    const loopbackRoute = rewriteSpeechRouteHost(
      desktopLanRoutes[0],
      normalizedFallbackHostOverride || "127.0.0.1",
      snapshot?.updatedAt ?? null,
    );
    return dedupeSpeechRoutes([directFallbackRoute, loopbackRoute].filter((route): route is SpeechRoute => Boolean(route)));
  }

  const routes: SpeechRoute[] = [];
  for (const service of services) {
    if (!service.baseUrl || !service.authRequired || !service.tokenHint || service.hostMode !== "desktop") {
      continue;
    }
    const matchingProjectRoute = desktopLanRoutes.find(
      (route) => describeDesktopLanTokenHint(route.authToken) === service.tokenHint,
    );
    if (!matchingProjectRoute) {
      continue;
    }
    const discoveredRoute = createSpeechRoute({
      baseUrl: service.baseUrl,
      authToken: matchingProjectRoute.authToken,
      connectionType: "lan",
      hostMode: "desktop",
      updatedAt: service.updatedAt ?? matchingProjectRoute.updatedAt,
      source: "desktop_lan_discovery",
    });
    if (discoveredRoute) {
      routes.push(discoveredRoute);
    }
  }
  if (directFallbackRoute) {
    routes.push(directFallbackRoute);
  }

  return dedupeSpeechRoutes(routes);
}

export async function readDiscoveredDesktopLanSpeechRoutes(
  projectRoutes: ProjectSpeechRoute[],
): Promise<SpeechRoute[]> {
  const uiTestFallbackRoute = readDesktopLanDiscoveryUiTestFallbackRoute();
  if (!projectRoutes.length && !(uiTestFallbackRoute.host && uiTestFallbackRoute.authToken)) {
    return [];
  }
  await ensureDesktopLanDiscoveryBridgeReady();
  const snapshot = await waitForDiscoverySnapshot();
  return deriveDiscoveredDesktopLanSpeechRoutes(
    projectRoutes,
    snapshot?.services ?? [],
    snapshot,
    uiTestFallbackRoute.host,
    uiTestFallbackRoute.authToken,
  );
}
