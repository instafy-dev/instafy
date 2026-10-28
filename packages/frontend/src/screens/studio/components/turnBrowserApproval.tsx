import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { RunRecord } from "../../../types";
import { BrowserApprovalRow } from "./BrowserApprovalRow";
import type { ChatMessage } from "../types";
import { extractAgentJobId, runMatchesThreadJobId } from "./chatMessagePresentation";
import type { ChatSharedBrowserApprovalTarget } from "./chatSharedBrowserApproval";
import type { SessionBrowserApproval } from "./turnActivity";
import type { SharedBrowserApprovalState } from "./useSharedBrowserApproval";

/**
 * How long a prompt waits for its turn to claim it before the chat shows it
 * at the end of the transcript instead: the run's turn is not in this view
 * (another conversation's thread, or not rendered yet).
 */
export const BROWSER_APPROVAL_UNCLAIMED_FALLBACK_MS = 300;

export type TurnBrowserApprovalValue = {
  /** The running browser job whose prompts the viewer can answer, or null. */
  target: ChatSharedBrowserApprovalTarget | null;
  /**
   * The prompt waiting on the viewer, by id. The approval lane hands over a
   * new state with every poll while a prompt waits; turns re-render only when
   * one arrives or ends, and only the row reads the state itself.
   */
  pendingApprovalId: string | null;
  agentName: string;
  /** A turn on screen shows the run's prompt itself; the returned function lets it go. */
  claim: (runId: string) => () => void;
  /** Prompts answered, or left, while this tab watched, by run. */
  settledByRun: ReadonlyMap<string, readonly SessionBrowserApproval[]>;
  recordSettled: (runId: string, settled: SessionBrowserApproval) => void;
};

export const TurnBrowserApprovalContext = createContext<TurnBrowserApprovalValue | null>(null);
/** The approval lane's state, for the row alone. */
export const TurnBrowserApprovalStateContext = createContext<SharedBrowserApprovalState | null>(null);

/**
 * ChatPanel's side: the context its turns read, and whether any turn on
 * screen shows the current prompt, so the chat shows it once.
 */
