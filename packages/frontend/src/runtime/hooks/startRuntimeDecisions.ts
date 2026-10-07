import type { ControllerRuntimeStatusEntry, StartRuntimeParams } from "../../sdk/instafy";
import { resolveStalledHostedLaunch } from "../utils/runtimeEntry";

/**
 * The request behind Machines' Start for a listed hosted runtime.
 *
 * A launch that never came up is handed back by a plain start, so Start on
 * it would do nothing. For one past the stalled bound the request asks the
 * controller to replace it; every other start is unchanged.
 */
export function resolveStartRuntimeParams(
  projectId: string,
  entry: ControllerRuntimeStatusEntry,
  nowMs: number,
): StartRuntimeParams {
  return {
    projectId,
    runtimeId: entry.runtimeId,
    displayName: entry.displayName ?? undefined,
    originMode: entry.origin?.mode ?? undefined,
    originProtocols: entry.origin?.protocols ?? undefined,
    originMetadata: entry.origin?.metadata ?? undefined,
    ...(resolveStalledHostedLaunch(entry, nowMs) ? { replaceStalledLaunch: true } : {}),
  };
}
