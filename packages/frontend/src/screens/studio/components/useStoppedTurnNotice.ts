import { useEffect, useState } from "react";
import { shouldSuppressAgentEvaluationRunPresence } from "../../../conversations/groupParticipation";
import { readRunInterruption } from "../../../conversations/runInterruption";
import { MANUAL_STOP_CHANGED_EVENT, manualStopHold } from "../../../runtime/idlePauseRegistry";
import { isPersonRuntimeStopReason } from "../../../runtime/unexpectedHostedRuntimeRecovery";
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

/** Whether the controller recorded that someone's stop put this run back in the queue. */
function isStoppedByPerson(run: RunRecord): boolean {
  const interruption = readRunInterruption(run);
  return interruption !== null && isPersonRuntimeStopReason(interruption.reason);
}

/**
 * Whether a person's Stop cut off a turn of this conversation and no machine
 * is left to finish it: "held" when this tab's Stop did, so its hold knows
 * what the stop kept; "recorded" when only the controller's record says so;
 * null otherwise.
 *
 * The controller records the stop on the run (see readRunInterruption): it
 * is queued again, with the stop's reason, for every viewer and after a
 * reload. A stop nobody chose (idle, credits, a lost heartbeat) keeps the
 * waiting status instead. The record is announced only once the stop
 * answers, and controllers before it put the job back in the queue without
 * a run update (or a `runtime.stopped` for a person's stop), so the run
 * still reads as in progress. Until then only the tab that pressed Stop
 * knows why, through the hold that keeps the machine stopped. The hold
 * lifts on Start or a send, and a machine that comes back picks the turn up
 * again (for 15 minutes, before the controller gives up on it). Idle stops
 * hold differently, and a queued run without the record had not started.
 *
 * The hold also outlives the Stop while a machine that came back without
 * asking through this tab (a Desktop runtime, another tab or a teammate's
 * Start) runs later turns, so a turn that began after the Stop and then
 * loses its machine was not cut off by it.
 */
export function resolveStoppedTurn(input: StoppedTurnInput): "held" | "recorded" | null {
  if (input.runtimeReady) {
    return null;
  }
  const at = input.manualStopAt;
  let stopped: "held" | "recorded" | null = null;
  for (const run of input.activeRuns) {
    const recorded = isStoppedByPerson(run);
    const running = run.status === "in_progress" || run.status === "awaiting_approval";
    const held = (recorded || running) && at !== null && startedBefore(run, at);
    if (
      !(held || recorded) ||
      // A silent skill-mode evaluation never said it was working.
      shouldSuppressAgentEvaluationRunPresence({
        runId: run.id,
        runMetadata: run.metadata,
        messages: input.messages,
      })
    ) {
      continue;
    }
    if (held) {
      return "held";
    }
    stopped = "recorded";
  }
  return stopped;
}

export function hasStoppedTurn(input: StoppedTurnInput): boolean {
  return resolveStoppedTurn(input) !== null;
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
 * waits, or null. Never written into the conversation. Every viewer gets the
 * line from the controller's record, and only the tab whose Stop answered
 * that its flush pushed everything names where the unsaved work went: a
 * reload drops the hold, and that sentence with it.
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
  const stopped = resolveStoppedTurn({ ...input, manualStopAt: hold?.at ?? null });
  if (!stopped) {
    return null;
  }
  return describeStoppedTurn(agentDisplayName, {
    unsavedWorkInHistory:
      stopped === "held" &&
      stopKeptWorkInHistory(hold?.flush ?? null) &&
      unsavedWorkPlacementFor(versioning).unsavedWorkInHistory,
  });
}
