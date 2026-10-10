import type { RunRecord } from "../types";

export const UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS = 20_000;

// Someone stopped the machine on purpose: Stop, Remove, or another space
// taking over its slot.
const USER_RUNTIME_STOP_REASONS = new Set([
  "user_stop",
  "user_remove",
  "runtime_limit_takeover",
  "browser_session_runtime_limit_takeover",
]);

// Platform stops that a restart would hit again straight away: no credits,
// or the same memory wall.
const PLATFORM_HOLD_STOP_REASONS = new Set(["credits_exhausted", "oom_killed"]);

const MANUAL_RUNTIME_STOP_REASONS = new Set([
  ...USER_RUNTIME_STOP_REASONS,
  // Deliberate platform stops: auto-restarting would either undo the pause
  // (idle), immediately die again (credits_exhausted), or run straight back
  // into the same memory wall (oom_killed). The machine wakes via the normal
  // ensure path when the user writes in the chat, sends or presses Start.
  "idle",
  ...PLATFORM_HOLD_STOP_REASONS,
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

/**
 * A stop someone chose: Stop, Remove, or taking over the machine's slot for
 * another space. Both takeovers are a person's click. The automatic
 * browser-session recycle reuses `runtime_limit_takeover` and stops only a
 * machine without a live lease, but its requeue can still take a queued job
 * aimed at that machine, or a leased job whose lease expired, and when such a
 * turn expires it counts as a person's stop too.
 */
export function isPersonRuntimeStopReason(reason: string | null | undefined): boolean {
  return USER_RUNTIME_STOP_REASONS.has(reason?.trim().toLowerCase() ?? "");
}

/**
 * The hold a stop puts on its space in a tab that did not make it, so that
 * tab does not start the machine again: a person's stop holds like Stop does
 * in the tab that pressed it, a platform stop like an idle pause. Idle and
 * reclaim stops are held where they are explained, and any other reason
 * leaves recovery to decide. Only platform stops are published to other tabs
 * today; the controller records a person's stop without a runtime.stopped
 * event, so "manual_stop" applies once it sends one.
 */
export function resolveRuntimeStopHold(
  reason: string | null | undefined,
): "manual_stop" | "idle_pause" | null {
  if (isPersonRuntimeStopReason(reason)) {
    return "manual_stop";
  }
  const normalizedReason = reason?.trim().toLowerCase() ?? "";
  if (PLATFORM_HOLD_STOP_REASONS.has(normalizedReason)) {
    return "idle_pause";
  }
  return null;
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
  /**
   * A stop someone chose holds the space in this tab: its own Stop or Remove
   * (the manual hold), or an idle pause. The loss that follows is that stop.
   */
  stopHeld?: boolean;
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
  if (!input.runtimeControllerEnabled || !input.projectReadyForRuntime || input.stopHeld === true) {
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
