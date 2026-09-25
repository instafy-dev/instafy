import type { RunRecord } from "../types";

export const UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS = 20_000;

const MANUAL_RUNTIME_STOP_REASONS = new Set([
  "user_stop",
  "user_remove",
  "runtime_limit_takeover",
  "browser_session_runtime_limit_takeover",
  // Deliberate platform stops: auto-restarting would either undo the pause
  // (idle), immediately die again (credits_exhausted), or run straight back
  // into the same memory wall (oom_killed). The machine wakes via the normal
  // ensure path on the user's next interaction instead.
  "idle",
  "credits_exhausted",
  "oom_killed",
]);

// The controller stopped this space's idle machine because another space in
// the organization was waiting for the hosted runtime slot. Relaunching it
// straight away would take the slot back from the space it was handed to, so
// the client waits for its user (or its own queued work) instead. The second
// spelling is what controllers before the reason was renamed publish.
const RUNTIME_LIMIT_RECLAIM_STOP_REASONS = new Set([
  "runtime_limit_reclaim",
  "idle_runtime_limit_reclaim",
]);

export type HostedRuntimeLifecycleEventKind = "origin.expired" | "runtime.stopped";

export interface HostedRuntimeLifecycleEventDetail {
  kind: HostedRuntimeLifecycleEventKind;
  projectId: string | null;
  reason?: string | null;
  /**
   * Whether this client has work of its own in the stopped space: a queued
   * message or a turn in flight (including jobs the stop requeued). Only a
   * reclaim stop consults it.
   */
  hasPendingWork?: boolean;
}

export function isRuntimeLimitReclaimStopReason(reason: string | null | undefined): boolean {
  return RUNTIME_LIMIT_RECLAIM_STOP_REASONS.has(reason?.trim().toLowerCase() ?? "");
}

const PENDING_RUN_STATUSES = new Set<RunRecord["status"]>([
  "queued",
  "in_progress",
  "awaiting_approval",
]);

/** A queued message or a turn still open in `projectId`, as this client knows it. */
export function hasPendingRunInProject(
  runs: Record<string, RunRecord> | null | undefined,
  projectId: string | null | undefined,
): boolean {
  const normalizedProjectId = projectId?.trim() ?? "";
  if (!normalizedProjectId || !runs) {
    return false;
  }
  return Object.values(runs).some(
    (run) => run?.projectId === normalizedProjectId && PENDING_RUN_STATUSES.has(run.status),
  );
}

export interface ResolveHostedRuntimeRecoveryInput {
  activeProjectId: string | null;
  runtimeControllerEnabled: boolean;
  projectReadyForRuntime: boolean;
  runtimeReady: boolean;
  hostedRuntimeEnsuring: boolean;
  hasHostedRuntimeInProgress: boolean;
  hasLocalRuntime: boolean;
  eventProjectId: string | null;
  eventAgeMs: number | null;
  maxEventAgeMs?: number;
}

export function shouldTrackHostedRuntimeLifecycleEvent(
  detail: HostedRuntimeLifecycleEventDetail,
): boolean {
  const projectId = detail.projectId?.trim() ?? "";
  if (!projectId) {
    return false;
  }
  if (detail.kind === "origin.expired") {
    return true;
  }
  const normalizedReason = detail.reason?.trim().toLowerCase() ?? "";
  if (isRuntimeLimitReclaimStopReason(normalizedReason)) {
    return detail.hasPendingWork === true;
  }
  return !MANUAL_RUNTIME_STOP_REASONS.has(normalizedReason);
}

export function shouldAttemptUnexpectedHostedRuntimeRecovery(
  input: ResolveHostedRuntimeRecoveryInput,
): boolean {
  const activeProjectId = input.activeProjectId?.trim() ?? "";
  const eventProjectId = input.eventProjectId?.trim() ?? "";
  if (!activeProjectId || !eventProjectId || activeProjectId !== eventProjectId) {
    return false;
  }
  if (!input.runtimeControllerEnabled || !input.projectReadyForRuntime) {
    return false;
  }
  if (
    input.runtimeReady ||
    input.hostedRuntimeEnsuring ||
    input.hasHostedRuntimeInProgress ||
    input.hasLocalRuntime
  ) {
    return false;
  }
  if (typeof input.eventAgeMs !== "number" || !Number.isFinite(input.eventAgeMs) || input.eventAgeMs < 0) {
    return false;
  }
  const maxAgeMs = input.maxEventAgeMs ?? UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS;
  return input.eventAgeMs <= maxAgeMs;
}
