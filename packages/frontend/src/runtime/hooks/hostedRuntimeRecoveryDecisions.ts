import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import { isHostedRuntime, runtimeEntryIsBooting } from "../utils/runtimeEntry";

export function shouldPollHostedBootingRuntime(args: {
  runtimeControllerEnabled: boolean;
  activeProjectId: string | null;
  projectReadyForRuntime: boolean;
  runtimeStatuses: ControllerRuntimeStatusEntry[];
  runtimeReady: boolean;
}) {
  const { runtimeControllerEnabled, activeProjectId, projectReadyForRuntime, runtimeStatuses, runtimeReady } =
    args;
  const hasHostedPending = runtimeStatuses.some((entry) => {
    if (!entry || !isHostedRuntime(entry)) {
      return false;
    }
    return runtimeEntryIsBooting(entry);
  });
  return (
    runtimeControllerEnabled &&
    Boolean(activeProjectId) &&
    projectReadyForRuntime &&
    hasHostedPending &&
    !runtimeReady
  );
}

export function resolveHostedStatusPollInterval(args: {
  hostedRuntimeEnsuring: boolean;
  hasHostedRuntimeInProgress: boolean;
  waitingForPreferredRuntime: boolean;
}) {
  const { hostedRuntimeEnsuring, hasHostedRuntimeInProgress, waitingForPreferredRuntime } = args;
  return hostedRuntimeEnsuring || hasHostedRuntimeInProgress || waitingForPreferredRuntime
    ? 5_000
    : 15_000;
}

export function shouldAutoEnsureHostedForFallback(args: {
  disableAutoRuntimeEnsure: boolean;
  /** The user stopped this project's machine on purpose; do not relaunch it. */
  manualStopHeld: boolean;
  projectReadyForRuntime: boolean;
  runtimeControllerEnabled: boolean;
  activeProjectId: string | null;
  runtimeReady: boolean;
  hasHostedRuntimeInProgress: boolean;
  hasLocalRuntime: boolean;
  preferredRuntimeId: string | null;
  readyRuntimeCount: number;
  runtimeStatusesResolved: boolean;
}) {
  const {
    disableAutoRuntimeEnsure,
    manualStopHeld,
    projectReadyForRuntime,
    runtimeControllerEnabled,
    activeProjectId,
    runtimeReady,
    hasHostedRuntimeInProgress,
    hasLocalRuntime,
    preferredRuntimeId,
    readyRuntimeCount,
    runtimeStatusesResolved,
  } = args;
  if (disableAutoRuntimeEnsure || manualStopHeld) {
    return false;
  }
  const canEnsure =
    projectReadyForRuntime &&
    runtimeControllerEnabled &&
    Boolean(activeProjectId) &&
    !runtimeReady &&
    !hasHostedRuntimeInProgress &&
    !hasLocalRuntime &&
    !preferredRuntimeId;
  if (!canEnsure) {
    return false;
  }
  return readyRuntimeCount === 0 || !runtimeStatusesResolved;
}

// Deliberately does NOT wait for projectInitialized: a brand-new project
// spends its first several seconds materializing its workspace, while the
// hosted runtime's own workspace preparation happens per-job after the
// runtime registers. Serializing boot behind workspace init added ~10s to
// every first reply. Access must be resolved (not pending, not blocked) so
// read-only members and unauthorized visitors still never trigger a launch.
export function shouldAutoEnsureHostedForEmptyState(args: {
  disableAutoRuntimeEnsure: boolean;
  manualStopHeld: boolean;
  projectAccessResolved: boolean;
  runtimeControllerEnabled: boolean;
  activeProjectId: string | null;
  runtimeReady: boolean;
  runtimeStatusesResolved: boolean;
  hostedRuntimeEnsuring: boolean;
  hasHostedRuntimeInProgress: boolean;
  hasLocalRuntime: boolean;
  runtimeStatusCount: number;
}) {
  const {
    disableAutoRuntimeEnsure,
    manualStopHeld,
    projectAccessResolved,
    runtimeControllerEnabled,
    activeProjectId,
    runtimeReady,
    runtimeStatusesResolved,
    hostedRuntimeEnsuring,
    hasHostedRuntimeInProgress,
    hasLocalRuntime,
    runtimeStatusCount,
  } = args;
  if (disableAutoRuntimeEnsure || manualStopHeld) {
    return false;
  }
  if (
    !projectAccessResolved ||
    !runtimeControllerEnabled ||
    !activeProjectId ||
    runtimeReady ||
    !runtimeStatusesResolved ||
    hostedRuntimeEnsuring ||
    hasHostedRuntimeInProgress ||
    hasLocalRuntime
  ) {
    return false;
  }
  return runtimeStatusCount === 0;
}

export function shouldAutoEnsurePreferredHostedRuntime(args: {
  disableAutoRuntimeEnsure: boolean;
  manualStopHeld: boolean;
  runtimeControllerEnabled: boolean;
  projectReadyForRuntime: boolean;
  activeProjectId: string | null;
  preferredRuntimeEntry: ControllerRuntimeStatusEntry | null;
  waitingForPreferredRuntime: boolean;
  hostedRuntimeEnsuring: boolean;
  hasHostedRuntimeInProgress: boolean;
}) {
  const {
    disableAutoRuntimeEnsure,
    manualStopHeld,
    runtimeControllerEnabled,
    projectReadyForRuntime,
    activeProjectId,
    preferredRuntimeEntry,
    waitingForPreferredRuntime,
    hostedRuntimeEnsuring,
    hasHostedRuntimeInProgress,
  } = args;
  if (!waitingForPreferredRuntime) {
    return false;
  }
  if (
    disableAutoRuntimeEnsure ||
    manualStopHeld ||
    !runtimeControllerEnabled ||
    !projectReadyForRuntime ||
    !activeProjectId ||
    !preferredRuntimeEntry ||
    !isHostedRuntime(preferredRuntimeEntry) ||
    hostedRuntimeEnsuring ||
    hasHostedRuntimeInProgress
  ) {
    return false;
  }
  const preferredStatus = (preferredRuntimeEntry.status ?? "").toLowerCase();
  return ["stopped", "offline", "failed", "error"].includes(preferredStatus);
}
