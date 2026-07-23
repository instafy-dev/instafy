import type { RuntimeBrowserSessionCapabilities } from "../../../sdk/instafy";

export type SupportedSharedBrowserViewerKind = "webrtc" | "cdp-screencast" | "rfb";

const SUPPORTED_VIEWERS: ReadonlySet<SupportedSharedBrowserViewerKind> = new Set([
  "webrtc",
  "cdp-screencast",
  "rfb",
]);

const SHARED_BROWSER_GRANT_REFRESH_BUFFER_MS = 30_000;
// The loopback WebRTC sender independently caps peers at ten minutes. Rotate
// every browser grant before that ceiling as well as before its signed expiry,
// so long-lived controller token configurations cannot strand the video peer.
export const SHARED_BROWSER_GRANT_MAX_REFRESH_INTERVAL_MS = 8 * 60 * 1_000;

export function sharedBrowserGrantRefreshDelayMs(
  expiresAtMs: number,
  nowMs = Date.now(),
): number {
  const beforeSignedExpiry = Math.max(
    1_000,
    expiresAtMs - nowMs - SHARED_BROWSER_GRANT_REFRESH_BUFFER_MS,
  );
  return Math.min(
    SHARED_BROWSER_GRANT_MAX_REFRESH_INTERVAL_MS,
    beforeSignedExpiry,
  );
}

/**
 * Negotiate the renderer independently from the Personal/Shared identity choice.
 * Prefer the runtime's viewer when this client implements it. The order follows
 * perceived latency: WebRTC video, CDP screencast, then the always-present RFB
 * safety lane.
 */
export function resolveSharedBrowserViewerKind(
  capabilities: RuntimeBrowserSessionCapabilities | null,
  capabilitiesUnsupported = false,
  preferViewportAdaptive = false,
): SupportedSharedBrowserViewerKind | null {
  if (capabilitiesUnsupported) {
    return null;
  }
  // A runtime without a capability response can still expose the RFB safety lane.
  if (!capabilities) {
    return "rfb";
  }
  if (
    preferViewportAdaptive &&
    capabilities.viewerKinds.includes("cdp-screencast")
  ) {
    return "cdp-screencast";
  }
  const preferred = capabilities.preferredViewer;
  if (
    SUPPORTED_VIEWERS.has(preferred as SupportedSharedBrowserViewerKind) &&
    capabilities.viewerKinds.includes(preferred)
  ) {
    return preferred as SupportedSharedBrowserViewerKind;
  }

  for (const viewer of ["webrtc", "cdp-screencast", "rfb"] as const) {
    if (capabilities.viewerKinds.includes(viewer)) {
      return viewer;
    }
  }
  return null;
}

export function resolveSharedBrowserFallbackViewerKind(
  current: SupportedSharedBrowserViewerKind,
  available: readonly SupportedSharedBrowserViewerKind[],
): SupportedSharedBrowserViewerKind | null {
  const fallbackOrder: readonly SupportedSharedBrowserViewerKind[] = [
    "webrtc",
    "cdp-screencast",
    "rfb",
  ];
  const currentIndex = fallbackOrder.indexOf(current);
  if (currentIndex < 0) {
    return null;
  }
  return (
    fallbackOrder
      .slice(currentIndex + 1)
      .find((viewer) => available.includes(viewer)) ?? null
  );
}

/**
 * RFB is a combined pixel-and-input socket, so the origin only admits the
 * current human controller. Spectators must use an independently view-only
 * renderer; selecting RFB for them would leave a mounted but blank surface.
 */
export function resolveSharedBrowserViewerForParticipant(params: {
  requested: SupportedSharedBrowserViewerKind | null;
  available: readonly SupportedSharedBrowserViewerKind[];
  humanOwnsControl: boolean;
}): SupportedSharedBrowserViewerKind | null {
  if (!params.requested) {
    return null;
  }
  if (params.requested !== "rfb" || params.humanOwnsControl) {
    return params.requested;
  }
  return params.available.find((viewer) => viewer !== "rfb") ?? null;
}

export function webRtcInputTargetsActivePage(
  connectionPageId: string | null,
  activePageId: string | null,
): boolean {
  return Boolean(
    connectionPageId && activePageId && connectionPageId === activePageId,
  );
}
