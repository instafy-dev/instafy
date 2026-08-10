export interface DesktopSpeechTunnelBridgeStatus {
  enabled: boolean;
  hostMode?: "desktop";
  state: "idle" | "starting" | "active" | "error";
  managed: boolean;
  projectId?: string;
  controllerUrl?: string;
  controllerCredentialMode?: "ambient" | "fixed";
  controllerBindingId?: string;
  tunnelId?: string;
  publicUrl?: string;
  hostname?: string | null;
  localPort: number;
  readyPath: string;
  pid?: number;
  lastCheckedAt?: string;
  lastStartedAt?: string;
  lastError?: string;
}

export interface DesktopSpeechTunnelLifecycleSummary {
  badgeLabel: string;
  badgeTone: "success" | "warning" | "neutral";
  detail: string;
  actionLabel: string;
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStatus(
  value: InstafyDesktopSpeechTunnelStatus | null | undefined,
): DesktopSpeechTunnelBridgeStatus | null {
  if (!value || typeof value.localPort !== "number" || typeof value.readyPath !== "string") {
    return null;
  }
  return {
    enabled: value.enabled === true,
    hostMode: value.hostMode,
    state: value.state,
    managed: value.managed === true,
    projectId: normalizeOptionalString(value.projectId),
    controllerUrl: normalizeOptionalString(value.controllerUrl),
    controllerCredentialMode:
      value.controllerCredentialMode === "ambient" || value.controllerCredentialMode === "fixed"
        ? value.controllerCredentialMode
        : undefined,
    controllerBindingId: normalizeOptionalString(value.controllerBindingId),
    tunnelId: normalizeOptionalString(value.tunnelId),
    publicUrl: normalizeOptionalString(value.publicUrl),
    hostname: normalizeOptionalString(value.hostname) ?? null,
    localPort: value.localPort,
    readyPath: value.readyPath,
    pid: typeof value.pid === "number" ? value.pid : undefined,
    lastCheckedAt: normalizeOptionalString(value.lastCheckedAt),
    lastStartedAt: normalizeOptionalString(value.lastStartedAt),
    lastError: normalizeOptionalString(value.lastError),
  };
}

export function desktopSpeechTunnelBridgeAvailable() {
  return typeof window !== "undefined" && typeof window.instafyDesktop?.desktopSpeechTunnelStatus === "function";
}

export async function readDesktopSpeechTunnelStatus(): Promise<DesktopSpeechTunnelBridgeStatus | null> {
  if (!desktopSpeechTunnelBridgeAvailable()) {
    return null;
  }
  return normalizeStatus(await window.instafyDesktop?.desktopSpeechTunnelStatus?.());
}

export async function startDesktopSpeechTunnel(options: {
  projectId: string;
  controllerUrl: string;
  controllerAccessToken: string;
  controllerCredentialMode?: "ambient" | "fixed";
  forceRestart?: boolean;
}): Promise<DesktopSpeechTunnelBridgeStatus | null> {
  if (typeof window === "undefined" || typeof window.instafyDesktop?.desktopSpeechTunnelStart !== "function") {
    return null;
  }
  return normalizeStatus(await window.instafyDesktop.desktopSpeechTunnelStart(options));
}

export async function stopDesktopSpeechTunnel(): Promise<DesktopSpeechTunnelBridgeStatus | null> {
  if (typeof window === "undefined" || typeof window.instafyDesktop?.desktopSpeechTunnelStop !== "function") {
    return null;
  }
  return normalizeStatus(await window.instafyDesktop.desktopSpeechTunnelStop());
}

export function describeDesktopSpeechTunnelLifecycle(
  status: DesktopSpeechTunnelBridgeStatus | null,
): DesktopSpeechTunnelLifecycleSummary | null {
  if (!status || !status.enabled) {
    return null;
  }

  if (status.state === "active" && status.publicUrl) {
    return {
      badgeLabel: "Desktop tunnel active",
      badgeTone: "success",
      detail: `This space can reach the Desktop speech host through ${status.hostname ?? status.publicUrl}. Phones and web clients should use this tunnel route.`,
      actionLabel: "Refresh Desktop tunnel",
    };
  }

  if (status.state === "starting") {
    return {
      badgeLabel: "Desktop tunnel starting",
      badgeTone: "warning",
      detail: "Instafy Desktop is opening a speech tunnel for this space. Other devices can use it when the tunnel becomes ready.",
      actionLabel: "Refresh Desktop tunnel",
    };
  }

  if (status.state === "error") {
    return {
      badgeLabel: "Desktop tunnel unavailable",
      badgeTone: "warning",
      detail:
        status.lastError ??
        "Instafy Desktop could not expose the local speech host for this space yet.",
      actionLabel: "Retry Desktop tunnel",
    };
  }

  return {
    badgeLabel: "Desktop tunnel inactive",
    badgeTone: "neutral",
    detail:
      "Instafy Desktop will automatically expose the local speech host for the active space when the Desktop host is ready. Use refresh only if you need to retry it now.",
    actionLabel: "Refresh Desktop tunnel",
  };
}
