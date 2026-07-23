import type { OtaCheckResponse } from "@instafy/ota-contracts";
import { Capacitor } from "@capacitor/core";
import {
  buildNativeOtaIdentity,
  checkForNativeOtaUpdate,
  postNativeOtaEvent,
  type NativeOtaIdentity,
} from "./client";
import {
  downloadNativeLiveUpdateBundle,
  getNativeLiveUpdateCurrentBundleId,
  getNativeLiveUpdateDownloadedBundleIds,
  markNativeLiveUpdateReady,
  reloadIntoNativeLiveUpdateBundle,
  setNativeLiveUpdateChannel,
  setNativeLiveUpdateNextBundle,
} from "./liveUpdate";
import {
  clearPendingNativeOtaState,
  readLastNativeOtaError,
  readStoredNativeOtaState,
  reconcileNativeOtaState,
  storeLastNativeOtaDownloadedAt,
  storeLastNativeOtaError,
  stagePendingNativeOtaState,
  writeStoredNativeOtaState,
} from "./state";
import {
  otaIsSupportedOnThisClient,
  resolveNativeOtaChannel,
} from "./shared";
import { nativeBuildDisablesOta } from "./nativeRuntimeConfig";

let installed = false;
let refreshNativeOtaSession: (() => Promise<OtaCheckResponse | null>) | null = null;
const NATIVE_OTA_DISABLE_QUERY_PARAM = "disableNativeOta";
const NATIVE_OTA_DISABLE_STORAGE_KEY = "instafy.nativeOtaDisabled";

type AppStateListenerHandle = { remove: () => Promise<void> | void };

function normalizeBooleanOverride(value: string | null | undefined): boolean | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized.length) {
    return true;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return true;
}

export function resolveNativeOtaDisabled(input: {
  search?: string | null;
  persistedValue?: string | null;
  uiTestOverride?: boolean;
}): boolean {
  if (input.uiTestOverride === true) {
    return true;
  }
  const override = normalizeBooleanOverride(
    new URLSearchParams(input.search ?? "").get(NATIVE_OTA_DISABLE_QUERY_PARAM),
  );
  if (override !== null) {
    return override;
  }
  return input.persistedValue === "1";
}

function nativeOtaDisabledForCurrentLaunch(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  let persistedValue: string | null = null;
  try {
    persistedValue = window.localStorage.getItem(NATIVE_OTA_DISABLE_STORAGE_KEY);
  } catch {
    persistedValue = null;
  }

  const uiTestOverride = (
    window as Window & { __INSTAFY_UI_TEST_DISABLE_NATIVE_OTA__?: boolean }
  ).__INSTAFY_UI_TEST_DISABLE_NATIVE_OTA__;
  if (resolveNativeOtaDisabled({ uiTestOverride })) {
    return true;
  }

  const override = normalizeBooleanOverride(
    new URLSearchParams(window.location.search).get(NATIVE_OTA_DISABLE_QUERY_PARAM),
  );
  if (override !== null) {
    try {
      if (override) {
        window.localStorage.setItem(NATIVE_OTA_DISABLE_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(NATIVE_OTA_DISABLE_STORAGE_KEY);
      }
    } catch {
      // Ignore storage write failures during bootstrap.
    }
    return override;
  }

  return persistedValue === "1";
}

function isMissingNativeBundleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bbundle not found\b/i.test(message);
}

