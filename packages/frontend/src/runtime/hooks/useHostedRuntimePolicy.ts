import { useEffect, useRef, type Dispatch, type MutableRefObject } from "react";
import { controllerClient } from "../../sdk/instafy";
import type { RuntimeAction, RuntimeStoreState } from "../runtimeStore";
import type { HostedRuntimeLifecycleEventKind } from "../unexpectedHostedRuntimeRecovery";
import type { HostedRuntimeLimitErrorDetails } from "../hostedRuntimeLimitError";
import { useHostedRuntimeProjectEffects } from "./useHostedRuntimeProjectEffects";
import { useHostedRuntimeRecoveryEffects } from "./useHostedRuntimeRecoveryEffects";
import { useHostedRuntimeSelectionState } from "./useHostedRuntimeSelectionState";

const runtimeControllerEnabled = controllerClient.core.enabled;

interface UseHostedRuntimePolicyArgs {
  activeProjectId: string | null;
  projectInitialized: boolean;
  projectReadyForRuntime: boolean;
  state: RuntimeStoreState;
  dispatch: Dispatch<RuntimeAction>;
  runtimeStatusesResolved: boolean;
  setRuntimeStatusesResolved: (value: boolean) => void;
  refreshRuntimeStatuses: () => Promise<void>;
  ensureHostedRuntime: () => Promise<boolean>;
  hasHostedRuntimeInProgress: boolean;
  hostedRuntimeEnsuring: boolean;
  runtimeEnsureError: string | null;
  runtimeEnsureLimit: HostedRuntimeLimitErrorDetails | null;
  showStatus: (
    message: string,
    intent: "info" | "success" | "warning" | "error",
    durationMs?: number,
    options?: {
      actionLabel?: string;
      onAction?: () => void;
    },
  ) => void;
  setPreferredRuntime: (runtimeId: string | null) => Promise<boolean>;
  debugLog: (message: string, data?: unknown) => void;
  lastPreferredRuntimeIdRef: MutableRefObject<string | null>;
  preferenceClearRequestedRef: MutableRefObject<boolean>;
  setRuntimeEnsureError: (value: string | null) => void;
  setRuntimeEnsureLimit: (value: HostedRuntimeLimitErrorDetails | null) => void;
  runtimeMutationEnabled: boolean;
}

