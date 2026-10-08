import type { RunRecord } from "../types";
import { readRunInterruption } from "./runInterruption";

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

/**
 * A turn a stop put back in the queue keeps waiting for a machine until the
 * controller may give up on it (`resumeBy`, 15 minutes after the stop), not
 * the five minutes a queued run gets, and never longer than an in-progress
 * run stays live. Without a readable `resumeBy` the five minutes apply.
 */
function resolveQueuedRunStaleAfter(run: RunRecord, activityTimestamp: number): number {
  const staleAfter = activityTimestamp + STALE_QUEUED_RUN_TIMEOUT_MS;
  const resumeByMs = readRunInterruption(run)?.resumeByMs ?? null;
  if (resumeByMs === null) {
    return staleAfter;
  }
  return Math.max(staleAfter, Math.min(resumeByMs, activityTimestamp + STALE_IN_PROGRESS_RUN_TIMEOUT_MS));
}

export function isQueuedRunStale(run: RunRecord, nowMs = Date.now()): boolean {
  if (run.status !== "queued") {
    return false;
  }
  const activityTimestamp = resolveRunActivityTimestamp(run);
  if (activityTimestamp <= 0) {
    return false;
  }
  return nowMs > resolveQueuedRunStaleAfter(run, activityTimestamp);
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