async function prepareNativeOtaLifecycle(): Promise<{
  identity: NativeOtaIdentity | null;
  reconciliation: ReturnType<typeof reconcileNativeOtaState> | null;
}> {
  const channel = resolveNativeOtaChannel();
  await setNativeLiveUpdateChannel(channel).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ota] unable to set live update channel:", message);
    storeLastNativeOtaError(message);
  });

  const readyResult = await markNativeLiveUpdateReady().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ota] ready() failed:", message);
    storeLastNativeOtaError(message);
    return null;
  });

  const currentBundleId =
    readyResult?.currentBundleId ??
    (await getNativeLiveUpdateCurrentBundleId().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[ota] unable to resolve current live update bundle:", message);
      storeLastNativeOtaError(message);
      return null;
    }));

  const reconciliation = reconcileNativeOtaState({
    state: readStoredNativeOtaState(),
    current_bundle_id: currentBundleId,
    previous_bundle_id: readyResult?.previousBundleId ?? null,
    rollback: readyResult?.rollback ?? false,
  });
  writeStoredNativeOtaState(reconciliation.state);

  const identity = await buildNativeOtaIdentity({
    channel,
    current_bundle_version: reconciliation.state.current.bundle_version,
    current_git_sha: reconciliation.state.current.git_sha,
  });

  return { identity, reconciliation };
}

async function postLifecycleEvents(input: {
  identity: NativeOtaIdentity;
  reconciliation: ReturnType<typeof reconcileNativeOtaState>;
  session_id: string;
}) {
  const { identity, reconciliation, session_id } = input;
  if (reconciliation.applied_pending) {
    await postNativeOtaEvent({
      event_type: "app_reloaded",
      identity,
      session_id,
      bundle_version: reconciliation.applied_pending.bundle_version,
      git_sha: reconciliation.applied_pending.git_sha,
      properties: {
        release_id: reconciliation.applied_pending.release_id,
        previous_bundle_id: reconciliation.previous_bundle_id,
        current_bundle_id: reconciliation.current_bundle_id,
      },
    });
  }
  if (reconciliation.rolled_back_pending) {
    await postNativeOtaEvent({
      event_type: "rollback_triggered",
      identity,
      session_id,
      bundle_version: reconciliation.rolled_back_pending.bundle_version,
      git_sha: reconciliation.rolled_back_pending.git_sha,
      properties: {
        release_id: reconciliation.rolled_back_pending.release_id,
        previous_bundle_id: reconciliation.previous_bundle_id,
        current_bundle_id: reconciliation.current_bundle_id,
      },
    });
  }
}

function normalizeArtifactType(
  response: OtaCheckResponse,
): "manifest" | "zip" | null {
  if (!response.artifact_type || response.artifact_type === "zip") {
    return "zip";
  }
  if (response.artifact_type === "manifest") {
    return "manifest";
  }
  return null;
}

