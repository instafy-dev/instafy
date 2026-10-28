import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  controllerClient,
  type RuntimeSharedBrowserApprovalDecision,
  type RuntimeSharedBrowserApprovalRequest,
  type RuntimeSharedBrowserPendingApproval,
} from "../../../sdk/instafy";
import { adaptivePollDelay, pollingGateState, subscribePollingGate } from "../../../runtime/pollingGate";

const APPROVAL_IDLE_POLL_INTERVAL_MS = 1_500;
const APPROVAL_PENDING_POLL_INTERVAL_MS = 400;
// Every prompt carries a runId and is raised only inside a run, so with no
// run in the space the lane only keeps a slow safety read.
export const APPROVAL_QUIET_POLL_INTERVAL_MS = 15_000;
export const APPROVAL_QUIET_IDLE_POLL_INTERVAL_MS = 30_000;
/**
 * The fewest milliseconds between two reads of a prompt lane, also when it
 * stops and starts again or comes back to a page or grant it read recently:
 * inputs that flip quickly, or a page that changes back and forth, cannot
 * turn it into a read per flip. A page or grant it has not read yet reads at
 * once.
 */
export const APPROVAL_MIN_READ_GAP_MS = APPROVAL_PENDING_POLL_INTERVAL_MS;
/** How many lanes count as read recently for {@link APPROVAL_MIN_READ_GAP_MS}. */
const APPROVAL_RECENT_LANES = 8;
/** Reads that fail in a row wait twice as long each time, up to this. */
export const APPROVAL_FAILURE_MAX_POLL_INTERVAL_MS = 10_000;
/**
 * How long reads must keep failing before the prompt says the connection was
 * interrupted. One failed read between good ones says nothing.
 */
export const APPROVAL_INTERRUPTED_GRACE_MS = 2_000;
export const APPROVAL_INTERRUPTED_MESSAGE = "Approval connection interrupted. Reconnecting…";

