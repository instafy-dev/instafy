import { Capacitor } from "@capacitor/core";
import type { DesktopUpdaterBridgeStatus } from "../desktop/updates/client";
import {
  desktopUpdaterBridgeAvailable,
  readDesktopUpdaterStatus,
} from "../desktop/updates/client";
import { readStoredDesktopUpdaterSnapshot } from "../desktop/updates/state";
import { formatInstafyBuildLabel, instafyBuildInfo } from "../config/buildInfo";
import { buildNativeOtaIdentity } from "../mobile/ota/client";
import {
  readLastNativeOtaDownloadedAt,
  readLastNativeOtaError,
  readLastNativeOtaCheckSnapshot,
  readLastNativeOtaResult,
  type NativeOtaLastCheckSnapshot,
  type NativeOtaStoredState,
  readStoredNativeOtaState,
} from "../mobile/ota/state";
import { otaIsSupportedOnThisClient, resolveNativeOtaChannel } from "../mobile/ota/shared";

export type AppUpdateSurface = "desktop" | "native-ota" | "web";
export type AppUpdateAction = "check" | "download" | "install" | null;

export interface AppReleaseMetadata {
  build: InstafyBuildInfo;
  runtime_surface: AppUpdateSurface;
  binary: {
    version: string;
    label: string;
    platform: string;
  };
  updates: {
    supported: boolean;
    is_enabled: boolean;
    primary_action: AppUpdateAction;
    channel: string | null;
    phase: string | null;
    current_bundle_version: string | null;
    current_git_sha: string | null;
    available_version: string | null;
    native_version: string | null;
    feed_url: string | null;
    last_checked_at: string | null;
    last_downloaded_at: string | null;
    last_error: string | null;
    last_check_reason: string | null;
  };
}

export interface AppUpdatePresentation {
  title: string;
  detail: string;
  emphasis: "neutral" | "attention" | "success" | "danger";
  show: boolean;
}

export interface DesktopDownloadFeedback {
  intent: "success" | "info" | "error";
  message: string;
}

export function resolveDesktopDownloadFeedback(
  status: DesktopUpdaterBridgeStatus | null,
  metadata: AppReleaseMetadata | null,
): DesktopDownloadFeedback {
  const refreshedPhase = metadata?.updates.phase;
  if (status?.phase === "downloaded" || refreshedPhase === "downloaded") {
    return {
      intent: "success",
      message: "Desktop update downloaded. Restart Instafy to install it.",
    };
  }
  if (status?.phase === "error" || refreshedPhase === "error") {
    return {
      intent: "error",
      message:
        status?.lastError?.trim() ||
        metadata?.updates.last_error?.trim() ||
        "Desktop update download failed.",
    };
  }
  if (status?.phase === "downloading" || refreshedPhase === "downloading") {
    return {
      intent: "info",
      message: "Desktop update is downloading in the background.",
    };
  }
  return {
    intent: "error",
    message: "Instafy could not start the desktop update download.",
  };
}

function browserPlatform(): string {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform();
  }
  if (typeof navigator !== "undefined") {
    return navigator.userAgent.includes("Electron") ? "desktop-web" : "web";
  }
  return "web";
}

function desktopPrimaryAction(
  phase: DesktopUpdaterBridgeStatus["phase"] | null,
  availableVersion: string | null,
): AppUpdateAction {
  if (phase === "update_available") return "download";
  if (phase === "downloaded") return "install";
  if (phase === "error") return availableVersion ? "download" : "check";
  if (phase === "idle" || phase === "up_to_date") return "check";
  return null;
}

export function deriveNativeOtaPhaseAction(input: {
  supported: boolean;
  state: NativeOtaStoredState;
  lastCheck: NativeOtaLastCheckSnapshot | null;
}): {
  phase: string | null;
  primary_action: AppUpdateAction;
} {
  if (!input.supported) {
    return {
      phase: null,
      primary_action: null,
    };
  }

  const currentBundle = input.state.current.bundle_version;
  const pendingBundle = input.state.pending.bundle_version;
  if (pendingBundle && pendingBundle !== currentBundle) {
    return {
      phase: "downloaded",
      primary_action: "install",
    };
  }

  if (!input.lastCheck) {
    return {
      phase: "idle",
      primary_action: "check",
    };
  }

  if (
    input.lastCheck.update_available &&
    input.lastCheck.bundle_version &&
    currentBundle &&
    input.lastCheck.bundle_version === currentBundle
  ) {
    return {
      phase: "up_to_date",
      primary_action: "check",
    };
  }

  if (input.lastCheck.update_available) {
    return {
      phase: "update_available",
      primary_action: "download",
    };
  }

  return {
    phase: "up_to_date",
    primary_action: "check",
  };
}

