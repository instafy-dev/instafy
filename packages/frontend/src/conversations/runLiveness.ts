import type { RunRecord } from "../types";

export const ACTIVE_CONVERSATION_RUN_STATUSES: ReadonlySet<RunRecord["status"]> = new Set([
  "queued",
  "in_progress",
  "awaiting_approval",
]);

export const STALE_QUEUED_RUN_TIMEOUT_MS = 5 * 60 * 1000;
export const STALE_IN_PROGRESS_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const STALE_AWAITING_LEASE_RUN_TIMEOUT_MS = 20_000;

function parseRunTimestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveRunActivityTimestamp(run: RunRecord): number {
  const updatedAt = parseRunTimestamp(run.updatedAt);
  if (updatedAt > 0) {
    return updatedAt;
  }
  const createdAt = parseRunTimestamp(run.createdAt);
  if (createdAt > 0) {
    return createdAt;
  }
  return 0;
}

export function resolveAwaitingLeaseRunExpiresAt(submittedAtMs: number | null | undefined): number | null {
  if (typeof submittedAtMs !== "number" || !Number.isFinite(submittedAtMs) || submittedAtMs <= 0) {
    return null;
  }
  return submittedAtMs + STALE_AWAITING_LEASE_RUN_TIMEOUT_MS;
}

export function isAwaitingLeaseRunStale(
  submittedAtMs: number | null | undefined,
  nowMs = Date.now(),
): boolean {
  const expiresAt = resolveAwaitingLeaseRunExpiresAt(submittedAtMs);
  if (expiresAt === null) {
    return false;
  }
  return nowMs > expiresAt;
}

export function isQueuedRunStale(run: RunRecord, nowMs = Date.now()): boolean {
  if (run.status !== "queued") {
    return false;
  }
  const activityTimestamp = resolveRunActivityTimestamp(run);
  if (activityTimestamp <= 0) {
    return false;
  }
  return nowMs - activityTimestamp > STALE_QUEUED_RUN_TIMEOUT_MS;
}

export function isInProgressRunStale(run: RunRecord, nowMs = Date.now()): boolean {
  if (run.status !== "in_progress") {
    return false;
  }
  const activityTimestamp = resolveRunActivityTimestamp(run);
  if (activityTimestamp <= 0) {
    return false;
  }
  return nowMs - activityTimestamp > STALE_IN_PROGRESS_RUN_TIMEOUT_MS;
}

export function isRunActivelyProgressing(run: RunRecord, nowMs = Date.now()): boolean {
  if (!ACTIVE_CONVERSATION_RUN_STATUSES.has(run.status)) {
    return false;
  }
  if (run.status === "queued" && isQueuedRunStale(run, nowMs)) {
    return false;
  }
  if (run.status === "in_progress" && isInProgressRunStale(run, nowMs)) {
    return false;
  }
  return true;
}