export function useHostedRuntimePolicy({
  activeProjectId,
  projectInitialized,
  projectReadyForRuntime,
  state,
  dispatch,
  runtimeStatusesResolved,
  setRuntimeStatusesResolved,
  refreshRuntimeStatuses,
  ensureHostedRuntime,
  hasHostedRuntimeInProgress,
  hostedRuntimeEnsuring,
  runtimeEnsureError,
  runtimeEnsureLimit,
  showStatus,
  setPreferredRuntime,
  debugLog,
  lastPreferredRuntimeIdRef,
  preferenceClearRequestedRef,
  setRuntimeEnsureError,
  setRuntimeEnsureLimit,
  runtimeMutationEnabled,
}: UseHostedRuntimePolicyArgs) {
  const previousPreferredRuntimeIdRef = useRef<string | null>(state.preferredRuntimeId);
  const runtimeOfflineAlertRef = useRef<string | null>(null);
  const autoEnsureHostedRef = useRef(false);
  const previousRuntimeProjectIdRef = useRef<string | null>(null);
  const skipAutoEnsureProjectRef = useRef<string | null>(null);
  const pendingHostedPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReadyHostedRuntimeRef = useRef<{
    projectId: string;
    runtimeId: string;
  } | null>(null);
  const pendingHostedRuntimeRecoveryRef = useRef<{
    projectId: string;
    runtimeId: string | null;
    kind: HostedRuntimeLifecycleEventKind;
    at: number;
  } | null>(null);

  const selection = useHostedRuntimeSelectionState({
    activeProjectId,
    state,
    dispatch,
    runtimeEnsureError,
    runtimeEnsureLimit,
    refreshRuntimeStatuses,
    ensureHostedRuntime,
  });

  useEffect(() => {
    lastReadyHostedRuntimeRef.current = selection.latestReadyHostedRuntime;
  }, [selection.latestReadyHostedRuntime]);

  useHostedRuntimeRecoveryEffects({
    activeProjectId,
    projectInitialized,
    projectReadyForRuntime,
    runtimeControllerEnabled: runtimeControllerEnabled && runtimeMutationEnabled,
    runtimeStatuses: state.runtimeStatuses,
    runtimeReady: selection.runtimeReady,
    readyRuntimeCount: selection.readyRuntimeCount,
    runtimeStatusesResolved,
    waitingForPreferredRuntime: selection.waitingForPreferredRuntime,
    preferredRuntimeEntry: selection.preferredRuntimeEntry,
    hostedRuntimeEnsuring,
    hasHostedRuntimeInProgress,
    hasLocalRuntime: selection.hasLocalRuntime,
    disableAutoRuntimeEnsure: selection.disableAutoRuntimeEnsure,
    resolvedPreferredRuntimeId: selection.resolvedPreferredRuntimeId,
    ensureHostedRuntime,
    refreshRuntimeStatuses,
    debugLog,
    autoEnsureHostedRef,
    pendingHostedPollTimerRef,
    pendingHostedRuntimeRecoveryRef,
    latestReadyHostedRuntimeRef: lastReadyHostedRuntimeRef,
  });

  useHostedRuntimeProjectEffects({
    activeProjectId,
    projectReadyForRuntime,
    runtimeControllerEnabled: runtimeControllerEnabled && runtimeMutationEnabled,
    state,
    dispatch,
    runtimeReady: selection.runtimeReady,
    preferredPromptDismissed: selection.preferredPromptDismissed,
    setPreferredPromptDismissed: selection.setPreferredPromptDismissed,
    shouldPromptCloudFallback: selection.shouldPromptCloudFallback,
    resolvedPreferredRuntimeId: selection.resolvedPreferredRuntimeId,
    preferredRuntimeEntry: selection.preferredRuntimeEntry,
    refreshRuntimeStatuses,
    setPreferredRuntime,
    showStatus,
    previousPreferredRuntimeIdRef,
    runtimeOfflineAlertRef,
    autoEnsureHostedRef,
    previousRuntimeProjectIdRef,
    skipAutoEnsureProjectRef,
    lastPreferredRuntimeIdRef,
    preferenceClearRequestedRef,
    latestReadyHostedRuntimeRef: lastReadyHostedRuntimeRef,
    pendingHostedRuntimeRecoveryRef,
    setRuntimeEnsureError,
    setRuntimeEnsureLimit,
    setRuntimeStatusesResolved,
  });

  return {
    preferredPromptDismissed: selection.preferredPromptDismissed,
    hostedRuntimeTakeoverInProgress: selection.hostedRuntimeTakeoverInProgress,
    setSessionRuntimeOverride: selection.setSessionRuntimeOverride,
    clearSessionRuntimeOverride: selection.clearSessionRuntimeOverride,
    dismissPreferredRuntimePrompt: selection.dismissPreferredRuntimePrompt,
    takeOverHostedRuntimeLimit: selection.takeOverHostedRuntimeLimit,
    effectiveRuntimeId: selection.effectiveRuntimeId,
    effectiveRuntimeSource: selection.effectiveRuntimeSource,
    runtimeReady: selection.runtimeReady,
    waitingForPreferredRuntime: selection.waitingForPreferredRuntime,
    recommendedCloudRuntimeId: selection.recommendedCloudRuntimeId,
    shouldPromptCloudFallback: selection.shouldPromptCloudFallback,
    selectedLocalRuntimeId: selection.selectedLocalRuntimeId,
    resolvedPreferredRuntimeId: selection.resolvedPreferredRuntimeId,
  };
}
