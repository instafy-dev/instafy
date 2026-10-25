import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  controllerClient,
  type RuntimeSharedBrowserApprovalDecision,
  type RuntimeSharedBrowserApprovalRequest,
  type RuntimeSharedBrowserPendingApproval,
} from "../../../sdk/instafy";
import { adaptivePollDelay, subscribePollingGate } from "../../../runtime/pollingGate";

const APPROVAL_IDLE_POLL_INTERVAL_MS = 1_500;
const APPROVAL_PENDING_POLL_INTERVAL_MS = 400;
// Every prompt carries a runId and is raised only inside a run, so with no
// run in the space the lane only keeps a slow safety read.
export const APPROVAL_QUIET_POLL_INTERVAL_MS = 15_000;
export const APPROVAL_QUIET_IDLE_POLL_INTERVAL_MS = 30_000;

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

    let cancelled = false;
    let timerId: number | null = null;
    let pollAbort: AbortController | null = null;
    let inFlight = false;
    let lastSettledAt = Date.now();
    // The next read is due one delay after the last answer: 400 ms while a
    // prompt is shown, 1.5 s while a run may raise one, otherwise a slow
    // safety read; none while hidden. Coming back reads at once if it is due.
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
      const wait = lastSettledAt + delay - Date.now();
      if (wait <= 0) void poll();
      else timerId = window.setTimeout(poll, wait);
    };
    const poll = async () => {
      timerId = null;
      if (inFlight) return;
      inFlight = true;
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
        setError(null);
      } catch (pollError) {
        if (!cancelled && scopeRef.current === scope && !isAbortError(pollError) && pendingRef.current) {
          setError("Approval connection interrupted. Reconnecting…");
        }
      } finally {
        inFlight = false;
        lastSettledAt = Date.now();
        schedule();
      }
    };
    const kick = () => {
      if (cancelled || inFlight) return;
      if (timerId !== null) window.clearTimeout(timerId);
      void poll();
    };
    kickPollRef.current = kick;
    const unsubscribe = subscribePollingGate(schedule);
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
