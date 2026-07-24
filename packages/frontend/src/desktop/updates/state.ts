import type { DesktopUpdatePhase } from "@instafy/ota-contracts";

const DEVICE_ID_STORAGE_KEY = "instafy.desktop-updates.deviceId";
const SNAPSHOT_STORAGE_KEY = "instafy.desktop-updates.lastSnapshot";

export const DESKTOP_UPDATER_STATUS_CHANGED_EVENT =
  "instafy:desktop-updater-status-changed";

export interface StoredDesktopUpdaterSnapshot {
  channel: string;
  currentVersion: string;
  availableVersion: string | null;
  phase: DesktopUpdatePhase;
  feedUrl: string;
  lastCheckedAt: string | null;
  lastDownloadedAt: string | null;
  lastError: string | null;
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function readStorageValue(key: string): string | null {
  if (!hasWindow()) {
    return null;
  }
  try {
    const value = window.localStorage.getItem(key)?.trim() ?? "";
    return value || null;
  } catch {
    return null;
  }
}

function writeStorageValue(key: string, value: string | null) {
  if (!hasWindow()) {
    return;
  }
  try {
    if (value && value.trim()) {
      window.localStorage.setItem(key, value.trim());
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage failures
  }
}

export function getOrCreateDesktopUpdateDeviceId(): string | null {
  const existing = readStorageValue(DEVICE_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const generated =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `desktop-${Date.now()}`;
  writeStorageValue(DEVICE_ID_STORAGE_KEY, generated);
  return generated;
}

export function readStoredDesktopUpdaterSnapshot(): StoredDesktopUpdaterSnapshot | null {
  const raw = readStorageValue(SNAPSHOT_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredDesktopUpdaterSnapshot;
    if (
      typeof parsed.channel !== "string" ||
      typeof parsed.currentVersion !== "string" ||
      typeof parsed.feedUrl !== "string" ||
      typeof parsed.phase !== "string"
    ) {
      return null;
    }
    return {
      channel: parsed.channel,
      currentVersion: parsed.currentVersion,
      availableVersion: parsed.availableVersion ?? null,
      phase: parsed.phase,
      feedUrl: parsed.feedUrl,
      lastCheckedAt: parsed.lastCheckedAt ?? null,
      lastDownloadedAt: parsed.lastDownloadedAt ?? null,
      lastError: parsed.lastError ?? null,
    };
  } catch {
    return null;
  }
}

export function writeStoredDesktopUpdaterSnapshot(snapshot: StoredDesktopUpdaterSnapshot | null) {
  if (!snapshot) {
    writeStorageValue(SNAPSHOT_STORAGE_KEY, null);
    return;
  }
  writeStorageValue(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
}

export function publishDesktopUpdaterSnapshot(snapshot: StoredDesktopUpdaterSnapshot) {
  writeStoredDesktopUpdaterSnapshot(snapshot);
  if (!hasWindow()) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<StoredDesktopUpdaterSnapshot>(
      DESKTOP_UPDATER_STATUS_CHANGED_EVENT,
      { detail: snapshot },
    ),
  );
}
