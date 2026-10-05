import { useCallback, useEffect, useRef, useState } from "react";
import { isNonRecoverableRunErrorMessage } from "../../../conversations/conversationGoals";
import { shouldSuppressAgentEvaluationRunPresence } from "../../../conversations/groupParticipation";
import {
  STALLED_LAUNCH_RETRY_FAILED_MESSAGE,
  type EnsureHostedRuntimeOptions,
} from "../../../runtime/hooks/useHostedRuntimeEnsure";
import { stalledLaunchDeadlineMs } from "../../../runtime/utils/runtimeEntry";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import type { StatusIntent } from "../../../status/useStatus";
import type { RunRecord } from "../../../types";
import type { ChatMessage } from "../types";
import { isRuntimeLimitWaitAlert } from "./runtimeAlertPresentation";

export interface StalledWorkspaceStartInput {
  runtimeStatuses: readonly ControllerRuntimeStatusEntry[];
  runtimeReady: boolean;
  /** The space runs on a desktop runtime, which no hosted retry can help. */
  localRuntime: boolean;
  /** The active conversation's controller id. */
  conversationId: string | null;
  runs: Record<string, RunRecord> | null | undefined;
  messages: readonly ChatMessage[];
  /** The last ensure was refused by the team's runtime limit. */
  runtimeLimitReached: boolean;
  outOfCredits: boolean;
}

export interface StalledWorkspaceStartState {
  /** A hosted launch has gone five minutes without coming up. */
  launchStalled: boolean;
  /** ...and this conversation has a message waiting on it. */
  showNotice: boolean;
  /** When a launch still under the bound reaches it; null when none will. */
  nextCheckAtMs: number | null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether the space's hosted launch is stalled, from the controller's own
 * lease start time. A runtime limit wait or an empty credit balance has its
 * own message, and a controller that does not report the start time never
 * stalls anything.
 */
export function resolveStalledWorkspaceStart(
  input: StalledWorkspaceStartInput & { nowMs: number },
): StalledWorkspaceStartState {
  const idle: StalledWorkspaceStartState = {
    launchStalled: false,
    showNotice: false,
    nextCheckAtMs: null,
  };
  if (input.runtimeReady || input.localRuntime || input.runtimeLimitReached || input.outOfCredits) {
    return idle;
  }
  let launchStalled = false;
  let nextCheckAtMs: number | null = null;
  for (const entry of input.runtimeStatuses) {
    const deadlineMs = stalledLaunchDeadlineMs(entry);
    if (deadlineMs === null) {
      continue;
    }
    if (input.nowMs >= deadlineMs) {
      launchStalled = true;
    } else {
      nextCheckAtMs = nextCheckAtMs === null ? deadlineMs : Math.min(nextCheckAtMs, deadlineMs);
    }
  }
  if (!launchStalled) {
    return { ...idle, nextCheckAtMs };
  }
  // No liveness filter: a queued run reads as stale after five minutes,
  // which is exactly when a launch that never came up is noticed.
  const pendingRuns = input.conversationId
    ? Object.values(input.runs ?? {}).filter(
        (run) =>
          run.conversationId === input.conversationId &&
          (run.status === "queued" || run.status === "in_progress") &&
          !input.messages.some((message) => isNonRecoverableRunErrorMessage(message, run.id)) &&
          !shouldSuppressAgentEvaluationRunPresence({
            runId: run.id,
            runMetadata: run.metadata,
            messages: input.messages,
          }),
      )
    : [];
  const waitingOnRuntimeLimit = pendingRuns.some((run) =>
    isRuntimeLimitWaitAlert(readRecord(run.metadata?.runtimeAlert)),
  );
  return {
    launchStalled: !waitingOnRuntimeLimit,
    showNotice: pendingRuns.length > 0 && !waitingOnRuntimeLimit,
    nextCheckAtMs: null,
  };
}

/**
 * The chat's view of a stalled hosted launch, and the user's retry. The retry
 * asks the controller to replace the launch; nothing here stops or starts a
 * machine on its own, and a new launch clears the state through its fresh
 * start time on the next status refresh.
 */
export function useStalledWorkspaceStart({
  ensureHostedRuntime,
  showStatus,
  ...input
}: StalledWorkspaceStartInput & {
  /** Null for a member who cannot control the space's runtime. */
  ensureHostedRuntime: ((options?: EnsureHostedRuntimeOptions) => Promise<boolean>) | null;
  showStatus: (message: string, intent: StatusIntent, durationMs?: number) => void;
}) {
  const [, setClockTick] = useState(0);
  const [retryPending, setRetryPending] = useState(false);
  const retryInFlightRef = useRef(false);
  const state = resolveStalledWorkspaceStart({ ...input, nowMs: Date.now() });

  // Nothing re-renders a quiet tab when a launch crosses the bound, so one
  // timer reads the clock again at that moment.
  const { nextCheckAtMs } = state;
  useEffect(() => {
    if (nextCheckAtMs === null) {
      return;
    }
    const timeoutId = setTimeout(
      () => setClockTick((tick) => tick + 1),
      Math.max(0, nextCheckAtMs - Date.now()),
    );
    return () => clearTimeout(timeoutId);
  }, [nextCheckAtMs]);

  const retry = useCallback(async () => {
    if (!ensureHostedRuntime || retryInFlightRef.current) {
      return;
    }
    retryInFlightRef.current = true;
    setRetryPending(true);
    try {
      // The ensure reports its own failures, including this one's.
      await ensureHostedRuntime({ force: true, replaceStalledLaunch: true });
    } catch {
      showStatus(STALLED_LAUNCH_RETRY_FAILED_MESSAGE, "warning", 5000);
    } finally {
      retryInFlightRef.current = false;
      setRetryPending(false);
    }
  }, [ensureHostedRuntime, showStatus]);

  return {
    launchStalled: state.launchStalled,
    showNotice: state.showNotice,
    retry: ensureHostedRuntime ? () => void retry() : null,
    retryPending,
  };
}
