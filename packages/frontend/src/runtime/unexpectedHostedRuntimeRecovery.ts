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

export type HostedRuntimeLifecycleEventKind = "origin.expired" | "runtime.stopped";

export interface HostedRuntimeLifecycleEventDetail {
  kind: HostedRuntimeLifecycleEventKind;
  projectId: string | null;
  reason?: string | null;
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
