import { useEffect, useMemo, useState } from "react";
import type { RunRecord } from "../../types";
import { MANUAL_STOP_CHANGED_EVENT, manualStopHold } from "../idlePauseRegistry";
import { latestPersonInterruptionAtMs } from "../unexpectedHostedRuntimeRecovery";

/**
 * When the latest person's stop this tab knows of in `projectId` was made, or
 * null: this tab's own Stop or Remove (its manual hold, by this tab's clock),
 * or a turn such a stop put back in the queue (by the controller's). A hosted
 * runtime still `requested` on an older launch is that stop's release, not a
 * launch (runtimeEntryIsStopping).
 */
export function useHostedRuntimeStopAtMs(
  projectId: string | null,
  runs: Record<string, RunRecord> | null | undefined,
): number | null {
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
  const manualStopAtMs = manualStopHold(projectId)?.at ?? null;
  return useMemo(() => {
    const interruptedAtMs = latestPersonInterruptionAtMs(runs, projectId, Date.now());
    if (manualStopAtMs === null || interruptedAtMs === null) {
      return manualStopAtMs ?? interruptedAtMs;
    }
    return Math.max(manualStopAtMs, interruptedAtMs);
  }, [manualStopAtMs, projectId, runs]);
}
