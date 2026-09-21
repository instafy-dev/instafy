import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
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
