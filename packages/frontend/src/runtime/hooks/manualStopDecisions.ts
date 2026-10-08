import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import {
  committedRuntimeStop,
  runtimeStopRefused,
  type StopRuntimeResult,
} from "../../services/runtimeController/runtimes";
import {
  clearManualStop,
  manualStopHold,
  recordManualStopFlush,
  type ManualStopHold,
} from "../idlePauseRegistry";
import {
  isHostedRuntime,
  runtimeEntryIsBooting,
  runtimeEntryIsReady,
} from "../utils/runtimeEntry";

/**
 * Whether stopping `runtimeId` leaves the project with no hosted machine that
 * is ready or still booting.
 *
 * Only then does the Stop mean "I do not want a machine", which is what the
 * manual hold records. While another hosted machine stays live the hold would
 * outlive it and later block the idle-pause wake for a machine the user never
 * stopped.
 */
export function stopLeavesNoLiveHostedRuntime(
  runtimeStatuses: readonly ControllerRuntimeStatusEntry[],
  runtimeId: string,
): boolean {
  return !runtimeStatuses.some(
    (entry) =>
      Boolean(entry) &&
      entry.runtimeId !== runtimeId &&
      isHostedRuntime(entry) &&
      (runtimeEntryIsReady(entry) || runtimeEntryIsBooting(entry)),
  );
}

/**
 * Settle the hold a person's Stop or Remove set (null when it set none) after
 * the request answered `error`, and return what it still did. A stop the
 * controller had committed before the error (committedRuntimeStop) keeps the
 * hold and what it kept: lifting it then would let this tab start the machine
 * the person just stopped on its next status read. Only a refusal
 * (runtimeStopRefused) lifts the hold, unless a later Stop has set its own:
 * the machine is as it was. After a 5xx answer or none at all the stop may
 * have taken effect, and the controller then announces the turn it put back
 * in the queue, so the hold stays, without a word on where the work went.
 * Where the stop did not take, the machine is still ready and the chat says
 * nothing of a stopped turn (useStoppedTurnNotice); Start or a send lifts the
 * hold as always. Returns null unless the stop was committed.
 */
function settleManualHoldAfterError(
  projectId: string | null,
  hold: ManualStopHold | null,
  error: unknown,
): StopRuntimeResult | null {
  const committed = committedRuntimeStop(error);
  if (committed) {
    recordManualStopFlush(projectId, hold, committed.flush);
  } else if (runtimeStopRefused(error) && hold && manualStopHold(projectId) === hold) {
    clearManualStop(projectId);
  }
  return committed;
}

/**
 * Make a person's Stop under the hold it set (null when it set none) and keep
 * what the stop answered with that hold. The hold stays unless the controller
 * refused the stop (settleManualHoldAfterError). An error answer that follows
 * a committed stop returns what it kept; any other failure is thrown.
 */
export async function stopUnderManualHold(
  projectId: string | null,
  hold: ManualStopHold | null,
  stop: () => Promise<StopRuntimeResult | null>,
): Promise<StopRuntimeResult | null> {
  let stopped: StopRuntimeResult | null;
  try {
    stopped = await stop();
  } catch (error) {
    const committed = settleManualHoldAfterError(projectId, hold, error);
    if (!committed) {
      throw error;
    }
    return committed;
  }
  // Whether the stop's flush put the work where History lists it: the chat
  // names that place only then (useStoppedTurnNotice).
  recordManualStopFlush(projectId, hold, stopped?.flush ?? null);
  return stopped;
}

/**
 * Remove a machine under the hold the person's Remove set, as
 * stopUnderManualHold stops one: a removal stops the machine first, and the
 * runtime then leaves the space's list. Unlike a stop, an error answer is
 * always thrown, also when the removal took effect or may have and kept the
 * hold: the runtime is then still listed, and the person removes it again.
 */
export async function removeUnderManualHold(
  projectId: string | null,
  hold: ManualStopHold | null,
  remove: () => Promise<StopRuntimeResult | null>,
): Promise<StopRuntimeResult | null> {
  let removed: StopRuntimeResult | null;
  try {
    removed = await remove();
  } catch (error) {
    settleManualHoldAfterError(projectId, hold, error);
    throw error;
  }
  recordManualStopFlush(projectId, hold, removed?.flush ?? null);
  return removed;
}
