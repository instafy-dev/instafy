import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import type { RunRecord } from "../../types";
import {
  IDLE_PAUSE_CLEARED_EVENT,
  MANUAL_STOP_CHANGED_EVENT,
  idlePausedAt,
  isIdlePaused,
  isManualStopHeld,
  isRestoredAwaitingIntent,
  manualStopHold,
  markIdlePaused,
  markManualStop,
  personStopsSupersededAtMs,
} from "../idlePauseRegistry";
import {
  BROWSER_RUNTIME_CLAIM_CHANGED_EVENT,
  isBrowserRuntimeClaimActive,
} from "../browserRuntimeClaimRegistry";
import {
  isRuntimeLimitReclaimStopReason,
  latestPersonInterruptionAtMs,
  resolveRuntimeStopHold,
  shouldAttemptUnexpectedHostedRuntimeRecovery,
  shouldTrackHostedRuntimeLifecycleEvent,
  UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS,
  type HostedRuntimeLifecycleEventKind,
} from "../unexpectedHostedRuntimeRecovery";
import {
  isHostedRuntime,
  latestHostedLaunchRequestedAtMs,
  runtimeEntryIsReady,
} from "../utils/runtimeEntry";
import {
  resolveHostedStatusPollInterval,
  shouldAutoEnsureHostedForEmptyState,
  shouldAutoEnsureHostedForFallback,
  shouldAutoEnsurePreferredHostedRuntime,
  shouldPollHostedBootingRuntime,
} from "./hostedRuntimeRecoveryDecisions";
import { stopLeavesNoLiveHostedRuntime } from "./manualStopDecisions";
import type { EnsureHostedRuntimeOptions } from "./useHostedRuntimeEnsure";

/** How long a lost machine's start waits on its read of the space's runs. */
export const LOSS_RUNS_READ_TIMEOUT_MS = 10_000;

/** When this tab last saw a hosted machine in `projectId` come up, on its own clock. */
interface HostedReadySince {
  projectId: string | null;
  ready: boolean;
  at: number | null;
}

/**
 * Whether a hold set at `heldAtMs` came after this tab last saw a hosted
 * machine in `projectId` come up, so it stands for a stop of that machine.
 */
function heldSinceHostedReady(seen: HostedReadySince, projectId: string, heldAtMs: number): boolean {
  const readySinceMs = seen.projectId === projectId ? seen.at : null;
  return readySinceMs === null || heldAtMs >= readySinceMs;
}