export function resolveNativeOtaAvailableVersion(input: {
  current_bundle_version: string | null;
  phase: string | null;
  lastCheck: NativeOtaLastCheckSnapshot | null;
}): string | null {
  const bundleVersion = input.lastCheck?.bundle_version ?? null;
  if (!bundleVersion) {
    return null;
  }
  if (input.phase === "up_to_date" && bundleVersion === input.current_bundle_version) {
    return null;
  }
  return bundleVersion;
}

function buildDesktopMetadata(status: DesktopUpdaterBridgeStatus | null): AppReleaseMetadata {
  const fallback = readStoredDesktopUpdaterSnapshot();
  const effective = status ?? (fallback
    ? {
        isEnabled: true,
        channel: fallback.channel,
        currentVersion: fallback.currentVersion,
        feedUrl: fallback.feedUrl,
        phase: fallback.phase,
        availableVersion: fallback.availableVersion ?? undefined,
        lastCheckedAt: fallback.lastCheckedAt ?? undefined,
        lastDownloadedAt: fallback.lastDownloadedAt ?? undefined,
        lastError: fallback.lastError ?? undefined,
      }
    : null);
  const version = effective?.currentVersion ?? instafyBuildInfo.packageVersion;
  return {
    build: instafyBuildInfo,
    runtime_surface: "desktop",
    binary: {
      version,
      label: formatInstafyBuildLabel(instafyBuildInfo),
      platform: browserPlatform(),
    },
    updates: {
      supported: true,
      is_enabled: effective?.isEnabled ?? false,
      primary_action:
        effective?.isEnabled === false
          ? null
          : desktopPrimaryAction(
              effective?.phase ?? "idle",
              effective?.availableVersion ?? null,
            ),
      channel: effective?.channel ?? null,
      phase: effective?.phase ?? null,
      current_bundle_version: null,
      current_git_sha: null,
      available_version: effective?.availableVersion ?? null,
      native_version: version,
      feed_url: effective?.feedUrl ?? null,
      last_checked_at: effective?.lastCheckedAt ?? null,
      last_downloaded_at: effective?.lastDownloadedAt ?? null,
      last_error: effective?.lastError ?? null,
      last_check_reason: null,
    },
  };
}

async function buildNativeMetadata(): Promise<AppReleaseMetadata> {
  const identity = await buildNativeOtaIdentity();
  const storedState = readStoredNativeOtaState();
  const currentState = storedState.current;
  const lastCheck = readLastNativeOtaCheckSnapshot();
  const lastReason = readLastNativeOtaResult();
  const lastDownloadedAt = readLastNativeOtaDownloadedAt();
  const lastError = readLastNativeOtaError();
  const supported = otaIsSupportedOnThisClient();
  const derived = deriveNativeOtaPhaseAction({
    supported,
    state: storedState,
    lastCheck,
  });
  const availableVersion = resolveNativeOtaAvailableVersion({
    current_bundle_version: currentState.bundle_version,
    phase: derived.phase,
    lastCheck,
  });
  return {
    build: instafyBuildInfo,
    runtime_surface: "native-ota",
    binary: {
      version: identity?.native_version ?? instafyBuildInfo.packageVersion,
      label: formatInstafyBuildLabel(instafyBuildInfo),
      platform: browserPlatform(),
    },
    updates: {
      supported,
      is_enabled: supported,
      primary_action: derived.primary_action,
      channel: identity?.channel ?? resolveNativeOtaChannel(),
      phase: derived.phase,
      current_bundle_version: currentState.bundle_version,
      current_git_sha: currentState.git_sha,
      available_version: availableVersion,
      native_version: identity?.native_version ?? null,
      feed_url: null,
      last_checked_at: lastCheck?.checked_at ?? null,
      last_downloaded_at: lastDownloadedAt,
      last_error: lastError,
      last_check_reason: lastCheck?.reason ?? lastReason,
    },
  };
}

