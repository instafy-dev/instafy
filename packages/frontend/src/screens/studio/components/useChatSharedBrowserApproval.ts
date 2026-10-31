import { useCallback, useEffect, useMemo, useState } from "react";
import {
  controllerClient,
  type RuntimeSharedBrowserApprovalRequest,
} from "../../../sdk/instafy";
import type { RunRecord } from "../../../types";
import {
  selectChatSharedBrowserApprovalTarget,
  type ChatSharedBrowserApprovalTarget,
} from "./chatSharedBrowserApproval";
import { sharedBrowserGrantRefreshDelayMs } from "./sharedBrowserViewer";
import {
  useSharedBrowserApproval,
  type SharedBrowserApprovalState,
} from "./useSharedBrowserApproval";

/** A grant that could not be had is asked for again after this long. */
export const CHAT_SHARED_BROWSER_APPROVAL_GRANT_RETRY_MS = 5_000;
const GRANT_FALLBACK_LIFETIME_MS = 8 * 60 * 1_000;

type Grant = { key: string; endpoint: string; accessToken: string };

/**
 * The approval lane's own `browser.view` + `browser.control` grant for the
 * run's machine, separate from the browser view's, so a view that is
 * reconnecting, failed or never opened in this tab does not take it away.
 * Minting `browser.control` needs builder access, as the browser view's does.
 */
function useApprovalGrant(params: {
  projectId: string | null;
  runtimeId: string | null;
  browserSessionId: string;
}): Grant | null {
  const { projectId, runtimeId, browserSessionId } = params;
  const key = projectId && runtimeId ? `${projectId}\n${runtimeId}\n${browserSessionId}` : null;
  const [grant, setGrant] = useState<Grant | null>(null);
  useEffect(() => {
    if (!key || !projectId || !runtimeId) {
      setGrant(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const abort = new AbortController();
    const schedule = (run: () => void, delayMs: number) => {
      if (!cancelled) timer = window.setTimeout(run, delayMs);
    };
    const mint = async (forceRefresh: boolean) => {
      timer = null;
      try {
        const token = await controllerClient.workspace.origin.requestAccessToken({
          projectId,
          protocol: "http",
          scopes: ["browser.view", "browser.control"],
          preferRuntime: runtimeId,
          browserSessionId,
          forceRefresh,
          signal: abort.signal,
        });
        if (cancelled) return;
        const endpoint = token?.endpoint?.trim() ?? "";
        if (!token || !endpoint) {
          schedule(() => void mint(false), CHAT_SHARED_BROWSER_APPROVAL_GRANT_RETRY_MS);
          return;
        }
        setGrant({ key, endpoint, accessToken: token.token });
        const expiresAtMs = Date.now() + (token.expiresIn > 0 ? token.expiresIn * 1_000 : GRANT_FALLBACK_LIFETIME_MS);
        schedule(() => void mint(true), sharedBrowserGrantRefreshDelayMs(expiresAtMs));
      } catch {
        schedule(() => void mint(false), CHAT_SHARED_BROWSER_APPROVAL_GRANT_RETRY_MS);
      }
    };
    void mint(false);
    return () => {
      cancelled = true;
      abort.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
    // The key names the project, machine and session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return grant?.key === key ? grant : null;
}

export type ChatSharedBrowserApproval = {
  /** The run whose prompts are polled for; null when none applies. */
  target: ChatSharedBrowserApprovalTarget | null;
  /** That run's prompt, for the person who started it, and how to answer it. */
  approval: SharedBrowserApprovalState;
};

/**
 * Polls the pending prompt of this conversation's running Instafy's browser
 * job that the viewer started, with the job's own machine and page, so the
 * prompt can be shown and answered in the chat (and in the browser view)
 * whatever the browser view is doing. It never reads pages, the host or the
 * picture. The origin still decides who may see and answer a prompt.
 */
export function useChatSharedBrowserApproval(params: {
  enabled: boolean;
  projectId: string | null;
  userId: string | null;
  runs: readonly RunRecord[];
  browserSessionId: string;
}): ChatSharedBrowserApproval {
  const { enabled, projectId, userId, runs, browserSessionId } = params;
  const selected = useMemo(
    () => (enabled && projectId ? selectChatSharedBrowserApprovalTarget(runs, userId) : null),
    [enabled, projectId, runs, userId],
  );
  // Keep one object while the run stays the same, so polling does not restart
  // with every runs update.
  const targetKey = selected ? `${selected.runId}\n${selected.runtimeId}\n${selected.browserPageId}` : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => selected, [targetKey]);
  const grant = useApprovalGrant({
    projectId: target ? projectId : null,
    runtimeId: target?.runtimeId ?? null,
    browserSessionId,
  });
  // The origin already answers only the person who started the run; this
  // also keeps another run's prompt out of this conversation. The lane
  // holds, shows and answers only the prompts it accepts.
  const forThisRun = useCallback(
    (request: RuntimeSharedBrowserApprovalRequest) =>
      target !== null && request.runId === target.runId && request.initiatorUserId === userId,
    [target, userId],
  );
  const lane = useSharedBrowserApproval({
    active: Boolean(target && grant),
    projectId,
    browserSessionId,
    runtimeId: target?.runtimeId ?? null,
    browserPageId: target?.browserPageId ?? null,
    originEndpoint: grant?.endpoint ?? null,
    originAccessToken: grant?.accessToken ?? null,
    acceptsRequest: forThisRun,
  });
  const pending = lane.pending;
  const decide = lane.decide;
  const approval = useMemo<SharedBrowserApprovalState>(() => ({
    pending,
    submitting: pending ? lane.submitting : false,
    error: pending ? lane.error : null,
    routineApprovedRunId: lane.routineApprovedRunId,
    lastDecision: lane.lastDecision,
    decide,
  }), [decide, lane.error, lane.lastDecision, lane.routineApprovedRunId, lane.submitting, pending]);
  return { target, approval };
}

/**
 * Whether the chat's browser view shows a prompt, as the view says through
 * `onApprovalPendingChange`, kept with the chat (`scope`) it said so for. One
 * view serves every chat and says so only after it draws, so a chat the
 * person just went to would otherwise read, for that draw, the prompt of the
 * chat they left, and its Browser tab would say Approve.
 */
export function useChatViewApprovalPending(scope: string | null): {
  pending: boolean;
  onApprovalPendingChange: (pending: boolean) => void;
} {
  const [said, setSaid] = useState<{ scope: string | null; pending: boolean }>({ scope: null, pending: false });
  const onApprovalPendingChange = useCallback(
    (pending: boolean) =>
      setSaid((current) => (current.scope === scope && current.pending === pending ? current : { scope, pending })),
    [scope],
  );
  return { pending: said.pending && said.scope === scope, onApprovalPendingChange };
}
