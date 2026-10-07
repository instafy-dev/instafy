import { useEffect, useLayoutEffect, type Dispatch, type MutableRefObject } from "react";
import type { HostedRuntimeLimitErrorDetails } from "../hostedRuntimeLimitError";
import { markRestoredAwaitingIntent } from "../idlePauseRegistry";
import type { RuntimeAction, RuntimeStoreState } from "../runtimeStore";

interface UseHostedRuntimeProjectEffectsArgs {
  activeProjectId: string | null;
  projectReadyForRuntime: boolean;
  runtimeControllerEnabled: boolean;
  state: RuntimeStoreState;
  dispatch: Dispatch<RuntimeAction>;
  runtimeReady: boolean;
  preferredPromptDismissed: boolean;
  setPreferredPromptDismissed: (value: boolean) => void;
  shouldPromptCloudFallback: boolean;
  resolvedPreferredRuntimeId: string | null;
  preferredRuntimeEntry: { health: string } | null;
  refreshRuntimeStatuses: () => Promise<void>;
  setPreferredRuntime: (runtimeId: string | null) => Promise<boolean>;
  showStatus: (
    message: string,
    intent: "info" | "success" | "warning" | "error",
    durationMs?: number,
    options?: {
      actionLabel?: string;
      onAction?: () => void;
    },
  ) => void;
  previousPreferredRuntimeIdRef: MutableRefObject<string | null>;
  runtimeOfflineAlertRef: MutableRefObject<string | null>;
  autoEnsureHostedRef: MutableRefObject<boolean>;
  previousRuntimeProjectIdRef: MutableRefObject<string | null>;
  lastPreferredRuntimeIdRef: MutableRefObject<string | null>;
  preferenceClearRequestedRef: MutableRefObject<boolean>;
  latestReadyHostedRuntimeRef: MutableRefObject<{ projectId: string; runtimeId: string } | null>;
  pendingHostedRuntimeRecoveryRef: MutableRefObject<unknown>;
  setRuntimeEnsureError: (value: string | null) => void;
  setRuntimeEnsureLimit: (value: HostedRuntimeLimitErrorDetails | null) => void;
  setRuntimeStatusesResolved: (value: boolean) => void;
}

