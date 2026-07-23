import type { DesktopUpdateEventType, DesktopUpdatePhase } from "@instafy/ota-contracts";
import { desktopUpdaterBridgeAvailable, postDesktopUpdateEvent, readDesktopUpdaterStatus, type DesktopUpdaterBridgeStatus } from "./client";
import { getOrCreateDesktopUpdateDeviceId, readStoredDesktopUpdaterSnapshot, writeStoredDesktopUpdaterSnapshot, type StoredDesktopUpdaterSnapshot } from "./state";

const POLL_INTERVAL_MS = 30_000;

let installed = false;
let pollInFlight = false;

function normalizeSnapshot(status: DesktopUpdaterBridgeStatus): StoredDesktopUpdaterSnapshot {
  return {
    channel: status.channel,
    currentVersion: status.currentVersion,
    availableVersion: status.availableVersion ?? null,
    phase: status.phase,
    feedUrl: status.feedUrl,
    lastCheckedAt: status.lastCheckedAt ?? null,
    lastDownloadedAt: status.lastDownloadedAt ?? null,
    lastError: status.lastError ?? null,
  };
}

function baselineEventType(phase: DesktopUpdatePhase): DesktopUpdateEventType {
  switch (phase) {
    case "update_available":
      return "update_available";
    case "downloaded":
      return "update_ready";
    case "downloading":
      return "download_started";
    case "error":
      return "update_error";
    case "up_to_date":
    case "checking":
    case "idle":
    default:
      return "update_not_available";
  }
}

async function emitStatusEvent(
  deviceId: string,
  status: DesktopUpdaterBridgeStatus,
  eventType: DesktopUpdateEventType,
  properties?: Record<string, unknown>,
) {
  await postDesktopUpdateEvent({
    deviceId,
    status,
    eventType,
    properties,
  });
}

async function emitTransitionEvents(input: {
  deviceId: string;
  previous: StoredDesktopUpdaterSnapshot | null;
  current: StoredDesktopUpdaterSnapshot;
  status: DesktopUpdaterBridgeStatus;
}) {
  const { deviceId, previous, current, status } = input;

  if (!previous) {
    await emitStatusEvent(deviceId, status, baselineEventType(current.phase), {
      baseline: true,
      last_checked_at: current.lastCheckedAt,
      last_downloaded_at: current.lastDownloadedAt,
    });
    return;
  }

  if (previous.currentVersion !== current.currentVersion) {
    await postDesktopUpdateEvent({
      deviceId,
      status,
      eventType: "install_applied",
      currentVersion: current.currentVersion,
      availableVersion: current.availableVersion,
      properties: {
        previous_version: previous.currentVersion,
        previous_available_version: previous.availableVersion,
      },
    });
  }

  const checkAdvanced = Boolean(current.lastCheckedAt && current.lastCheckedAt !== previous.lastCheckedAt);
  const downloadAdvanced = Boolean(
    current.lastDownloadedAt && current.lastDownloadedAt !== previous.lastDownloadedAt,
  );
  const versionChanged = current.availableVersion !== previous.availableVersion;
  const phaseChanged = current.phase !== previous.phase;
  const errorChanged = current.lastError !== previous.lastError;

  if (
    current.phase === "update_available" &&
    (phaseChanged || versionChanged || checkAdvanced)
  ) {
    await emitStatusEvent(deviceId, status, "update_available", {
      previous_phase: previous.phase,
      previous_available_version: previous.availableVersion,
    });
    return;
  }

  if (
    current.phase === "up_to_date" &&
    (phaseChanged || checkAdvanced)
  ) {
    await emitStatusEvent(deviceId, status, "update_not_available", {
      previous_phase: previous.phase,
    });
    return;
  }

  if (current.phase === "downloading" && phaseChanged) {
    await emitStatusEvent(deviceId, status, "download_started", {
      previous_phase: previous.phase,
      target_version: current.availableVersion,
    });
    return;
  }

  if (current.phase === "downloaded" && (phaseChanged || downloadAdvanced || versionChanged)) {
    await emitStatusEvent(deviceId, status, "download_completed", {
      previous_phase: previous.phase,
      target_version: current.availableVersion,
    });
    await emitStatusEvent(deviceId, status, "update_ready", {
      previous_phase: previous.phase,
      target_version: current.availableVersion,
    });
    return;
  }

  if (current.phase === "error" && (phaseChanged || errorChanged)) {
    await emitStatusEvent(deviceId, status, "update_error", {
      previous_phase: previous.phase,
      reason: current.lastError,
    });
  }
}

async function syncDesktopUpdaterState() {
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;
  try {
    const status = await readDesktopUpdaterStatus();
    if (!status) {
      return;
    }
    const deviceId = getOrCreateDesktopUpdateDeviceId();
    if (!deviceId) {
      return;
    }
    const previous = readStoredDesktopUpdaterSnapshot();
    const current = normalizeSnapshot(status);
    await emitTransitionEvents({ deviceId, previous, current, status });
    writeStoredDesktopUpdaterSnapshot(current);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[desktop-updates] sync failed:", message);
  } finally {
    pollInFlight = false;
  }
}

export function installDesktopUpdateBootstrap() {
  if (installed || !desktopUpdaterBridgeAvailable()) {
    return;
  }
  installed = true;
  void syncDesktopUpdaterState();
  window.setInterval(() => {
    void syncDesktopUpdaterState();
  }, POLL_INTERVAL_MS);
  window.addEventListener("focus", () => {
    void syncDesktopUpdaterState();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void syncDesktopUpdaterState();
    }
  });
}
