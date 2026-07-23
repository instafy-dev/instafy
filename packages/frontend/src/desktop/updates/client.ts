import type { DesktopUpdateEvent, DesktopUpdateEventType, DesktopUpdatePhase } from "@instafy/ota-contracts";
import { instafyBuildInfo } from "../../config/buildInfo";
import { controllerBaseUrl, readControllerError } from "../../sdk/instafy";

export interface DesktopUpdaterBridgeStatus {
  isEnabled: boolean;
  channel: string;
  currentVersion: string;
  feedUrl: string;
  phase: DesktopUpdatePhase;
  availableVersion?: string;
  lastCheckedAt?: string;
  lastDownloadedAt?: string;
  lastError?: string;
}

function browserPlatform(): string | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const navigatorWithUAData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
      architecture?: string;
    };
  };
  return (
    navigatorWithUAData.userAgentData?.platform?.trim() ||
    navigator.platform?.trim() ||
    null
  );
}

function browserArch(): string | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const navigatorWithUAData = navigator as Navigator & {
    userAgentData?: {
      architecture?: string;
    };
  };
  return navigatorWithUAData.userAgentData?.architecture?.trim() || null;
}

export function desktopUpdaterBridgeAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.instafyDesktop?.desktopUpdaterStatus === "function";
}

function normalizeDesktopUpdaterStatus(status: InstafyDesktopUpdaterStatus): DesktopUpdaterBridgeStatus | null {
  if (!status.channel?.trim() || !status.currentVersion?.trim() || !status.feedUrl?.trim()) {
    return null;
  }
  return {
    isEnabled: Boolean(status.isEnabled),
    channel: status.channel.trim(),
    currentVersion: status.currentVersion.trim(),
    feedUrl: status.feedUrl.trim(),
    phase: status.phase,
    availableVersion: status.availableVersion?.trim() || undefined,
    lastCheckedAt: status.lastCheckedAt?.trim() || undefined,
    lastDownloadedAt: status.lastDownloadedAt?.trim() || undefined,
    lastError: status.lastError?.trim() || undefined,
  };
}

export async function readDesktopUpdaterStatus(): Promise<DesktopUpdaterBridgeStatus | null> {
  if (!desktopUpdaterBridgeAvailable()) {
    return null;
  }
  const bridge = window.instafyDesktop;
  if (!bridge?.desktopUpdaterStatus) {
    return null;
  }
  const status = await bridge.desktopUpdaterStatus();
  return normalizeDesktopUpdaterStatus(status);
}

export async function checkDesktopUpdaterNow(): Promise<DesktopUpdaterBridgeStatus | null> {
  if (typeof window === "undefined" || typeof window.instafyDesktop?.desktopUpdaterCheck !== "function") {
    return null;
  }
  const status = await window.instafyDesktop.desktopUpdaterCheck();
  return normalizeDesktopUpdaterStatus(status);
}

export async function downloadDesktopUpdaterNow(): Promise<DesktopUpdaterBridgeStatus | null> {
  if (typeof window === "undefined" || typeof window.instafyDesktop?.desktopUpdaterDownload !== "function") {
    return null;
  }
  const status = await window.instafyDesktop.desktopUpdaterDownload();
  return normalizeDesktopUpdaterStatus(status);
}

export async function installDesktopUpdaterNow(): Promise<DesktopUpdaterBridgeStatus | null> {
  if (typeof window === "undefined" || typeof window.instafyDesktop?.desktopUpdaterInstall !== "function") {
    return null;
  }
  const status = await window.instafyDesktop.desktopUpdaterInstall();
  return normalizeDesktopUpdaterStatus(status);
}

export async function postDesktopUpdateEvent(input: {
  deviceId: string;
  status: DesktopUpdaterBridgeStatus;
  eventType: DesktopUpdateEventType;
  properties?: Record<string, unknown>;
  currentVersion?: string;
  availableVersion?: string | null;
}): Promise<void> {
  const event: DesktopUpdateEvent = {
    event_id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `desktop-update-${Date.now()}`,
    event_type: input.eventType,
    occurred_at: new Date().toISOString(),
    device_id: input.deviceId,
    channel: input.status.channel as DesktopUpdateEvent["channel"],
    current_version: input.currentVersion ?? input.status.currentVersion,
    available_version: input.availableVersion ?? input.status.availableVersion ?? null,
    phase: input.status.phase,
    feed_url: input.status.feedUrl,
    platform: browserPlatform(),
    arch: browserArch(),
    properties: {
      build_release_id: instafyBuildInfo.releaseId,
      build_git_sha: instafyBuildInfo.gitCommit,
      build_git_short: instafyBuildInfo.gitCommitShort,
      ...(input.properties ?? {}),
    },
  };
  const response = await fetch(`${controllerBaseUrl}/desktop-updates/events`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[desktop-updates] unable to post desktop update event:", message);
    return null;
  });
  if (response && !response.ok) {
    const message = await readControllerError(response, "desktop update event ingestion failed");
    console.warn("[desktop-updates] controller rejected event:", message);
  }
}