function buildWebMetadata(): AppReleaseMetadata {
  return {
    build: instafyBuildInfo,
    runtime_surface: "web",
    binary: {
      version: instafyBuildInfo.packageVersion,
      label: formatInstafyBuildLabel(instafyBuildInfo),
      platform: browserPlatform(),
    },
    updates: {
      supported: false,
      is_enabled: false,
      primary_action: null,
      channel: null,
      phase: null,
      current_bundle_version: null,
      current_git_sha: instafyBuildInfo.gitCommit,
      available_version: null,
      native_version: null,
      feed_url: null,
      last_checked_at: null,
      last_downloaded_at: null,
      last_error: null,
      last_check_reason: null,
    },
  };
}

export async function collectAppReleaseMetadata(): Promise<AppReleaseMetadata> {
  const desktopBridgeAvailable = desktopUpdaterBridgeAvailable();
  const desktopStatus = desktopBridgeAvailable
    ? await readDesktopUpdaterStatus().catch(() => null)
    : null;
  if (desktopStatus || desktopBridgeAvailable) {
    return buildDesktopMetadata(desktopStatus);
  }
  if (otaIsSupportedOnThisClient()) {
    return await buildNativeMetadata();
  }
  return buildWebMetadata();
}

export function summarizeAppUpdateState(metadata: AppReleaseMetadata): AppUpdatePresentation {
  const updates = metadata.updates;
  if (!updates.supported || !updates.is_enabled) {
    return {
      title: "Updates",
      detail: "Unavailable here",
      emphasis: "neutral",
      show: false,
    };
  }

  if (updates.phase === "downloaded") {
    return {
      title: "Restart to update",
      detail: "Ready",
      emphasis: "attention",
      show: true,
    };
  }

  if (updates.phase === "update_available") {
    return {
      title: "Update available",
      detail: "New",
      emphasis: "attention",
      show: true,
    };
  }

  if (updates.phase === "downloading") {
    return {
      title: "Downloading update",
      detail: "In progress",
      emphasis: "neutral",
      show: true,
    };
  }

  if (updates.phase === "checking") {
    return {
      title: "Checking updates",
      detail: "Working",
      emphasis: "neutral",
      show: true,
    };
  }

  if (updates.phase === "error") {
    return {
      title: "Update check failed",
      detail: "Retry",
      emphasis: "danger",
      show: true,
    };
  }

  if (updates.phase === "up_to_date") {
    return {
      title: "Up to date",
      detail: "Current",
      emphasis: "success",
      show: true,
    };
  }

  return {
    title: "Updates",
    detail: "Check now",
    emphasis: "neutral",
    show: true,
  };
}

export function buildReleaseMetadataDetailRows(metadata: AppReleaseMetadata): Array<{
  label: string;
  value: string;
}> {
  const rows: Array<{ label: string; value: string }> = [
    { label: "Binary", value: metadata.binary.version || "Unknown" },
    { label: "Build", value: metadata.build.releaseId },
  ];

  if (metadata.build.gitCommitShort || metadata.build.gitCommit) {
    rows.push({
      label: "Git",
      value: metadata.build.gitCommitShort ?? metadata.build.gitCommit ?? "Unknown",
    });
  }
  if (metadata.updates.channel) {
    rows.push({ label: "Channel", value: metadata.updates.channel });
  }
  if (metadata.updates.current_bundle_version) {
    rows.push({
      label: "OTA bundle",
      value: metadata.updates.current_bundle_version,
    });
  }
  if (metadata.updates.current_git_sha) {
    rows.push({
      label: "Bundle git",
      value: metadata.updates.current_git_sha,
    });
  }
  if (metadata.updates.available_version) {
    rows.push({
      label: "Available",
      value: metadata.updates.available_version,
    });
  }
  if (metadata.updates.native_version && metadata.updates.native_version !== metadata.binary.version) {
    rows.push({
      label: "Native",
      value: metadata.updates.native_version,
    });
  }
  if (metadata.updates.last_checked_at) {
    rows.push({
      label: "Last checked",
      value: metadata.updates.last_checked_at,
    });
  }
  if (metadata.updates.last_downloaded_at) {
    rows.push({
      label: "Last downloaded",
      value: metadata.updates.last_downloaded_at,
    });
  }
  if (metadata.updates.last_check_reason) {
    rows.push({
      label: "Result",
      value: metadata.updates.last_check_reason,
    });
  }
  if (metadata.updates.last_error) {
    rows.push({
      label: "Error",
      value: metadata.updates.last_error,
    });
  }
  if (metadata.updates.feed_url) {
    rows.push({
      label: "Feed",
      value: metadata.updates.feed_url,
    });
  }

  return rows;
}
