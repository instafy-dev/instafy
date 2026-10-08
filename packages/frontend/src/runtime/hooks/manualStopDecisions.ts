import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import {
  committedRuntimeStop,
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
 * Make a person's Stop under the hold it set (null when it set none) and keep
 * what the stop answered with that hold. The hold stays as long as the stop
 * took effect, including after an error answer that follows a committed stop
 * (committedRuntimeStop): lifting it then would let this tab start the
 * machine the person just stopped on its next status read. Any other failure
 * may have left the machine running, so it lifts the hold, unless a later
 * Stop has set its own, and is thrown.
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
    stopped = committedRuntimeStop(error);
    if (!stopped) {
      if (hold && manualStopHold(projectId) === hold) {
        clearManualStop(projectId);
      }
      throw error;
    }
  }
  // Whether the stop's flush put the work where History lists it: the chat
  // names that place only then (useStoppedTurnNotice).
  recordManualStopFlush(projectId, hold, stopped?.flush ?? null);
  return stopped;
}
