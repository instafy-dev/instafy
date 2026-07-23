import { instafyBuildInfo } from "../../config/buildInfo";
import { hasWindow } from "./shared";

const FALLBACK_DEVICE_ID_STORAGE_KEY = "instafy.ota.deviceId";
const CURRENT_BUNDLE_VERSION_STORAGE_KEY = "instafy.ota.current.bundleVersion";
const CURRENT_GIT_SHA_STORAGE_KEY = "instafy.ota.current.gitSha";
const PENDING_RELEASE_ID_STORAGE_KEY = "instafy.ota.pending.releaseId";
const PENDING_BUNDLE_VERSION_STORAGE_KEY = "instafy.ota.pending.bundleVersion";
const PENDING_GIT_SHA_STORAGE_KEY = "instafy.ota.pending.gitSha";
const LAST_UPDATE_RESULT_STORAGE_KEY = "instafy.ota.lastUpdateResult";
const LAST_CHECK_SNAPSHOT_STORAGE_KEY = "instafy.ota.lastCheckSnapshot";
const LAST_DOWNLOADED_AT_STORAGE_KEY = "instafy.ota.lastDownloadedAt";
const LAST_ERROR_STORAGE_KEY = "instafy.ota.lastError";

export interface NativeOtaCurrentState {
  bundle_version: string | null;
  git_sha: string | null;
}

export interface NativeOtaPendingState {
  release_id: string | null;
  bundle_version: string | null;
  git_sha: string | null;
}

export interface NativeOtaStoredState {
  current: NativeOtaCurrentState;
  pending: NativeOtaPendingState;
}

export interface NativeOtaLastCheckSnapshot {
  checked_at: string;
  update_available: boolean;
  reason: string | null;
  release_id: string | null;
  bundle_version: string | null;
  git_sha: string | null;
}

export interface NativeOtaReconciliationInput {
  state: NativeOtaStoredState;
  current_bundle_id: string | null;
  previous_bundle_id?: string | null;
  rollback: boolean;
}

export interface NativeOtaReconciliationResult {
  state: NativeOtaStoredState;
  applied_pending: NativeOtaPendingState | null;
  rolled_back_pending: NativeOtaPendingState | null;
  previous_bundle_id: string | null;
  current_bundle_id: string | null;
}

function defaultBundleVersion(): string {
  return instafyBuildInfo.releaseId;
}

function defaultGitSha(): string | null {
  return instafyBuildInfo.gitCommit ?? null;
}

function defaultCurrentState(): NativeOtaCurrentState {
  return {
    bundle_version: defaultBundleVersion(),
    git_sha: defaultGitSha(),
  };
}

