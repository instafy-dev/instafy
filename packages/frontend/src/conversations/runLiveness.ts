import type { RunRecord } from "../types";
import { earlierTurnEndedAtMs, waitsForEarlierTurn } from "./messageTurns";
import { readRunInterruption } from "./runInterruption";

/** The runs a page has, by id, which a turn of a message's agents is read against. */
type RunsById = Readonly<Record<string, RunRecord>> | null | undefined;

export const ACTIVE_CONVERSATION_RUN_STATUSES: ReadonlySet<RunRecord["status"]> = new Set([
  "queued",
  "in_progress",
  "awaiting_approval",
]);

export const STALE_QUEUED_RUN_TIMEOUT_MS = 5 * 60 * 1000;
export const STALE_IN_PROGRESS_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const STALE_AWAITING_LEASE_RUN_TIMEOUT_MS = 20_000;
/**
 * How long a send still on its way to the controller keeps the typing row up
 * on its own. The send ends its mark when the controller answers or fails, so
 * this only bounds a request that never settles.
 */
export const STALE_DISPATCHING_SEND_TIMEOUT_MS = 30_000;

/** A send's mark (when it left for the controller) that no longer shows the typing row. */
export function isDispatchingSendStale(
  startedAtMs: number | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs) || startedAtMs <= 0) {
    return true;
  }
  return nowMs > startedAtMs + STALE_DISPATCHING_SEND_TIMEOUT_MS;
}

/** Whether a chat has a send on its way to the controller that still shows the typing row. */
export function hasDispatchingSend(
  dispatchingSince: Readonly<Record<string, number>> | null | undefined,
  nowMs = Date.now(),
): boolean {
  return Object.values(dispatchingSince ?? {}).some((startedAtMs) => !isDispatchingSendStale(startedAtMs, nowMs));
}

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

/**
 * Whether a queued run has waited too long to be live. A turn that waits for
 * an earlier agent's turn of its message (docs/Local-Engine-Turns.md 11.22)
 * is not stuck, however long that turn takes, and its own wait counts from
 * when that turn ended; both need the page's `runs`.
 */
export function isQueuedRunStale(run: RunRecord, nowMs = Date.now(), runs?: RunsById): boolean {
  if (run.status !== "queued") {
    return false;
  }
  if (waitsForEarlierTurn(run, runs)) {
    return false;
  }
  const activityTimestamp = Math.max(resolveRunActivityTimestamp(run), earlierTurnEndedAtMs(run, runs));
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

export function isRunActivelyProgressing(run: RunRecord, nowMs = Date.now(), runs?: RunsById): boolean {
  if (!ACTIVE_CONVERSATION_RUN_STATUSES.has(run.status)) {
    return false;
  }
  if (run.status === "queued" && isQueuedRunStale(run, nowMs, runs)) {
    return false;
  }
  if (run.status === "in_progress" && isInProgressRunStale(run, nowMs)) {
    return false;
  }
  return true;
}