async function applyAvailableNativeOtaUpdate(input: {
  identity: NativeOtaIdentity;
  session_id: string;
  response: OtaCheckResponse;
}) {
  const { identity, session_id, response } = input;
  if (!response.update_available || !response.bundle_version || !response.artifact_url) {
    return;
  }
  if (response.bundle_version === identity.current_bundle_version) {
    return;
  }

  const artifactType = normalizeArtifactType(response);
  if (!artifactType) {
    await postNativeOtaEvent({
      event_type: "install_failed",
      identity,
      session_id,
      bundle_version: response.bundle_version,
      git_sha: response.git_sha ?? null,
      properties: {
        reason: `unsupported artifact type: ${response.artifact_type}`,
        release_id: response.release_id ?? null,
      },
    });
    return;
  }

  const existingState = readStoredNativeOtaState();
  if (existingState.pending.bundle_version === response.bundle_version) {
    await setNativeLiveUpdateNextBundle(response.bundle_version).catch((error) => {
      if (isMissingNativeBundleError(error)) {
        clearPendingNativeOtaState();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[ota] unable to reaffirm already-staged bundle:", message);
    });
    return;
  }

  try {
    storeLastNativeOtaError(null);
    await postNativeOtaEvent({
      event_type: "download_started",
      identity,
      session_id,
      bundle_version: response.bundle_version,
      git_sha: response.git_sha ?? null,
      properties: {
        release_id: response.release_id ?? null,
        artifact_url: response.artifact_url,
        artifact_type: artifactType,
      },
    });
    const downloadInput = {
      bundle_id: response.bundle_version,
      url: response.artifact_url,
      artifact_type: artifactType,
      checksum: response.artifact_sha256 ?? null,
      signature: response.signature ?? null,
    } as const;
    try {
      await downloadNativeLiveUpdateBundle(downloadInput);
    } catch (error) {
      const initialMessage = error instanceof Error ? error.message : String(error);
      if (artifactType !== "zip") {
        throw error;
      }
      console.warn("[ota] primary bundle download failed, retrying with cache-busted URL:", initialMessage);
      const retryToken = `${response.bundle_version}-${Date.now()}`;
      await downloadNativeLiveUpdateBundle({
        ...downloadInput,
        cache_bust: retryToken,
      }).catch((retryError) => {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        throw new Error(`${retryMessage} (after retry; first failure: ${initialMessage})`);
      });
    }
    await postNativeOtaEvent({
      event_type: "download_completed",
      identity,
      session_id,
      bundle_version: response.bundle_version,
      git_sha: response.git_sha ?? null,
      properties: {
        release_id: response.release_id ?? null,
      },
    });
    storeLastNativeOtaDownloadedAt(new Date().toISOString());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ota] download failed:", message);
    storeLastNativeOtaError(message);
    await postNativeOtaEvent({
      event_type: "download_failed",
      identity,
      session_id,
      bundle_version: response.bundle_version,
      git_sha: response.git_sha ?? null,
      properties: {
        reason: message,
        release_id: response.release_id ?? null,
      },
    });
    return;
  }

  try {
    storeLastNativeOtaError(null);
    await postNativeOtaEvent({
      event_type: "install_started",
      identity,
      session_id,
      bundle_version: response.bundle_version,
      git_sha: response.git_sha ?? null,
      properties: {
        release_id: response.release_id ?? null,
      },
    });
    await setNativeLiveUpdateNextBundle(response.bundle_version);
    stagePendingNativeOtaState({
      release_id: response.release_id ?? null,
      bundle_version: response.bundle_version,
      git_sha: response.git_sha ?? null,
    });
    await postNativeOtaEvent({
      event_type: "install_completed",
      identity,
      session_id,
      bundle_version: response.bundle_version,
      git_sha: response.git_sha ?? null,
      properties: {
        release_id: response.release_id ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ota] install staging failed:", message);
    storeLastNativeOtaError(message);
    await postNativeOtaEvent({
      event_type: "install_failed",
      identity,
      session_id,
      bundle_version: response.bundle_version,
      git_sha: response.git_sha ?? null,
      properties: {
        reason: message,
        release_id: response.release_id ?? null,
      },
    });
    return;
  }
}

async function applyStagedNativeOtaOnNextLaunch(input: {
  identity: NativeOtaIdentity;
  reconciliation: NonNullable<Awaited<ReturnType<typeof prepareNativeOtaLifecycle>>["reconciliation"]>;
}) {
  const pendingBundle = input.reconciliation.state.pending.bundle_version;
  if (!pendingBundle || pendingBundle === input.reconciliation.current_bundle_id) {
    return false;
  }

  const downloadedBundles: string[] = await getNativeLiveUpdateDownloadedBundleIds().catch(
    (error): string[] => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[ota] unable to list downloaded bundles:", message);
      return [];
    },
  );
  if (!downloadedBundles.includes(pendingBundle)) {
    clearPendingNativeOtaState();
    storeLastNativeOtaError(null);
    return false;
  }

  try {
    await setNativeLiveUpdateNextBundle(pendingBundle);
    await reloadIntoNativeLiveUpdateBundle();
    return true;
  } catch (error) {
    if (isMissingNativeBundleError(error)) {
      clearPendingNativeOtaState();
      storeLastNativeOtaError(null);
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[ota] unable to apply staged update on launch:", message);
    storeLastNativeOtaError(message);
    await postNativeOtaEvent({
      event_type: "install_failed",
      identity: input.identity,
      bundle_version: pendingBundle,
      git_sha: input.reconciliation.state.pending.git_sha,
      properties: {
        reason: message,
        release_id: input.reconciliation.state.pending.release_id,
      },
    });
    return false;
  }
}

export async function installNativeOtaBootstrap() {
  if (
    installed ||
    !otaIsSupportedOnThisClient() ||
    !Capacitor.isNativePlatform() ||
    nativeOtaDisabledForCurrentLaunch()
  ) {
    return;
  }
  installed = true;

  if (await nativeBuildDisablesOta()) {
    return;
  }

  let appStateListener: AppStateListenerHandle | null = null;
  let currentSessionId: string | null = null;
  let sessionStarted = false;
  let attemptedInitialPendingApply = false;

  const nextSessionId = () =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `session-${Date.now()}`;

  async function ensureSessionStarted(): Promise<OtaCheckResponse | null> {
    const lifecycle = await prepareNativeOtaLifecycle();
    const identity = lifecycle.identity;
    if (!identity) {
      return null;
    }
    if (!attemptedInitialPendingApply && lifecycle.reconciliation) {
      attemptedInitialPendingApply = true;
      const appliedOnLaunch = await applyStagedNativeOtaOnNextLaunch({
        identity,
        reconciliation: lifecycle.reconciliation,
      });
      if (appliedOnLaunch) {
        return null;
      }
    }
    if (!currentSessionId) {
      currentSessionId = nextSessionId();
    }
    if (!sessionStarted) {
      sessionStarted = true;
      await postNativeOtaEvent({
        event_type: "session_started",
        identity,
        session_id: currentSessionId,
      });
    }
    if (lifecycle.reconciliation) {
      await postLifecycleEvents({
        identity,
        reconciliation: lifecycle.reconciliation,
        session_id: currentSessionId,
      });
    }
    await postNativeOtaEvent({
      event_type: "update_check_requested",
      identity,
      session_id: currentSessionId,
    });
    const result = await checkForNativeOtaUpdate(identity).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[ota] native OTA check failed:", message);
      storeLastNativeOtaError(message);
      return null;
    });
    if (!result) {
      return null;
    }
    if (readLastNativeOtaError()) {
      storeLastNativeOtaError(null);
    }
    await postNativeOtaEvent({
      event_type: result.update_available ? "update_available" : "update_not_available",
      identity,
      session_id: currentSessionId,
      properties: {
        reason: result.reason,
        release_id: result.release_id ?? null,
        rollout_percentage: result.rollout_percentage ?? null,
      },
      bundle_version: result.bundle_version ?? identity.current_bundle_version,
      git_sha: result.git_sha ?? identity.current_git_sha,
    });
    await applyAvailableNativeOtaUpdate({
      identity,
      session_id: currentSessionId,
      response: result,
    });
    return result;
  }

  async function endSession() {
    const sessionId = currentSessionId;
    if (!sessionId || !sessionStarted) {
      return;
    }
    const identity = await buildNativeOtaIdentity();
    if (identity) {
      await postNativeOtaEvent({
        event_type: "session_ended",
        identity,
        session_id: sessionId,
      });
    }
    currentSessionId = null;
    sessionStarted = false;
  }

  void (async () => {
    try {
      const { App } = await import("@capacitor/app");
      refreshNativeOtaSession = ensureSessionStarted;
      await ensureSessionStarted();
      appStateListener = await App.addListener("appStateChange", (event) => {
        if (event.isActive) {
          void ensureSessionStarted();
        } else {
          void endSession();
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[ota] unable to install native OTA bootstrap:", message);
    }
  })();

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      refreshNativeOtaSession = null;
      void endSession();
      if (appStateListener) {
        void appStateListener.remove();
      }
    });
  }
}

export async function triggerNativeOtaCheck(): Promise<OtaCheckResponse | null> {
  if (!refreshNativeOtaSession) {
    return null;
  }
  return await refreshNativeOtaSession();
}

export async function applyStagedNativeOtaUpdate(): Promise<boolean> {
  const pending = readStoredNativeOtaState().pending.bundle_version;
  if (!pending) {
    return false;
  }
  await setNativeLiveUpdateNextBundle(pending);
  await reloadIntoNativeLiveUpdateBundle();
  return true;
}
