import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../types";
import {
  STALE_AWAITING_LEASE_RUN_TIMEOUT_MS,
  STALE_IN_PROGRESS_RUN_TIMEOUT_MS,
  STALE_QUEUED_RUN_TIMEOUT_MS,
  isAwaitingLeaseRunStale,
  isInProgressRunStale,
  isQueuedRunStale,
  isRunActivelyProgressing,
  resolveAwaitingLeaseRunExpiresAt,
} from "../runLiveness";

function createRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "run-1",
    projectId: "project-1",
    sessionId: null,
    conversationId: "conversation-1",
    promptId: null,
    runType: "prompt",
    status: "queued",
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("runLiveness", () => {
  it("treats fresh queued runs as active", () => {
    const nowMs = Date.now();
    const run = createRun({
      status: "queued",
      updatedAt: new Date(nowMs - 15_000).toISOString(),
    });
    expect(isQueuedRunStale(run, nowMs)).toBe(false);
    expect(isRunActivelyProgressing(run, nowMs)).toBe(true);
  });

  it("treats stale queued runs as inactive", () => {
    const nowMs = Date.now();
    const run = createRun({
      status: "queued",
      updatedAt: new Date(nowMs - STALE_QUEUED_RUN_TIMEOUT_MS - 1_000).toISOString(),
    });
    expect(isQueuedRunStale(run, nowMs)).toBe(true);
    expect(isRunActivelyProgressing(run, nowMs)).toBe(false);
  });

  it("keeps fresh in-progress runs active", () => {
    const nowMs = Date.now();
    const run = createRun({
      status: "in_progress",
      updatedAt: new Date(nowMs - 15_000).toISOString(),
    });
    expect(isInProgressRunStale(run, nowMs)).toBe(false);
    expect(isRunActivelyProgressing(run, nowMs)).toBe(true);
  });

  it("treats stale in-progress runs as inactive when no heartbeat has arrived", () => {
    const nowMs = Date.now();
    const run = createRun({
      status: "in_progress",
      updatedAt: new Date(nowMs - STALE_IN_PROGRESS_RUN_TIMEOUT_MS - 1_000).toISOString(),
    });
    expect(isInProgressRunStale(run, nowMs)).toBe(true);
    expect(isRunActivelyProgressing(run, nowMs)).toBe(false);
  });

  it("expires awaiting-lease placeholders after a short timeout", () => {
    const nowMs = Date.now();
    const submittedAt = nowMs - STALE_AWAITING_LEASE_RUN_TIMEOUT_MS - 1_000;
    expect(resolveAwaitingLeaseRunExpiresAt(submittedAt)).toBe(
      submittedAt + STALE_AWAITING_LEASE_RUN_TIMEOUT_MS,
    );
    expect(isAwaitingLeaseRunStale(submittedAt, nowMs)).toBe(true);
    expect(isAwaitingLeaseRunStale(nowMs - 5_000, nowMs)).toBe(false);
  });
});