function emptyPendingState(): NativeOtaPendingState {
  return {
    release_id: null,
    bundle_version: null,
    git_sha: null,
  };
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

export function getOrCreateFallbackNativeOtaDeviceId(): string | null {
  const existing = readStorageValue(FALLBACK_DEVICE_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const generated =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `device-${Date.now()}`;
  writeStorageValue(FALLBACK_DEVICE_ID_STORAGE_KEY, generated);
  return generated;
}

export function readStoredNativeOtaState(): NativeOtaStoredState {
  return {
    current: {
      bundle_version:
        readStorageValue(CURRENT_BUNDLE_VERSION_STORAGE_KEY) ?? defaultBundleVersion(),
      git_sha: readStorageValue(CURRENT_GIT_SHA_STORAGE_KEY) ?? defaultGitSha(),
    },
    pending: {
      release_id: readStorageValue(PENDING_RELEASE_ID_STORAGE_KEY),
      bundle_version: readStorageValue(PENDING_BUNDLE_VERSION_STORAGE_KEY),
      git_sha: readStorageValue(PENDING_GIT_SHA_STORAGE_KEY),
    },
  };
}

export function writeStoredNativeOtaState(state: NativeOtaStoredState) {
  writeStorageValue(CURRENT_BUNDLE_VERSION_STORAGE_KEY, state.current.bundle_version);
  writeStorageValue(CURRENT_GIT_SHA_STORAGE_KEY, state.current.git_sha);
  writeStorageValue(PENDING_RELEASE_ID_STORAGE_KEY, state.pending.release_id);
  writeStorageValue(PENDING_BUNDLE_VERSION_STORAGE_KEY, state.pending.bundle_version);
  writeStorageValue(PENDING_GIT_SHA_STORAGE_KEY, state.pending.git_sha);
}

export function stagePendingNativeOtaState(pending: NativeOtaPendingState) {
  const current = readStoredNativeOtaState().current;
  writeStoredNativeOtaState({ current, pending });
}

export function clearPendingNativeOtaState() {
  const current = readStoredNativeOtaState().current;
  writeStoredNativeOtaState({
    current,
    pending: emptyPendingState(),
  });
}

export function readLastNativeOtaResult(): string | null {
  return readStorageValue(LAST_UPDATE_RESULT_STORAGE_KEY);
}

export function storeLastNativeOtaResult(value: string | null) {
  writeStorageValue(LAST_UPDATE_RESULT_STORAGE_KEY, value);
}

export function readLastNativeOtaCheckSnapshot(): NativeOtaLastCheckSnapshot | null {
  const raw = readStorageValue(LAST_CHECK_SNAPSHOT_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NativeOtaLastCheckSnapshot>;
    if (typeof parsed.checked_at !== "string" || typeof parsed.update_available !== "boolean") {
      return null;
    }
    return {
      checked_at: parsed.checked_at,
      update_available: parsed.update_available,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      release_id: typeof parsed.release_id === "string" ? parsed.release_id : null,
      bundle_version: typeof parsed.bundle_version === "string" ? parsed.bundle_version : null,
      git_sha: typeof parsed.git_sha === "string" ? parsed.git_sha : null,
    };
  } catch {
    return null;
  }
}

export function storeLastNativeOtaCheckSnapshot(snapshot: NativeOtaLastCheckSnapshot | null) {
  if (!snapshot) {
    writeStorageValue(LAST_CHECK_SNAPSHOT_STORAGE_KEY, null);
    return;
  }
  writeStorageValue(LAST_CHECK_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
}

export function readLastNativeOtaDownloadedAt(): string | null {
  return readStorageValue(LAST_DOWNLOADED_AT_STORAGE_KEY);
}

export function storeLastNativeOtaDownloadedAt(value: string | null) {
  writeStorageValue(LAST_DOWNLOADED_AT_STORAGE_KEY, value);
}

export function readLastNativeOtaError(): string | null {
  return readStorageValue(LAST_ERROR_STORAGE_KEY);
}

export function storeLastNativeOtaError(value: string | null) {
  writeStorageValue(LAST_ERROR_STORAGE_KEY, value);
}

function resolveKnownStateForBundleId(
  bundleId: string | null,
  state: NativeOtaStoredState,
): NativeOtaCurrentState {
  if (!bundleId) {
    return defaultCurrentState();
  }
  if (state.pending.bundle_version === bundleId) {
    return {
      bundle_version: bundleId,
      git_sha: state.pending.git_sha ?? null,
    };
  }
  if (state.current.bundle_version === bundleId) {
    return {
      bundle_version: bundleId,
      git_sha: state.current.git_sha ?? null,
    };
  }
  if (bundleId === defaultBundleVersion()) {
    return defaultCurrentState();
  }
  return {
    bundle_version: bundleId,
    git_sha: null,
  };
}

export function reconcileNativeOtaState(
  input: NativeOtaReconciliationInput,
): NativeOtaReconciliationResult {
  const applied_pending =
    !input.rollback &&
    Boolean(input.state.pending.bundle_version) &&
    input.current_bundle_id === input.state.pending.bundle_version
      ? { ...input.state.pending }
      : null;
  const rolled_back_pending = input.rollback ? { ...input.state.pending } : null;
  const nextCurrent = resolveKnownStateForBundleId(input.current_bundle_id, input.state);
  return {
    state: {
      current: nextCurrent,
      pending:
        applied_pending || rolled_back_pending
          ? emptyPendingState()
          : { ...input.state.pending },
    },
    applied_pending,
    rolled_back_pending,
    previous_bundle_id: input.previous_bundle_id ?? null,
    current_bundle_id: input.current_bundle_id,
  };
}
