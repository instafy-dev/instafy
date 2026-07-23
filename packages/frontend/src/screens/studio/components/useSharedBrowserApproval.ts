import { useCallback, useEffect, useRef, useState } from "react";
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
  const submittingRef = useRef(false);
  const pendingRef = useRef<RuntimeSharedBrowserPendingApproval | null>(null);
  const settledApprovalIdRef = useRef<string | null>(null);
  const decisionAbortRef = useRef<AbortController | null>(null);
  pendingRef.current = pending;

  const identity = `${projectId ?? ""}:${browserSessionId}:${runtimeId ?? ""}:${browserPageId ?? ""}`;
  useEffect(() => {
    pendingRef.current = null;
    settledApprovalIdRef.current = null;
    submittingRef.current = false;
    setPending(null);
    setSubmitting(false);
    setError(null);
    decisionAbortRef.current?.abort();
    decisionAbortRef.current = null;
  }, [identity]);

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
        if (cancelled) {
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
        if (!cancelled && !isAbortError(pollError) && pendingRef.current) {
          setError("Approval connection interrupted. Reconnecting…");
        }
      } finally {
        if (!cancelled) {
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
        if (!accepted) {
          setError("This approval changed or expired. Waiting for the current request…");
          return;
        }
        settledApprovalIdRef.current = current.request.approvalId;
        pendingRef.current = null;
        setPending(null);
      } catch (decisionError) {
        if (!isAbortError(decisionError)) {
          setError("Could not save the approval. Check your connection and try again.");
        }
      } finally {
        if (decisionAbortRef.current === controller) {
          decisionAbortRef.current = null;
        }
        submittingRef.current = false;
        setSubmitting(false);
      }
    }, [browserPageId, originAccessToken, originEndpoint, projectId, runtimeId],
  );

  return {
    pending,
    submitting,
    error,
    decide,
  };
}
