import { useEffect, useState } from "react";
import { shouldSuppressAgentEvaluationRunPresence } from "../../../conversations/groupParticipation";
import { isManualStopHeld, MANUAL_STOP_CHANGED_EVENT } from "../../../runtime/idlePauseRegistry";
import type { RunRecord } from "../../../types";
import { useActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import type { ChatMessage } from "../types";
import { describeStoppedTurn, unsavedWorkPlacementFor } from "./versioningCopy";

export interface StoppedTurnInput {
  /**
   * The person stopped the space's last live machine in this tab (Machines,
   * Stop) and has not asked for one since.
   */
  manualStopHeld: boolean;
  runtimeReady: boolean;
  /** The conversation's live runs (ChatPanel's `activeConversationRuns`). */
  activeRuns: readonly RunRecord[];
  messages: readonly ChatMessage[];
}

/**
 * Whether the person's Stop cut off a turn of this conversation: a run had
 * started, and no machine is left to finish it.
 *
 * The controller puts the stopped turn's job back in the queue without a
 * run update (and publishes no `runtime.stopped` for a person's stop), so
 * the run still reads as in progress. Only the tab that pressed Stop knows
 * why, through the hold that keeps the machine stopped. The hold lifts on
 * Start or a send, and a machine that comes back picks the turn up again
 * (for 15 minutes, before the controller gives up on it). Idle stops hold
 * differently, and a run still queued had not started.
 */
export function hasStoppedTurn(input: StoppedTurnInput): boolean {
  if (!input.manualStopHeld || input.runtimeReady) {
    return false;
  }
  return input.activeRuns.some(
    (run) =>
      (run.status === "in_progress" || run.status === "awaiting_approval") &&
      // A silent skill-mode evaluation never said it was working.
      !shouldSuppressAgentEvaluationRunPresence({
        runId: run.id,
        runMetadata: run.metadata,
        messages: input.messages,
      }),
  );
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
}: Omit<StoppedTurnInput, "manualStopHeld"> & {
  projectId: string | null;
  /** The working agent's name; null when several share the conversation. */
  agentDisplayName: string | null;
}): string | null {
  const versioning = useActiveWorkspaceVersioning();
  // The hold is module state: read it again when it is set or lifted.
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

  if (!hasStoppedTurn({ ...input, manualStopHeld: isManualStopHeld(projectId) })) {
    return null;
  }
  return describeStoppedTurn(agentDisplayName, unsavedWorkPlacementFor(versioning));
}