export function useTurnBrowserApprovalProvider({
  target,
  approval,
  agentName,
}: {
  target: ChatSharedBrowserApprovalTarget | null;
  approval: SharedBrowserApprovalState;
  agentName: string;
}): { value: TurnBrowserApprovalValue; showFallback: boolean } {
  const claimsRef = useRef(new Map<string, number>());
  const [claimedRunIds, setClaimedRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const claim = useCallback((runId: string) => {
    const claims = claimsRef.current;
    claims.set(runId, (claims.get(runId) ?? 0) + 1);
    setClaimedRunIds(new Set(claims.keys()));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (claims.get(runId) ?? 1) - 1;
      if (left > 0) {
        claims.set(runId, left);
      } else {
        claims.delete(runId);
      }
      setClaimedRunIds(new Set(claims.keys()));
    };
  }, []);
  const [settledByRun, setSettledByRun] = useState<ReadonlyMap<string, readonly SessionBrowserApproval[]>>(
    () => new Map(),
  );
  const recordSettled = useCallback((runId: string, settled: SessionBrowserApproval) => {
    setSettledByRun((current) => {
      const existing = current.get(runId) ?? [];
      if (existing.some((entry) => entry.approvalId === settled.approvalId)) {
        return current;
      }
      const next = new Map(current);
      next.set(runId, [...existing, settled]);
      return next;
    });
  }, []);
  const pendingApprovalId = approval.pending?.request.approvalId ?? null;
  const value = useMemo<TurnBrowserApprovalValue>(
    () => ({ target, pendingApprovalId, agentName, claim, settledByRun, recordSettled }),
    [agentName, claim, pendingApprovalId, recordSettled, settledByRun, target],
  );

  // The end-of-transcript row shows only after a moment without a claim, so
  // a turn that mounts in the same render keeps the one row.
  const claimed = target !== null && claimedRunIds.has(target.runId);
  const [unclaimedRunId, setUnclaimedRunId] = useState<string | null>(null);
  const targetRunId = target?.runId ?? null;
  useEffect(() => {
    setUnclaimedRunId(null);
    if (!targetRunId || claimed) return;
    const timer = window.setTimeout(() => setUnclaimedRunId(targetRunId), BROWSER_APPROVAL_UNCLAIMED_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [claimed, targetRunId]);
  return { value, showFallback: targetRunId !== null && !claimed && unclaimedRunId === targetRunId };
}

/**
 * Whether the end-of-transcript row continues the message right above it:
 * that message belongs to the prompt's own run, so the row takes no avatar
 * of its own (one avatar per turn). Any other message above, or none, and
 * the row shows the agent's avatar.
 */
export function fallbackRowContinuesTail(
  tail: ChatMessage | null | undefined,
  run: RunRecord | null | undefined,
): boolean {
  if (!tail || !run || tail.role !== "assistant") return false;
  const jobId = extractAgentJobId(tail);
  return jobId !== null && runMatchesThreadJobId(run, jobId);
}

export type TurnBrowserApproval = {
  /** The prompt this turn shows under its activity line, when its run is waiting on the viewer. */
  row: {
    agentName: string;
    onSettled: (settled: SessionBrowserApproval) => void;
  } | null;
  /** The viewer can answer a prompt this turn waits on: its line says "Waiting for you". */
  viewerCanAnswer: boolean;
  /** This turn's prompts answered, or left, while this tab watched. */
  settled: readonly SessionBrowserApproval[];
};

const NO_SETTLED: readonly SessionBrowserApproval[] = [];

function runOf(runs: Readonly<Record<string, RunRecord>>, runId: string): RunRecord | null {
  return runs[runId] ?? Object.values(runs).find((run) => run.id === runId) ?? null;
}

/**
 * A turn's side: it claims the prompt of its own run (the run serving its
 * job), so the prompt shows inside the turn, under its activity line, with
 * no second avatar.
 */
export function useTurnBrowserApproval({
  jobId,
  runs,
}: {
  jobId: string;
  runs: Readonly<Record<string, RunRecord>>;
}): TurnBrowserApproval {
  const context = useContext(TurnBrowserApprovalContext);
  const target = context?.target ?? null;
  const targetRun = target ? runOf(runs, target.runId) : null;
  const ownsTarget = Boolean(target && jobId && targetRun && runMatchesThreadJobId(targetRun, jobId));
  const claim = context?.claim;
  const targetRunId = target?.runId ?? null;
  useEffect(() => {
    if (!ownsTarget || !claim || !targetRunId) return;
    return claim(targetRunId);
  }, [claim, ownsTarget, targetRunId]);

  const recordSettled = context?.recordSettled;
  const onSettled = useCallback(
    (settled: SessionBrowserApproval) => {
      if (targetRunId) recordSettled?.(targetRunId, settled);
    },
    [recordSettled, targetRunId],
  );
  const settledByRun = context?.settledByRun;
  const settled = useMemo(() => {
    if (!settledByRun || !jobId) return NO_SETTLED;
    const mine: SessionBrowserApproval[] = [];
    for (const [runId, entries] of settledByRun) {
      const run = runOf(runs, runId);
      if (run && runMatchesThreadJobId(run, jobId)) mine.push(...entries);
    }
    return mine.length > 0 ? mine : NO_SETTLED;
  }, [jobId, runs, settledByRun]);

  if (!context || !ownsTarget) {
    return { row: null, viewerCanAnswer: false, settled };
  }
  return {
    row: { agentName: context.agentName, onSettled },
    viewerCanAnswer: context.pendingApprovalId !== null,
    settled,
  };
}

/** The row a turn shows under its line: the only part of a turn that follows every poll. */
export function TurnBrowserApprovalRow({ agentName, onSettled }: NonNullable<TurnBrowserApproval["row"]>) {
  const approval = useContext(TurnBrowserApprovalStateContext);
  return approval ? <BrowserApprovalRow agentDisplayName={agentName} approval={approval} onSettled={onSettled} /> : null;
}
