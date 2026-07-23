import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import { controllerClient, type ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import type { RuntimeAction, RuntimeStoreState } from "../runtimeStore";
import {
  parseHostedRuntimeLimitError,
  type HostedRuntimeLimitErrorDetails,
} from "../hostedRuntimeLimitError";
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
    try {
      await controllerClient.runtimes.stop({
        runtimeId: blockerRuntimeId,
        reason: "runtime_limit_takeover",
      });
      await refreshRuntimeStatuses();
      return await ensureHostedRuntime();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    } finally {
      setHostedRuntimeTakeoverInProgress(false);
    }
  }, [
    ensureHostedRuntime,
    hostedRuntimeTakeoverInProgress,
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
