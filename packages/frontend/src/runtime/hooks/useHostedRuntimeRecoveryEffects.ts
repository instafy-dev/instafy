import { useEffect, useState, type MutableRefObject } from "react";
import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import {
  IDLE_PAUSE_CLEARED_EVENT,
  MANUAL_STOP_CHANGED_EVENT,
  isIdlePaused,
  isManualStopHeld,
} from "../idlePauseRegistry";
import {
  BROWSER_RUNTIME_CLAIM_CHANGED_EVENT,
  isBrowserRuntimeClaimActive,
} from "../browserRuntimeClaimRegistry";
import {
  shouldAttemptUnexpectedHostedRuntimeRecovery,
  shouldTrackHostedRuntimeLifecycleEvent,
  UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS,
  type HostedRuntimeLifecycleEventKind,
} from "../unexpectedHostedRuntimeRecovery";
import {
  resolveHostedStatusPollInterval,
  shouldAutoEnsureHostedForEmptyState,
  shouldAutoEnsureHostedForFallback,
  shouldAutoEnsurePreferredHostedRuntime,
  shouldPollHostedBootingRuntime,
} from "./hostedRuntimeRecoveryDecisions";

interface UseHostedRuntimeRecoveryEffectsArgs {
  activeProjectId: string | null;
  projectInitialized: boolean;
  projectAccessResolved: boolean;
  projectReadyForRuntime: boolean;
  runtimeControllerEnabled: boolean;
  runtimeStatuses: ControllerRuntimeStatusEntry[];
  runtimeReady: boolean;
  readyRuntimeCount: number;
  runtimeStatusesResolved: boolean;
  waitingForPreferredRuntime: boolean;
  preferredRuntimeEntry: ControllerRuntimeStatusEntry | null;
  hostedRuntimeEnsuring: boolean;
  hasHostedRuntimeInProgress: boolean;
  hasLocalRuntime: boolean;
  disableAutoRuntimeEnsure: boolean;
  resolvedPreferredRuntimeId: string | null;
  ensureHostedRuntime: () => Promise<boolean>;
  refreshRuntimeStatuses: () => Promise<void>;
  debugLog: (message: string, data?: unknown) => void;
  autoEnsureHostedRef: MutableRefObject<boolean>;
  pendingHostedPollTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  pendingHostedRuntimeRecoveryRef: MutableRefObject<{
    projectId: string;
    runtimeId: string | null;
    kind: HostedRuntimeLifecycleEventKind;
    at: number;
  } | null>;
  latestReadyHostedRuntimeRef: MutableRefObject<{
    projectId: string;
    runtimeId: string;
  } | null>;
}

