import { useEffect, useState } from "react";
import { shouldSuppressAgentEvaluationRunPresence } from "../../../conversations/groupParticipation";
import { MANUAL_STOP_CHANGED_EVENT, manualStopHold } from "../../../runtime/idlePauseRegistry";
import type { RuntimeStopFlush } from "../../../services/runtimeController/runtimes";
import type { RunRecord } from "../../../types";
import { useActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import type { ChatMessage } from "../types";
import { describeStoppedTurn, unsavedWorkPlacementFor } from "./versioningCopy";

export interface StoppedTurnInput {
  /**
   * When the person stopped the space's last live machine in this tab
   * (Machines, Stop) and has not asked for one since; null without one.
   */
  manualStopAt: number | null;
  runtimeReady: boolean;
  /** The conversation's live runs (ChatPanel's `activeConversationRuns`). */
  activeRuns: readonly RunRecord[];
  messages: readonly ChatMessage[];
}

/** A run that existed when the Stop was made. One with no readable start does not count. */
function startedBefore(run: RunRecord, at: number): boolean {
  const createdAt = run.createdAt ? Date.parse(run.createdAt) : Number.NaN;
  return Number.isFinite(createdAt) && createdAt <= at;
}

/**
 * Whether the person's Stop cut off a turn of this conversation: a run had
 * started before it, and no machine is left to finish it.
 *
 * The controller puts the stopped turn's job back in the queue without a
 * run update (and publishes no `runtime.stopped` for a person's stop), so
 * the run still reads as in progress. Only the tab that pressed Stop knows
 * why, through the hold that keeps the machine stopped. The hold lifts on
 * Start or a send, and a machine that comes back picks the turn up again
 * (for 15 minutes, before the controller gives up on it). Idle stops hold
 * differently, and a run still queued had not started.
 *
 * The hold also outlives the Stop while a machine that came back without
 * asking through this tab (a Desktop runtime, another tab or a teammate's
 * Start) runs later turns, so a turn that began after the Stop and then
 * loses its machine was not cut off by it.
 */
export function hasStoppedTurn(input: StoppedTurnInput): boolean {
  const at = input.manualStopAt;
  if (at === null || input.runtimeReady) {
    return false;
  }
  return input.activeRuns.some(
    (run) =>
      (run.status === "in_progress" || run.status === "awaiting_approval") &&
      startedBefore(run, at) &&
      // A silent skill-mode evaluation never said it was working.
      !shouldSuppressAgentEvaluationRunPresence({
        runId: run.id,
        runMetadata: run.metadata,
        messages: input.messages,
      }),
  );
}

/**
 * History lists the turn's unsaved work only once the stop's flush pushed
 * all of it. Before the stop answers, or after a flush that failed, had no
 * writer or ran out of time, the work waits on the machine's disk until the
 * machine starts again.
 */
function stopKeptWorkInHistory(flush: RuntimeStopFlush | null): boolean {
  return flush?.status === "flushed" && flush.unpushedRefs === 0;
}

/**
 * The chat line that stands in for the typing status while a stopped turn
 * waits, or null. Per tab and never written into the conversation: a reload
 * drops the hold, and the line with it.
 */
export function useStoppedTurnNotice({
  projectId,
  agentDisplayName,
  ...input
}: Omit<StoppedTurnInput, "manualStopAt"> & {
  projectId: string | null;
  /** The working agent's name; null when several share the conversation. */
  agentDisplayName: string | null;
}): string | null {
  const versioning = useActiveWorkspaceVersioning();
  // The hold is module state: read it again when it is set, answered or lifted.
  const [, setHoldEpoch] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const bump = (event: Event) => {
      if ((event as CustomEvent<{ projectId?: string | null }>).detail?.projectId === projectId) {
        setHoldEpoch((epoch) => epoch + 1);
      }
    };
    window.addEventListener(MANUAL_STOP_CHANGED_EVENT, bump);
    return () => window.removeEventListener(MANUAL_STOP_CHANGED_EVENT, bump);
  }, [projectId]);

  const hold = manualStopHold(projectId);
  if (!hold || !hasStoppedTurn({ ...input, manualStopAt: hold.at })) {
    return null;
  }
  return describeStoppedTurn(agentDisplayName, {
    unsavedWorkInHistory: stopKeptWorkInHistory(hold.flush) && unsavedWorkPlacementFor(versioning).unsavedWorkInHistory,
  });
}
