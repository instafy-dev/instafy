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
  if (disableAutoRuntimeEnsure) {
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

export function shouldAutoEnsureHostedForEmptyState(args: {
  disableAutoRuntimeEnsure: boolean;
  projectInitialized: boolean;
  projectReadyForRuntime: boolean;
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
    projectInitialized,
    projectReadyForRuntime,
    runtimeControllerEnabled,
    activeProjectId,
    runtimeReady,
    runtimeStatusesResolved,
    hostedRuntimeEnsuring,
    hasHostedRuntimeInProgress,
    hasLocalRuntime,
    runtimeStatusCount,
  } = args;
  if (disableAutoRuntimeEnsure) {
    return false;
  }
  if (
    !projectInitialized ||
    !projectReadyForRuntime ||
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
