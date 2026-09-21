import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
} from "react";
import { controllerClient, type ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import { ControllerApiError } from "../../services/runtimeController/core";
import type { RuntimeAction, RuntimeStoreState } from "../runtimeStore";
import {
  HostedRuntimeBlockerSpaceError,
  parseHostedRuntimeLimitError,
  type HostedRuntimeLimitErrorDetails,
} from "../hostedRuntimeLimitError";
import { clearManualStop, markManualStop } from "../idlePauseRegistry";
import {
  resolveEffectiveRuntimeSelection,
  resolveHasLocalRuntime,
  resolveLastReadyHostedRuntime,
  resolvePreferredRuntimeEntry,
  resolveReadyRuntimeEntries,
  resolveRecommendedCloudRuntime,
  resolveRuntimeReady,
  resolveSelectedLocalRuntimeId,
  resolveSessionRuntimeEntry,
  resolveShouldPromptCloudFallback,
  resolveWaitingForPreferredRuntime,
} from "./hostedRuntimePolicySelectors";

interface UseHostedRuntimeSelectionStateArgs {
  activeProjectId: string | null;
  state: RuntimeStoreState;
  dispatch: Dispatch<RuntimeAction>;
  runtimeEnsureError: string | null;
  runtimeEnsureLimit: HostedRuntimeLimitErrorDetails | null;
  refreshRuntimeStatuses: () => Promise<void>;
  ensureHostedRuntime: () => Promise<boolean>;
  /**
   * Limit details of the latest ensure failure, written by the ensure hook
   * before it resolves. The `runtimeEnsureLimit` prop lags behind it by a
   * render, so it cannot tell what the retried ensure inside a takeover hit.
   */
  lastHostedEnsureLimitRef: MutableRefObject<HostedRuntimeLimitErrorDetails | null>;
}

export interface HostedRuntimeSelectionState {
  preferredPromptDismissed: boolean;
  setPreferredPromptDismissed: (value: boolean) => void;
  hostedRuntimeTakeoverInProgress: boolean;
  setSessionRuntimeOverride: (runtimeId: string | null) => void;
  clearSessionRuntimeOverride: () => void;
  dismissPreferredRuntimePrompt: () => void;
  takeOverHostedRuntimeLimit: () => Promise<boolean>;
  preferredRuntimeEntry: ControllerRuntimeStatusEntry | null;
  sessionRuntimeEntry: ControllerRuntimeStatusEntry | null;
  readyRuntimeEntries: ControllerRuntimeStatusEntry[];
  recommendedCloudRuntimeId: string | null;
  waitingForPreferredRuntime: boolean;
  effectiveRuntimeId: string | null;
  effectiveRuntimeSource: "session" | "preference" | "auto";
  runtimeReady: boolean;
  readyRuntimeCount: number;
  hasLocalRuntime: boolean;
  selectedLocalRuntimeId: string | null;
  disableAutoRuntimeEnsure: boolean;
  shouldPromptCloudFallback: boolean;
  resolvedPreferredRuntimeId: string | null;
  latestReadyHostedRuntime: { projectId: string; runtimeId: string } | null;
}

export function useHostedRuntimeSelectionState({
  activeProjectId,
  state,
  dispatch,
  runtimeEnsureError,
  runtimeEnsureLimit,
  refreshRuntimeStatuses,
  ensureHostedRuntime,
  lastHostedEnsureLimitRef,
}: UseHostedRuntimeSelectionStateArgs): HostedRuntimeSelectionState {
  const [preferredPromptDismissed, setPreferredPromptDismissed] = useState(false);
  const [hostedRuntimeTakeoverInProgress, setHostedRuntimeTakeoverInProgress] = useState(false);
  const lastReadyHostedRuntimeRef = useRef<{ projectId: string; runtimeId: string } | null>(null);

  const setSessionRuntimeOverride = useCallback(
    (runtimeId: string | null) => {
      dispatch({ type: "setSessionRuntime", runtimeId });
      if (runtimeId !== null) {
        setPreferredPromptDismissed(true);
      }
    },
    [dispatch],
  );

  const clearSessionRuntimeOverride = useCallback(() => {
    dispatch({ type: "setSessionRuntime", runtimeId: null });
  }, [dispatch]);

  const dismissPreferredRuntimePrompt = useCallback(() => {
    setPreferredPromptDismissed(true);
  }, []);

  const runtimeStatuses = state.runtimeStatuses;
  const resolvedPreferredRuntimeId = state.preferredRuntimeId ?? null;
  const sessionRuntimeId = state.sessionRuntimeId;

  const preferredRuntimeEntry = useMemo(
    () => resolvePreferredRuntimeEntry(runtimeStatuses, resolvedPreferredRuntimeId),
    [resolvedPreferredRuntimeId, runtimeStatuses],
  );
  const sessionRuntimeEntry = useMemo(
    () => resolveSessionRuntimeEntry(runtimeStatuses, sessionRuntimeId),
    [runtimeStatuses, sessionRuntimeId],
  );
  const readyRuntimeEntries = useMemo(
    () => resolveReadyRuntimeEntries(runtimeStatuses),
    [runtimeStatuses],
  );
  const recommendedCloudRuntime = useMemo(
    () => resolveRecommendedCloudRuntime(readyRuntimeEntries),
    [readyRuntimeEntries],
  );
  const waitingForPreferredRuntime = useMemo(
    () =>
      resolveWaitingForPreferredRuntime({
        preferredRuntimeId: resolvedPreferredRuntimeId,
        sessionRuntimeId,
        preferredRuntimeEntry,
      }),
    [preferredRuntimeEntry, resolvedPreferredRuntimeId, sessionRuntimeId],
  );
  const { effectiveRuntimeId, effectiveRuntimeSource } = useMemo(
    () =>
      resolveEffectiveRuntimeSelection({
        sessionRuntimeId,
        preferredRuntimeId: resolvedPreferredRuntimeId,
      }),
    [resolvedPreferredRuntimeId, sessionRuntimeId],
  );
  const runtimeReady = useMemo(
    () =>
      resolveRuntimeReady({
        waitingForPreferredRuntime,
        effectiveRuntimeSource,
        sessionRuntimeEntry,
        preferredRuntimeEntry,
        readyRuntimeEntries,
      }),
    [
      effectiveRuntimeSource,
      preferredRuntimeEntry,
      readyRuntimeEntries,
      sessionRuntimeEntry,
      waitingForPreferredRuntime,
    ],
  );
  const readyRuntimeCount = readyRuntimeEntries.length;
  const hasLocalRuntime = useMemo(
    () => resolveHasLocalRuntime(runtimeStatuses),
    [runtimeStatuses],
  );
  const selectedLocalRuntimeId = useMemo(
    () =>
      resolveSelectedLocalRuntimeId({
        sessionRuntimeEntry,
        preferredRuntimeEntry,
      }),
    [preferredRuntimeEntry, sessionRuntimeEntry],
  );
  const disableAutoRuntimeEnsure = useMemo(() => {
    if ((import.meta.env.VITE_DISABLE_AUTO_RUNTIME_ENSURE ?? "").trim() === "1") {
      return true;
    }
    if (typeof window === "undefined") {
      return false;
    }
    const nativePlatform =
      (window as typeof window & {
        Capacitor?: { isNativePlatform?: () => boolean };
      }).Capacitor?.isNativePlatform?.() ?? false;
    return nativePlatform;
  }, []);
  const shouldPromptCloudFallback = useMemo(
    () =>
      resolveShouldPromptCloudFallback({
        preferredPromptDismissed,
        sessionRuntimeId,
        waitingForPreferredRuntime,
        runtimeReady,
        readyRuntimeCount,
        preferredRuntimeId: resolvedPreferredRuntimeId,
        hasLocalRuntime,
      }),
    [
      hasLocalRuntime,
      preferredPromptDismissed,
      readyRuntimeCount,
      resolvedPreferredRuntimeId,
      runtimeReady,
      sessionRuntimeId,
      waitingForPreferredRuntime,
    ],
  );

  useEffect(() => {
    lastReadyHostedRuntimeRef.current = resolveLastReadyHostedRuntime({
      activeProjectId,
      sessionRuntimeEntry,
      preferredRuntimeEntry,
      readyRuntimeEntries,
    });
  }, [activeProjectId, preferredRuntimeEntry, readyRuntimeEntries, sessionRuntimeEntry]);

  const takeOverHostedRuntimeLimit = useCallback(async () => {
    const limitDetails = parseHostedRuntimeLimitError(
      runtimeEnsureError,
      runtimeEnsureLimit,
    );
    const blockerRuntimeId = limitDetails.blockerRuntimeId;
    if (!blockerRuntimeId) {
      throw new Error("No blocking runtime was found in the current limit error.");
    }
    if (hostedRuntimeTakeoverInProgress) {
      return false;
    }

    setHostedRuntimeTakeoverInProgress(true);
    // The blocker's own space must not relaunch it the moment this tab (or
    // the user) looks at it. The current project is not held: the user is
    // asking for its machine.
    const blockerProjectId = limitDetails.blockerProjectId;
    markManualStop(blockerProjectId);
    try {
      let stopRefused = false;
      try {
        await controllerClient.runtimes.stop({
          runtimeId: blockerRuntimeId,
          reason: "runtime_limit_takeover",
        });
      } catch (error) {
        clearManualStop(blockerProjectId);
        // 409: the controller found nothing left to release on that runtime
        // (its lease was already detached). The blocker details we hold may
        // be stale, so refresh and try the ensure anyway instead of giving up.
        if (!(error instanceof ControllerApiError && error.status === 409)) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(message);
        }
        stopRefused = true;
      }
      await refreshRuntimeStatuses();
      const ensured = await ensureHostedRuntime();
      if (!ensured && stopRefused) {
        // Only a repeated limit means the blocker is still in the way. Any
        // other failure (credits, capacity, provider) is already reported by
        // the ensure itself, so a plain false is the right answer for it.
        const retriedLimit = lastHostedEnsureLimitRef.current;
        if (retriedLimit?.limitReached) {
          // The retried ensure names the machine that blocks right now; fall
          // back to the original details when the controller omitted it.
          throw new HostedRuntimeBlockerSpaceError(
            retriedLimit.blockerProjectId ? retriedLimit : limitDetails,
          );
        }
      }
      return ensured;
    } finally {
      setHostedRuntimeTakeoverInProgress(false);
    }
  }, [
    ensureHostedRuntime,
    hostedRuntimeTakeoverInProgress,
    lastHostedEnsureLimitRef,
    refreshRuntimeStatuses,
    runtimeEnsureError,
    runtimeEnsureLimit,
  ]);

  return {
    preferredPromptDismissed,
    setPreferredPromptDismissed,
    hostedRuntimeTakeoverInProgress,
    setSessionRuntimeOverride,
    clearSessionRuntimeOverride,
    dismissPreferredRuntimePrompt,
    takeOverHostedRuntimeLimit,
    preferredRuntimeEntry,
    sessionRuntimeEntry,
    readyRuntimeEntries,
    recommendedCloudRuntimeId: recommendedCloudRuntime?.runtimeId ?? null,
    waitingForPreferredRuntime,
    effectiveRuntimeId,
    effectiveRuntimeSource,
    runtimeReady,
    readyRuntimeCount,
    hasLocalRuntime,
    selectedLocalRuntimeId,
    disableAutoRuntimeEnsure,
    shouldPromptCloudFallback,
    resolvedPreferredRuntimeId,
    latestReadyHostedRuntime: lastReadyHostedRuntimeRef.current,
  };
}
