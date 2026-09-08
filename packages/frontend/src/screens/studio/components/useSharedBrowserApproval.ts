import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  controllerClient,
  type RuntimeSharedBrowserApprovalDecision,
  type RuntimeSharedBrowserPendingApproval,
} from "../../../sdk/instafy";

const APPROVAL_IDLE_POLL_INTERVAL_MS = 1_500;
const APPROVAL_PENDING_POLL_INTERVAL_MS = 400;

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
}: {
  active: boolean;
  projectId: string | null;
  browserSessionId: string;
  runtimeId: string | null;
  browserPageId: string | null;
  originEndpoint: string | null;
  originAccessToken: string | null;
}) {
  const [pending, setPending] = useState<RuntimeSharedBrowserPendingApproval | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routineApprovedRunId, setRoutineApprovedRunId] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const pendingRef = useRef<RuntimeSharedBrowserPendingApproval | null>(null);
  const settledApprovalIdRef = useRef<string | null>(null);
  const decisionAbortRef = useRef<AbortController | null>(null);
  pendingRef.current = pending;

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
    const poll = async () => {
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
        if (!cancelled && scopeRef.current === scope) {
          timerId = window.setTimeout(
            poll,
            pendingRef.current
              ? APPROVAL_PENDING_POLL_INTERVAL_MS
              : APPROVAL_IDLE_POLL_INTERVAL_MS,
          );
        }
      }
    };
    void poll();

    return () => {
      cancelled = true;
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

  useEffect(
    () => () => {
      decisionAbortRef.current?.abort();
    },
    [],
  );

  const decide = useCallback(
    async (decision: RuntimeSharedBrowserApprovalDecision) => {
      const current = pendingRef.current;
      if (
        !active ||
        submittingRef.current ||
        !current ||
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
    decide,
  };
}