/** A decision the origin accepted. */
export type SharedBrowserApprovalSettlement = {
  approvalId: string;
  decision: RuntimeSharedBrowserApprovalDecision;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useSharedBrowserApproval({
  active,
  projectId,
  browserSessionId,
  runtimeId,
  browserPageId,
  originEndpoint,
  originAccessToken,
  acceptsRequest,
  runActive = true,
}: {
  active: boolean;
  projectId: string | null;
  browserSessionId: string;
  runtimeId: string | null;
  browserPageId: string | null;
  originEndpoint: string | null;
  originAccessToken: string | null;
  /** Which polled prompts a caller may answer here; every prompt when absent. */
  acceptsRequest?: (request: RuntimeSharedBrowserApprovalRequest) => boolean;
  /** A run that may raise a prompt is active: poll every 1.5 s. Defaults to true. */
  runActive?: boolean;
}) {
  const [pending, setPending] = useState<RuntimeSharedBrowserPendingApproval | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routineApprovedRunId, setRoutineApprovedRunId] = useState<string | null>(null);
  const [lastDecision, setLastDecision] = useState<SharedBrowserApprovalSettlement | null>(null);
  const submittingRef = useRef(false);
  const pendingRef = useRef<RuntimeSharedBrowserPendingApproval | null>(null);
  const settledApprovalIdRef = useRef<string | null>(null);
  const decisionAbortRef = useRef<AbortController | null>(null);
  const acceptsRequestRef = useRef(acceptsRequest);
  acceptsRequestRef.current = acceptsRequest;
  pendingRef.current = pending;
  const runActiveRef = useRef(runActive);
  const kickPollRef = useRef<(() => void) | null>(null);
  // When the last read started, and the lanes (machine, page, grant) read
  // recently, newest last; kept across restarts.
  const lastReadRef = useRef<{ atMs: number; lanes: string[] }>({ atMs: 0, lanes: [] });

  const identity = JSON.stringify([projectId, browserSessionId, runtimeId, browserPageId]);
  // A decision belongs to one mounted, authenticated browser surface. The token
  // itself is never persisted; changing credentials invalidates in-flight work.
  const scope = useMemo(
    () => ({ active, identity, originEndpoint, originAccessToken }),
    [active, identity, originEndpoint, originAccessToken],
  );
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    pendingRef.current = null;
    settledApprovalIdRef.current = null;
    submittingRef.current = false;
    setPending(null);
    setSubmitting(false);
    setError(null);
    setRoutineApprovedRunId(null);
    setLastDecision(null);
    decisionAbortRef.current?.abort();
    decisionAbortRef.current = null;
  }, [scope]);

  useEffect(() => {
    if (
      !active ||
      !projectId ||
      !runtimeId ||
      !browserPageId ||
      !originEndpoint ||
      !originAccessToken
    ) {
      setPending(null);
      return;
    }

    const lane = JSON.stringify([scope.identity, scope.originEndpoint, scope.originAccessToken]);
    const gapLeft = () =>
      lastReadRef.current.lanes.includes(lane) ? lastReadRef.current.atMs + APPROVAL_MIN_READ_GAP_MS - Date.now() : 0;
    let cancelled = false;
    let timerId: number | null = null;
    let pollAbort: AbortController | null = null;
    let inFlight = false;
    let lastSettledAt = Date.now();
    // Reads that failed in a row, and since when.
    let failures = 0;
    let failingSinceMs: number | null = null;
    // The next read is due one delay after the last answer: 400 ms while a
    // prompt is shown, 1.5 s while a run may raise one, otherwise a slow
    // safety read; none while hidden. Coming back reads at once if it is due.
    // Failed reads back off; no two reads start closer than the minimum gap.
    const schedule = () => {
      if (timerId !== null) window.clearTimeout(timerId);
      timerId = null;
      if (cancelled || inFlight || scopeRef.current !== scope) return;
      const delay = adaptivePollDelay(
        Boolean(pendingRef.current) || runActiveRef.current,
        pendingRef.current ? APPROVAL_PENDING_POLL_INTERVAL_MS : APPROVAL_IDLE_POLL_INTERVAL_MS,
        APPROVAL_QUIET_POLL_INTERVAL_MS,
        APPROVAL_QUIET_IDLE_POLL_INTERVAL_MS,
      );
      if (delay === null) return;
      const backedOff = failures > 0
        ? Math.max(delay, Math.min(APPROVAL_FAILURE_MAX_POLL_INTERVAL_MS, delay * 2 ** Math.min(failures, 8)))
        : delay;
      const wait = Math.max(lastSettledAt + backedOff - Date.now(), gapLeft());
      if (wait <= 0) void poll();
      else timerId = window.setTimeout(poll, wait);
    };
    const poll = async () => {
      timerId = null;
      if (inFlight) return;
      const gap = gapLeft();
      if (gap > 0) {
        timerId = window.setTimeout(poll, gap);
        return;
      }
      inFlight = true;
      lastReadRef.current = {
        atMs: Date.now(),
        lanes: [...lastReadRef.current.lanes.filter((read) => read !== lane), lane].slice(-APPROVAL_RECENT_LANES),
      };
      pollAbort = new AbortController();
      try {
        const next = await controllerClient.browserSessions.fetchPendingApproval({
          originEndpoint,
          originAccessToken,
          runtimeId,
          browserPageId,
          signal: pollAbort.signal,
        });
        if (cancelled || scopeRef.current !== scope) {
          return;
        }
        const live = next && next.request.expiresAtMs > Date.now() ? next : null;
        if (!live || live.request.approvalId !== settledApprovalIdRef.current) {
          settledApprovalIdRef.current = null;
          pendingRef.current = live;
          setPending(live);
        } else {
          pendingRef.current = null;
          setPending(null);
        }
        failures = 0;
        failingSinceMs = null;
        setError(null);
      } catch (pollError) {
        if (!cancelled && scopeRef.current === scope && !isAbortError(pollError)) {
          failures += 1;
          failingSinceMs ??= Date.now();
          if (pendingRef.current && Date.now() - failingSinceMs >= APPROVAL_INTERRUPTED_GRACE_MS) {
            setError(APPROVAL_INTERRUPTED_MESSAGE);
          }
        }
      } finally {
        inFlight = false;
        lastSettledAt = Date.now();
        schedule();
      }
    };
    const kick = () => {
      if (cancelled || inFlight) return;
      // Hidden: owe the read to the return instead of reading now.
      if (pollingGateState() === "hidden") {
        lastSettledAt = 0;
        return;
      }
      if (timerId !== null) window.clearTimeout(timerId);
      void poll();
    };
    kickPollRef.current = kick;
    const unsubscribe = subscribePollingGate(schedule);
    // The first read goes at once, unless the lane read a moment ago.
    void poll();

    return () => {
      cancelled = true;
      unsubscribe();
      if (kickPollRef.current === kick) kickPollRef.current = null;
      pollAbort?.abort();
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [
    active,
    browserPageId,
    browserSessionId,
    originAccessToken,
    originEndpoint,
    projectId,
    runtimeId,
    scope,
  ]);

  useEffect(() => {
    if (runActiveRef.current === runActive) return;
    runActiveRef.current = runActive;
    if (runActive) kickPollRef.current?.();
  }, [runActive]);

  useEffect(
    () => () => {
      decisionAbortRef.current?.abort();
    },
    [],
  );

  /**
   * Answers the prompt `approvalId` names, the one the surface showed. The
   * latest poll may already hold another prompt (it updates before the next
   * render), and that one is never answered by a press for this one.
   */
  const decide = useCallback(
    async (decision: RuntimeSharedBrowserApprovalDecision, approvalId: string) => {
      const current = pendingRef.current;
      if (
        !active ||
        submittingRef.current ||
        !current ||
        current.request.approvalId !== approvalId ||
        (acceptsRequestRef.current && !acceptsRequestRef.current(current.request)) ||
        !projectId ||
        !runtimeId ||
        !browserPageId ||
        !originEndpoint ||
        !originAccessToken
      ) {
        return;
      }
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);
      const controller = new AbortController();
      decisionAbortRef.current?.abort();
      decisionAbortRef.current = controller;
      try {
        const accepted = await controllerClient.browserSessions.decideApproval({
          originEndpoint,
          originAccessToken,
          pending: current,
          decision,
          signal: controller.signal,
        });
        if (controller.signal.aborted || scopeRef.current !== scope) {
          return;
        }
        if (!accepted) {
          if (pendingRef.current?.request.approvalId === current.request.approvalId) {
            setError("This approval changed or expired. Waiting for the current request…");
          }
          return;
        }
        if (decision === "allow_routine" && current.request.kind === "origin") {
          setRoutineApprovedRunId(current.request.runId);
        }
        settledApprovalIdRef.current = current.request.approvalId;
        setLastDecision({ approvalId: current.request.approvalId, decision });
        if (pendingRef.current?.request.approvalId === current.request.approvalId) {
          pendingRef.current = null;
          setPending(null);
        }
      } catch (decisionError) {
        if (
          !controller.signal.aborted &&
          scopeRef.current === scope &&
          pendingRef.current?.request.approvalId === current.request.approvalId &&
          !isAbortError(decisionError)
        ) {
          setError("Could not save the approval. Check your connection and try again.");
        }
      } finally {
        if (decisionAbortRef.current === controller) {
          decisionAbortRef.current = null;
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    }, [active, browserPageId, originAccessToken, originEndpoint, projectId, runtimeId, scope],
  );

  return {
    pending,
    submitting,
    error,
    routineApprovedRunId,
    /** The last decision accepted here, whichever surface asked for it. */
    lastDecision,
    decide,
  };
}

export type SharedBrowserApprovalState = ReturnType<typeof useSharedBrowserApproval>;