export function useHostedRuntimeRecoveryEffects({
  activeProjectId,
  projectInitialized,
  projectAccessResolved,
  projectReadyForRuntime,
  runtimeControllerEnabled,
  runtimeStatuses,
  runtimeReady,
  readyRuntimeCount,
  runtimeStatusesResolved,
  waitingForPreferredRuntime,
  preferredRuntimeEntry,
  hostedRuntimeEnsuring,
  hasHostedRuntimeInProgress,
  hasLocalRuntime,
  disableAutoRuntimeEnsure,
  resolvedPreferredRuntimeId,
  ensureHostedRuntime,
  refreshRuntimeStatuses,
  debugLog,
  autoEnsureHostedRef,
  pendingHostedPollTimerRef,
  pendingHostedRuntimeRecoveryRef,
  latestReadyHostedRuntimeRef,
}: UseHostedRuntimeRecoveryEffectsArgs) {
  const [browserRuntimeClaimEpoch, setBrowserRuntimeClaimEpoch] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const bump = (event: Event) => {
      const custom = event as CustomEvent<{ projectId?: string | null }>;
      if (custom.detail?.projectId === activeProjectId) {
        setBrowserRuntimeClaimEpoch((epoch) => epoch + 1);
      }
    };
    window.addEventListener(BROWSER_RUNTIME_CLAIM_CHANGED_EVENT, bump);
    return () =>
      window.removeEventListener(BROWSER_RUNTIME_CLAIM_CHANGED_EVENT, bump);
  }, [activeProjectId]);
  const browserRuntimeClaimActive = isBrowserRuntimeClaimActive(activeProjectId);
  const suppressAutoRuntimeEnsure =
    disableAutoRuntimeEnsure || browserRuntimeClaimActive;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleRuntimeLifecycleEvent = (event: Event) => {
      const custom =
        event as CustomEvent<{
          projectId?: string | null;
          kind?: string | null;
          data?: Record<string, unknown> | null;
        }>;
      const kind = custom.detail?.kind;
      if (kind !== "origin.expired" && kind !== "runtime.stopped") {
        return;
      }
      const projectId =
        typeof custom.detail?.projectId === "string"
          ? custom.detail.projectId.trim()
          : "";
      if (!projectId || projectId !== activeProjectId) {
        return;
      }
      const reason =
        custom.detail?.data && typeof custom.detail.data.reason === "string"
          ? custom.detail.data.reason
          : null;
      if (!shouldTrackHostedRuntimeLifecycleEvent({ kind, projectId, reason })) {
        if (pendingHostedRuntimeRecoveryRef.current?.projectId === projectId) {
          pendingHostedRuntimeRecoveryRef.current = null;
        }
        return;
      }
      const lastReadyHosted = latestReadyHostedRuntimeRef.current;
      if (!lastReadyHosted || lastReadyHosted.projectId !== projectId) {
        return;
      }
      pendingHostedRuntimeRecoveryRef.current = {
        projectId,
        runtimeId: lastReadyHosted.runtimeId,
        kind,
        at: Date.now(),
      };
    };
    window.addEventListener(
      "instafy:runtime-lifecycle-event",
      handleRuntimeLifecycleEvent as EventListener,
    );
    return () => {
      window.removeEventListener(
        "instafy:runtime-lifecycle-event",
        handleRuntimeLifecycleEvent as EventListener,
      );
    };
  }, [activeProjectId, latestReadyHostedRuntimeRef, pendingHostedRuntimeRecoveryRef]);

  useEffect(() => {
    if (pendingHostedPollTimerRef.current) {
      clearTimeout(pendingHostedPollTimerRef.current);
      pendingHostedPollTimerRef.current = null;
    }
    if (
      shouldPollHostedBootingRuntime({
        runtimeControllerEnabled,
        activeProjectId,
        projectReadyForRuntime,
        runtimeStatuses,
        runtimeReady,
      })
    ) {
      pendingHostedPollTimerRef.current = setTimeout(() => {
        void refreshRuntimeStatuses();
      }, 3_000);
    }
    return () => {
      if (pendingHostedPollTimerRef.current) {
        clearTimeout(pendingHostedPollTimerRef.current);
        pendingHostedPollTimerRef.current = null;
      }
    };
  }, [
    activeProjectId,
    pendingHostedPollTimerRef,
    projectReadyForRuntime,
    refreshRuntimeStatuses,
    runtimeControllerEnabled,
    runtimeReady,
    runtimeStatuses,
  ]);

  useEffect(() => {
    if (browserRuntimeClaimActive) {
      return;
    }
    const pendingRecovery = pendingHostedRuntimeRecoveryRef.current;
    const recoveryAgeMs =
      pendingRecovery && pendingRecovery.projectId === activeProjectId
        ? Date.now() - pendingRecovery.at
        : null;
    if (
      !shouldAttemptUnexpectedHostedRuntimeRecovery({
        activeProjectId,
        runtimeControllerEnabled,
        projectReadyForRuntime,
        runtimeReady,
        hostedRuntimeEnsuring,
        hasHostedRuntimeInProgress,
        hasLocalRuntime,
        eventProjectId: pendingRecovery?.projectId ?? null,
        eventAgeMs: recoveryAgeMs,
      })
    ) {
      if (
        pendingRecovery &&
        typeof recoveryAgeMs === "number" &&
        recoveryAgeMs > UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS
      ) {
        pendingHostedRuntimeRecoveryRef.current = null;
      }
      return;
    }
    pendingHostedRuntimeRecoveryRef.current = null;
    if (autoEnsureHostedRef.current) {
      return;
    }
    autoEnsureHostedRef.current = true;
    debugLog("hosted-runtime:ensure-unexpected-loss-recovery", {
      projectId: activeProjectId,
      runtimeId: pendingRecovery?.runtimeId ?? null,
      kind: pendingRecovery?.kind ?? null,
      recoveryAgeMs,
    });
    void ensureHostedRuntime().catch(() => {
      autoEnsureHostedRef.current = false;
    });
  }, [
    activeProjectId,
    autoEnsureHostedRef,
    browserRuntimeClaimActive,
    browserRuntimeClaimEpoch,
    debugLog,
    ensureHostedRuntime,
    hasHostedRuntimeInProgress,
    hasLocalRuntime,
    hostedRuntimeEnsuring,
    pendingHostedRuntimeRecoveryRef,
    projectReadyForRuntime,
    runtimeControllerEnabled,
    runtimeReady,
  ]);

  // Re-evaluate the auto-ensure gate when an idle pause is cleared by user
  // interaction (the registry is module state, not reactive on its own).
  const [idlePauseEpoch, setIdlePauseEpoch] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const bump = () => setIdlePauseEpoch((epoch) => epoch + 1);
    window.addEventListener(IDLE_PAUSE_CLEARED_EVENT, bump);
    return () => window.removeEventListener(IDLE_PAUSE_CLEARED_EVENT, bump);
  }, []);

  // A deliberate Stop is the same kind of module-level hold, but it survives
  // pointer and keyboard activity; re-evaluate when it is set or lifted.
  const [manualStopEpoch, setManualStopEpoch] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const bump = (event: Event) => {
      const custom = event as CustomEvent<{ projectId?: string | null }>;
      if (custom.detail?.projectId === activeProjectId) {
        setManualStopEpoch((epoch) => epoch + 1);
      }
    };
    window.addEventListener(MANUAL_STOP_CHANGED_EVENT, bump);
    return () => window.removeEventListener(MANUAL_STOP_CHANGED_EVENT, bump);
  }, [activeProjectId]);
  const manualStopHeld = isManualStopHeld(activeProjectId);

  useEffect(() => {
    // A machine paused for inactivity must stay paused until the user comes
    // back — auto-ensure would otherwise undo every idle stop within seconds.
    if (isIdlePaused(activeProjectId)) {
      return;
    }
    if (
      !shouldAutoEnsureHostedForFallback({
        disableAutoRuntimeEnsure: suppressAutoRuntimeEnsure,
        manualStopHeld,
        projectReadyForRuntime,
        runtimeControllerEnabled,
        activeProjectId,
        runtimeReady,
        hasHostedRuntimeInProgress,
        hasLocalRuntime,
        preferredRuntimeId: resolvedPreferredRuntimeId,
        readyRuntimeCount,
        runtimeStatusesResolved,
      })
    ) {
      return;
    }
    if (autoEnsureHostedRef.current) {
      return;
    }
    autoEnsureHostedRef.current = true;
    void ensureHostedRuntime().catch(() => {
      autoEnsureHostedRef.current = false;
    });
  }, [
    activeProjectId,
    autoEnsureHostedRef,
    browserRuntimeClaimEpoch,
    ensureHostedRuntime,
    hasHostedRuntimeInProgress,
    hasLocalRuntime,
    idlePauseEpoch,
    manualStopEpoch,
    manualStopHeld,
    projectReadyForRuntime,
    resolvedPreferredRuntimeId,
    runtimeControllerEnabled,
    runtimeReady,
    readyRuntimeCount,
    runtimeStatuses,
    runtimeStatusesResolved,
    suppressAutoRuntimeEnsure,
  ]);

  useEffect(() => {
    if (runtimeReady || readyRuntimeCount > 0) {
      autoEnsureHostedRef.current = false;
    }
  }, [autoEnsureHostedRef, readyRuntimeCount, runtimeReady]);

  useEffect(() => {
    if (isIdlePaused(activeProjectId)) {
      return;
    }
    if (
      !shouldAutoEnsureHostedForEmptyState({
        disableAutoRuntimeEnsure: suppressAutoRuntimeEnsure,
        manualStopHeld,
        projectAccessResolved,
        runtimeControllerEnabled,
        activeProjectId,
        runtimeReady,
        runtimeStatusesResolved,
        hostedRuntimeEnsuring,
        hasHostedRuntimeInProgress,
        hasLocalRuntime,
        runtimeStatusCount: runtimeStatuses.length,
      })
    ) {
      return;
    }
    if (autoEnsureHostedRef.current) {
      return;
    }
    debugLog("hosted-runtime:ensure-fallback", {
      projectId: activeProjectId,
      runtimeStatusesResolved,
      statusCount: runtimeStatuses.length,
    });
    autoEnsureHostedRef.current = true;
    void ensureHostedRuntime().catch(() => {
      autoEnsureHostedRef.current = false;
    });
  }, [
    activeProjectId,
    autoEnsureHostedRef,
    debugLog,
    browserRuntimeClaimEpoch,
    ensureHostedRuntime,
    hasHostedRuntimeInProgress,
    hasLocalRuntime,
    hostedRuntimeEnsuring,
    manualStopEpoch,
    manualStopHeld,
    projectAccessResolved,
    projectInitialized,
    projectReadyForRuntime,
    runtimeControllerEnabled,
    runtimeReady,
    runtimeStatuses.length,
    runtimeStatusesResolved,
    suppressAutoRuntimeEnsure,
  ]);

  useEffect(() => {
    if (
      !shouldAutoEnsurePreferredHostedRuntime({
        disableAutoRuntimeEnsure: suppressAutoRuntimeEnsure,
        manualStopHeld,
        runtimeControllerEnabled,
        projectReadyForRuntime,
        activeProjectId,
        preferredRuntimeEntry,
        waitingForPreferredRuntime,
        hostedRuntimeEnsuring,
        hasHostedRuntimeInProgress,
      })
    ) {
      return;
    }
    if (autoEnsureHostedRef.current) {
      return;
    }
    debugLog("hosted-runtime:ensure-preferred-recovery", {
      projectId: activeProjectId,
      runtimeId: preferredRuntimeEntry?.runtimeId,
      status: preferredRuntimeEntry?.status,
      health: preferredRuntimeEntry?.health,
    });
    autoEnsureHostedRef.current = true;
    void ensureHostedRuntime().catch(() => {
      autoEnsureHostedRef.current = false;
    });
  }, [
    activeProjectId,
    autoEnsureHostedRef,
    debugLog,
    browserRuntimeClaimEpoch,
    ensureHostedRuntime,
    hasHostedRuntimeInProgress,
    hostedRuntimeEnsuring,
    manualStopEpoch,
    manualStopHeld,
    preferredRuntimeEntry,
    projectReadyForRuntime,
    runtimeControllerEnabled,
    waitingForPreferredRuntime,
    suppressAutoRuntimeEnsure,
  ]);

  useEffect(() => {
    if (!waitingForPreferredRuntime) {
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const steadyPollMs = resolveHostedStatusPollInterval({
      hostedRuntimeEnsuring,
      hasHostedRuntimeInProgress,
      waitingForPreferredRuntime,
    });
    const pollStatuses = async () => {
      if (cancelled) {
        return;
      }
      try {
        await refreshRuntimeStatuses();
      } finally {
        if (!cancelled) {
          timeoutId = setTimeout(pollStatuses, steadyPollMs);
        }
      }
    };
    timeoutId = setTimeout(pollStatuses, 0);
    return () => {
      cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [
    hasHostedRuntimeInProgress,
    hostedRuntimeEnsuring,
    refreshRuntimeStatuses,
    waitingForPreferredRuntime,
  ]);
}