/** The runs `fetchRuns` reads, or null when the read fails or takes too long. */
function readRunsWithin(
  fetchRuns: (projectId: string) => Promise<readonly RunRecord[]>,
  projectId: string,
): Promise<readonly RunRecord[] | null> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => resolve(null), LOSS_RUNS_READ_TIMEOUT_MS);
    const settle = (runs: readonly RunRecord[] | null) => {
      clearTimeout(timeoutId);
      resolve(runs);
    };
    fetchRuns(projectId).then(settle, () => settle(null));
  });
}

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
  /** A queued message or open turn of this client in the active space. */
  hasPendingProjectWork?: boolean;
  /** The runs this client knows, to tell a person's stop from a lost machine. */
  runs?: Record<string, RunRecord> | null;
  /**
   * The space's runs as the controller has them now (GET /runs). Read once
   * before a lost machine is started again, since this tab may not have
   * heard of the stop that took it.
   */
  fetchProjectRuns?: (projectId: string) => Promise<readonly RunRecord[]>;
  disableAutoRuntimeEnsure: boolean;
  resolvedPreferredRuntimeId: string | null;
  ensureHostedRuntime: (options?: EnsureHostedRuntimeOptions) => Promise<boolean>;
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
  hasPendingProjectWork = false,
  runs = null,
  fetchProjectRuns,
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
  // Read by the lifecycle listener at event time, without re-subscribing it
  // whenever a run changes.
  const hasPendingProjectWorkRef = useRef(hasPendingProjectWork);
  useEffect(() => {
    hasPendingProjectWorkRef.current = hasPendingProjectWork;
  }, [hasPendingProjectWork]);
  const runtimeStatusesRef = useRef(runtimeStatuses);
  useEffect(() => {
    runtimeStatusesRef.current = runtimeStatuses;
  }, [runtimeStatuses]);
  // Read again when a read of the runs for an automatic start settles.
  const runsRef = useRef(runs);
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);
  const fetchProjectRunsRef = useRef(fetchProjectRuns);
  useEffect(() => {
    fetchProjectRunsRef.current = fetchProjectRuns;
  }, [fetchProjectRuns]);
  const activeProjectIdRef = useRef(activeProjectId);
  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);
  const machineReadyRef = useRef(runtimeReady || readyRuntimeCount > 0);
  useEffect(() => {
    machineReadyRef.current = runtimeReady || readyRuntimeCount > 0;
  }, [readyRuntimeCount, runtimeReady]);
  // When this tab last saw a hosted machine in the active space come up, on
  // its own clock. The rising edge, not the latest status that read ready: a
  // refresh that lands after a Stop, before the machine goes, would otherwise
  // date the machine after the Stop.
  const hostedReady = useMemo(
    () =>
      runtimeStatuses.some(
        (entry) => Boolean(entry) && isHostedRuntime(entry) && runtimeEntryIsReady(entry),
      ),
    [runtimeStatuses],
  );
  const hostedReadySinceRef = useRef<HostedReadySince>({
    projectId: null,
    ready: false,
    at: null,
  });
  useEffect(() => {
    const seen = hostedReadySinceRef.current;
    const sameSpace = seen.projectId === activeProjectId;
    let at = sameSpace ? seen.at : null;
    if (hostedReady && !(sameSpace && seen.ready)) {
      at = Date.now();
    }
    hostedReadySinceRef.current = { projectId: activeProjectId, ready: hostedReady, at };
  }, [activeProjectId, hostedReady]);
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

  // Whether a hold stands for the loss of the space's machine: this tab's
  // Stop or Remove, a stop the controller reported, or an idle pause, set
  // since this tab last saw a hosted machine come up. A hold outlives a
  // machine that came back without asking through this tab (a send from
  // another tab or device, a teammate's Start); that machine's loss is no
  // stop of anyone's, and is recovered as before.
  const holdCoversLoss = useCallback((projectId: string | null) => {
    if (!projectId) {
      return false;
    }
    const heldAtMs = Math.max(
      manualStopHold(projectId)?.at ?? Number.NEGATIVE_INFINITY,
      idlePausedAt(projectId) ?? Number.NEGATIVE_INFINITY,
    );
    if (heldAtMs === Number.NEGATIVE_INFINITY) {
      return false;
    }
    return heldSinceHostedReady(hostedReadySinceRef.current, projectId, heldAtMs);
  }, []);

  // A turn a person's stop put back in the queue in `projectId` holds the
  // space as that Stop does in its own tab, when it leaves no live hosted
  // machine there. True when there is such a turn: no machine is asked for.
  // The turn stays queued until a new machine takes it, so a stop no longer
  // counts once someone asked for a machine after it: in this tab
  // (personStopsSupersededAtMs), or anywhere, as a hosted launch the status
  // reports shows.
  const holdForPersonStop = useCallback(
    (
      projectId: string,
      knownRuns: Record<string, RunRecord> | readonly RunRecord[] | null | undefined,
      lostRuntimeId: string | null,
    ) => {
      const stoppedAtMs = latestPersonInterruptionAtMs(knownRuns, projectId, Date.now(), {
        supersededAtMs: personStopsSupersededAtMs(projectId),
        launchRequestedAtMs: latestHostedLaunchRequestedAtMs(runtimeStatusesRef.current),
      });
      if (stoppedAtMs === null) {
        return false;
      }
      if (stopLeavesNoLiveHostedRuntime(runtimeStatusesRef.current, lostRuntimeId ?? "")) {
        markManualStop(projectId);
      }
      debugLog("hosted-runtime:auto-ensure-held-for-person-stop", {
        projectId,
        runtimeId: lostRuntimeId,
      });
      return true;
    },
    [debugLog],
  );

  // Every automatic start below goes through here, after its own gate.
  // ensureHostedRuntime lifts every hold, as only a person's Start, Send,
  // Reconnect or Try again may, so the holds are read once more right before
  // it: one set after a gate read them (this tab's Stop, a stop the
  // controller reported) wins. So does a person's stop the runs record. For
  // a lost machine only a hold set since it came up counts (holdCoversLoss).
  const ensureHostedRuntimeAutomatically = useCallback(
    (projectId: string | null, loss?: { runtimeId: string | null }) => {
      const held = (id: string) =>
        loss ? holdCoversLoss(id) : isManualStopHeld(id) || isIdlePaused(id);
      if (!projectId || held(projectId)) {
        return;
      }
      const lostRuntimeId = loss?.runtimeId ?? null;
      if (holdForPersonStop(projectId, runsRef.current, lostRuntimeId)) {
        return;
      }
      autoEnsureHostedRef.current = true;
      const start = async () => {
        const fetchRuns = fetchProjectRunsRef.current;
        if (loss && fetchRuns) {
          // A Stop, Remove or takeover made in another tab or device reaches
          // this one only as the machine going away: the controller publishes
          // no runtime.stopped for it, and announces the turn it cut off only
          // after the provider's release. The runs hold that record from the
          // moment of the stop, so they are read once. A read that fails or
          // takes too long (the client also answers a failure with no runs)
          // finds no stop, and the machine starts as it did before this read.
          // That is the safer side: the tab that pressed Stop keeps its own
          // hold, so only a stop made elsewhere is at risk, while refusing
          // would leave a machine that was really lost, and its turn, waiting
          // with nothing on screen to say why.
          const fetched = await readRunsWithin(fetchRuns, projectId);
          if (activeProjectIdRef.current !== projectId || machineReadyRef.current) {
            // A switch dropped this loss, or a machine came up meanwhile;
            // either reset the automatic start.
            return;
          }
          if (
            held(projectId) ||
            holdForPersonStop(projectId, fetched, lostRuntimeId) ||
            holdForPersonStop(projectId, runsRef.current, lostRuntimeId)
          ) {
            autoEnsureHostedRef.current = false;
            return;
          }
        }
        await ensureHostedRuntime();
      };
      void start().catch(() => {
        autoEnsureHostedRef.current = false;
      });
    },
    [autoEnsureHostedRef, ensureHostedRuntime, holdCoversLoss, holdForPersonStop],
  );

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
      const reclaimStop =
        kind === "runtime.stopped" && isRuntimeLimitReclaimStopReason(reason);
      const queuedJobCount =
        custom.detail?.data && typeof custom.detail.data.queuedJobCount === "number"
          ? custom.detail.data.queuedJobCount
          : 0;
      // Work the controller says is queued in the stopped space (typically
      // what the stop requeued) counts as this space's own, even before this
      // client has heard about the run.
      const hasPendingWork = hasPendingProjectWorkRef.current || queuedJobCount > 0;
      if (!shouldTrackHostedRuntimeLifecycleEvent({ kind, projectId, reason, hasPendingWork })) {
        if (pendingHostedRuntimeRecoveryRef.current?.projectId === projectId) {
          pendingHostedRuntimeRecoveryRef.current = null;
        }
        if (reclaimStop) {
          // The machine was idle and another space in the team needed the
          // slot. Hold every auto-ensure path the way an idle pause does, so
          // this tab does not take the slot straight back; writing in the
          // chat (or Send, or Start) wakes it as usual.
          markIdlePaused(projectId);
          debugLog("hosted-runtime:reclaimed-for-waiting-space", { projectId });
          return;
        }
        // A stop this tab did not make. Without a hold it would see no ready
        // machine and start it again. The platform stops (credits_exhausted,
        // oom_killed) arrive here today. A Stop, Remove or takeover made in
        // another tab or device does not yet: the controller records those
        // without publishing runtime.stopped, so until it does the automatic
        // starts find such a stop by the turn it put back in the queue, and
        // a stop of a machine with no turn can still be undone elsewhere.
        const hold = resolveRuntimeStopHold(reason);
        if (hold === "manual_stop") {
          // Only the last live hosted machine means "no machine", as in the
          // tab that pressed Stop.
          const runtimeId =
            custom.detail?.data && typeof custom.detail.data.runtimeId === "string"
              ? custom.detail.data.runtimeId
              : "";
          // Once the controller reports a person's stop, this tab's own Stop
          // may be the one reported, before its request answers. Its hold is
          // kept as it is: a new one would drop that answer
          // (recordManualStopFlush). A hold older than the machine that was
          // stopped stands for an earlier stop and is set anew.
          const heldHere = manualStopHold(projectId);
          const heldForThisStop =
            heldHere !== null &&
            heldSinceHostedReady(hostedReadySinceRef.current, projectId, heldHere.at);
          if (
            !heldForThisStop &&
            stopLeavesNoLiveHostedRuntime(runtimeStatusesRef.current, runtimeId)
          ) {
            markManualStop(projectId);
          }
        } else if (hold === "idle_pause") {
          markIdlePaused(projectId);
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
  }, [activeProjectId, debugLog, latestReadyHostedRuntimeRef, pendingHostedRuntimeRecoveryRef]);

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
    // A stop someone chose holds the space: this tab's Stop or Remove, or a
    // stop the controller reported. The machine it takes away is no loss to
    // recover, whether the stop or the loss reached this tab first, and a
    // recovery would lift the hold and start the machine again. A hold older
    // than the machine that was lost is not that machine's stop.
    const stopHeld = holdCoversLoss(activeProjectId);
    if (
      !shouldAttemptUnexpectedHostedRuntimeRecovery({
        activeProjectId,
        runtimeControllerEnabled,
        projectReadyForRuntime,
        runtimeReady,
        hostedRuntimeEnsuring,
        hasHostedRuntimeInProgress,
        hasLocalRuntime,
        stopHeld,
        eventProjectId: pendingRecovery?.projectId ?? null,
        eventAgeMs: recoveryAgeMs,
      })
    ) {
      if (
        pendingRecovery &&
        typeof recoveryAgeMs === "number" &&
        (stopHeld || recoveryAgeMs > UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS)
      ) {
        if (stopHeld) {
          debugLog("hosted-runtime:unexpected-loss-held", {
            projectId: activeProjectId,
            kind: pendingRecovery.kind,
          });
        }
        pendingHostedRuntimeRecoveryRef.current = null;
      }
      return;
    }
    pendingHostedRuntimeRecoveryRef.current = null;
    if (autoEnsureHostedRef.current) {
      return;
    }
    debugLog("hosted-runtime:ensure-unexpected-loss-recovery", {
      projectId: activeProjectId,
      runtimeId: pendingRecovery?.runtimeId ?? null,
      kind: pendingRecovery?.kind ?? null,
      recoveryAgeMs,
    });
    ensureHostedRuntimeAutomatically(activeProjectId, {
      runtimeId: pendingRecovery?.runtimeId ?? null,
    });
  }, [
    activeProjectId,
    autoEnsureHostedRef,
    browserRuntimeClaimActive,
    browserRuntimeClaimEpoch,
    debugLog,
    ensureHostedRuntimeAutomatically,
    hasHostedRuntimeInProgress,
    hasLocalRuntime,
    holdCoversLoss,
    hostedRuntimeEnsuring,
    pendingHostedRuntimeRecoveryRef,
    projectReadyForRuntime,
    runtimeControllerEnabled,
    runtimeReady,
  ]);

  // Re-evaluate the auto-ensure gate when an idle pause or the wait for
  // intent is lifted (the registry is module state, not reactive on its own).
  const [idlePauseEpoch, setIdlePauseEpoch] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const bump = () => setIdlePauseEpoch((epoch) => epoch + 1);
    window.addEventListener(IDLE_PAUSE_CLEARED_EVENT, bump);
    return () => window.removeEventListener(IDLE_PAUSE_CLEARED_EVENT, bump);
  }, []);

  // A deliberate Stop is the same kind of module-level hold, but writing in
  // the composer does not lift it; re-evaluate when it is set or lifted.
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
    // Every space waits for intent the same way each time it is opened.
    if (isIdlePaused(activeProjectId) || isRestoredAwaitingIntent(activeProjectId)) {
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
    ensureHostedRuntimeAutomatically(activeProjectId);
  }, [
    activeProjectId,
    autoEnsureHostedRef,
    browserRuntimeClaimEpoch,
    ensureHostedRuntimeAutomatically,
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
    if (isIdlePaused(activeProjectId) || isRestoredAwaitingIntent(activeProjectId)) {
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
    ensureHostedRuntimeAutomatically(activeProjectId);
  }, [
    activeProjectId,
    autoEnsureHostedRef,
    debugLog,
    browserRuntimeClaimEpoch,
    ensureHostedRuntimeAutomatically,
    hasHostedRuntimeInProgress,
    hasLocalRuntime,
    hostedRuntimeEnsuring,
    idlePauseEpoch,
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
    // A paused machine (idle, or handed to a space waiting on the team's
    // runtime limit) stays paused even when it is the preferred runtime.
    if (isIdlePaused(activeProjectId) || isRestoredAwaitingIntent(activeProjectId)) {
      return;
    }
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
    ensureHostedRuntimeAutomatically(activeProjectId);
  }, [
    activeProjectId,
    autoEnsureHostedRef,
    debugLog,
    browserRuntimeClaimEpoch,
    ensureHostedRuntimeAutomatically,
    hasHostedRuntimeInProgress,
    hostedRuntimeEnsuring,
    idlePauseEpoch,
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