export function useHostedRuntimeProjectEffects({
  activeProjectId,
  projectReadyForRuntime,
  runtimeControllerEnabled,
  state,
  dispatch,
  runtimeReady,
  preferredPromptDismissed,
  setPreferredPromptDismissed,
  shouldPromptCloudFallback,
  resolvedPreferredRuntimeId,
  preferredRuntimeEntry,
  refreshRuntimeStatuses,
  setPreferredRuntime,
  showStatus,
  previousPreferredRuntimeIdRef,
  runtimeOfflineAlertRef,
  autoEnsureHostedRef,
  previousRuntimeProjectIdRef,
  lastPreferredRuntimeIdRef,
  preferenceClearRequestedRef,
  latestReadyHostedRuntimeRef,
  pendingHostedRuntimeRecoveryRef,
  setRuntimeEnsureError,
  setRuntimeEnsureLimit,
  setRuntimeStatusesResolved,
}: UseHostedRuntimeProjectEffectsArgs) {
  useLayoutEffect(() => {
    const normalizedProjectId = activeProjectId ?? null;
    if (previousRuntimeProjectIdRef.current === normalizedProjectId) {
      return;
    }
    previousRuntimeProjectIdRef.current = normalizedProjectId;
    // Opening a space is not a request for its machine, however it was
    // opened: at startup, from the switcher, a link or a Machines deep link.
    // The machine waits for intent there (the composer, a send, a Start).
    // This has to be the layout effect: a switch can commit the new space
    // while access still reads ready from the old one, and the auto-start
    // effects run in that same commit.
    markRestoredAwaitingIntent(normalizedProjectId);
    lastPreferredRuntimeIdRef.current = null;
    preferenceClearRequestedRef.current = false;
    dispatch({
      type: "setRuntimeStatuses",
      statuses: [],
      preferredRuntimeId: null,
    });
    dispatch({ type: "setSessionRuntime", runtimeId: null });
    setRuntimeStatusesResolved(false);
    autoEnsureHostedRef.current = false;
    latestReadyHostedRuntimeRef.current = null;
    pendingHostedRuntimeRecoveryRef.current = null;
    setRuntimeEnsureError(null);
    setRuntimeEnsureLimit(null);
  }, [
    activeProjectId,
    autoEnsureHostedRef,
    dispatch,
    lastPreferredRuntimeIdRef,
    latestReadyHostedRuntimeRef,
    pendingHostedRuntimeRecoveryRef,
    preferenceClearRequestedRef,
    previousRuntimeProjectIdRef,
    setRuntimeEnsureError,
    setRuntimeEnsureLimit,
    setRuntimeStatusesResolved,
  ]);

  useEffect(() => {
    const previous = previousPreferredRuntimeIdRef.current;
    if (state.preferredRuntimeId === previous) {
      return;
    }
    previousPreferredRuntimeIdRef.current = state.preferredRuntimeId;
    setPreferredPromptDismissed(false);
    dispatch({ type: "setSessionRuntime", runtimeId: null });
  }, [dispatch, previousPreferredRuntimeIdRef, setPreferredPromptDismissed, state.preferredRuntimeId]);

  useEffect(() => {
    if (!state.sessionRuntimeId) {
      return;
    }
    const exists = state.runtimeStatuses.some(
      (entry) => entry.runtimeId === state.sessionRuntimeId,
    );
    if (!exists) {
      dispatch({ type: "setSessionRuntime", runtimeId: null });
    }
  }, [dispatch, state.runtimeStatuses, state.sessionRuntimeId]);

  useEffect(() => {
    if (!shouldPromptCloudFallback) {
      return;
    }
    if (!state.sessionRuntimeId) {
      return;
    }
    dispatch({ type: "setSessionRuntime", runtimeId: null });
  }, [dispatch, shouldPromptCloudFallback, state.sessionRuntimeId]);

  useEffect(() => {
    if (!preferredRuntimeEntry) {
      return;
    }
    if (preferredPromptDismissed && preferredRuntimeEntry.health !== "offline") {
      setPreferredPromptDismissed(false);
    }
  }, [preferredPromptDismissed, preferredRuntimeEntry, setPreferredPromptDismissed]);

  useEffect(() => {
    if (!runtimeControllerEnabled || !projectReadyForRuntime || !activeProjectId) {
      dispatch({
        type: "setRuntimeStatuses",
        statuses: [],
        preferredRuntimeId: null,
      });
      setRuntimeStatusesResolved(true);
      return;
    }
    setRuntimeStatusesResolved(false);
    void refreshRuntimeStatuses();
  }, [
    activeProjectId,
    dispatch,
    projectReadyForRuntime,
    refreshRuntimeStatuses,
    runtimeControllerEnabled,
    setRuntimeStatusesResolved,
  ]);

  useEffect(() => {
    if (!runtimeControllerEnabled) {
      runtimeOfflineAlertRef.current = null;
      return;
    }
    const preferredRuntimeId = resolvedPreferredRuntimeId;
    if (!preferredRuntimeId) {
      runtimeOfflineAlertRef.current = null;
      return;
    }
    const entry = state.runtimeStatuses.find(
      (runtime) => runtime.runtimeId === preferredRuntimeId,
    );
    if (!entry) {
      return;
    }
    if (entry.health === "offline") {
      if (runtimeOfflineAlertRef.current !== preferredRuntimeId) {
        runtimeOfflineAlertRef.current = preferredRuntimeId;
        showStatus(
          "Preferred runtime went offline. Switch back to Auto (best available)?",
          "warning",
          8000,
          {
            actionLabel: "Switch to auto",
            onAction: () => {
              void setPreferredRuntime(null);
            },
          },
        );
      }
    } else if (runtimeOfflineAlertRef.current === preferredRuntimeId) {
      runtimeOfflineAlertRef.current = null;
    }
  }, [
    resolvedPreferredRuntimeId,
    runtimeControllerEnabled,
    runtimeOfflineAlertRef,
    setPreferredRuntime,
    showStatus,
    state.runtimeStatuses,
  ]);

  useEffect(() => {
    if (!runtimeReady) {
      return;
    }
    const pendingRecovery = pendingHostedRuntimeRecoveryRef.current as
      | { projectId: string }
      | null;
    if (pendingRecovery?.projectId === activeProjectId) {
      pendingHostedRuntimeRecoveryRef.current = null;
    }
  }, [activeProjectId, pendingHostedRuntimeRecoveryRef, runtimeReady]);
}
