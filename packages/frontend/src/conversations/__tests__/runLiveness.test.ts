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

  describe("a turn a stop put back in the queue", () => {
    const STOPPED_AT = Date.parse("2026-10-08T12:00:00.000Z");
    const RESUME_BY = "2026-10-08T12:15:00.000Z";

    // The run as the controller records the stop: queued again, at stage
    // "requeued", stamped with when it may give up on the turn.
    function interruptedRun(interruption: Record<string, unknown> = {}, overrides: Partial<RunRecord> = {}) {
      return createRun({
        status: "queued",
        progressStage: "requeued",
        metadata: {
          agentIdentity: { handle: "octo" },
          interruption: {
            reason: "user_stop",
            jobId: "job-1",
            interruptedAt: new Date(STOPPED_AT).toISOString(),
            resumeBy: RESUME_BY,
            ...interruption,
          },
        },
        createdAt: new Date(STOPPED_AT - 60_000).toISOString(),
        updatedAt: new Date(STOPPED_AT).toISOString(),
        ...overrides,
      });
    }

    it("keeps waiting past five minutes, until the controller may give up on it", () => {
      const run = interruptedRun();
      const afterFiveMinutes = STOPPED_AT + STALE_QUEUED_RUN_TIMEOUT_MS + 1_000;
      expect(isQueuedRunStale(run, afterFiveMinutes)).toBe(false);
      expect(isRunActivelyProgressing(run, afterFiveMinutes)).toBe(true);
      expect(isRunActivelyProgressing(run, Date.parse(RESUME_BY))).toBe(true);

      expect(isQueuedRunStale(run, Date.parse(RESUME_BY) + 1)).toBe(true);
      expect(isRunActivelyProgressing(run, Date.parse(RESUME_BY) + 1)).toBe(false);
      // Whatever the stop's reason: the controller holds every requeued turn as long.
      expect(isRunActivelyProgressing(interruptedRun({ reason: "heartbeat_timeout" }), afterFiveMinutes)).toBe(true);
      // The controller writes resumeBy with microseconds.
      const precise = interruptedRun({ resumeBy: "2026-10-08T12:15:00.123456+00:00" });
      expect(isRunActivelyProgressing(precise, afterFiveMinutes)).toBe(true);
    });

    it("keeps the five minutes without a readable resumeBy, or outside that exact shape", () => {
      const afterFiveMinutes = STOPPED_AT + STALE_QUEUED_RUN_TIMEOUT_MS + 1_000;
      for (const resumeBy of [undefined, null, "", "soon", 1_000]) {
        expect(isQueuedRunStale(interruptedRun({ resumeBy }), afterFiveMinutes)).toBe(true);
      }
      expect(isQueuedRunStale(interruptedRun({}, { progressStage: "agent:queued" }), afterFiveMinutes)).toBe(true);
      expect(isQueuedRunStale(interruptedRun({}, { metadata: { interruption: "user_stop" } }), afterFiveMinutes)).toBe(
        true,
      );
      // A resumeBy earlier than five minutes never makes the run stale sooner.
      const early = interruptedRun({ resumeBy: new Date(STOPPED_AT + 60_000).toISOString() });
      expect(isQueuedRunStale(early, STOPPED_AT + 120_000)).toBe(false);
      expect(isQueuedRunStale(early, afterFiveMinutes)).toBe(true);
    });

    it("waits no longer than an in-progress run stays live", () => {
      const run = interruptedRun({ resumeBy: "2026-10-09T12:00:00.000Z" });
      expect(isRunActivelyProgressing(run, STOPPED_AT + STALE_IN_PROGRESS_RUN_TIMEOUT_MS)).toBe(true);
      expect(isRunActivelyProgressing(run, STOPPED_AT + STALE_IN_PROGRESS_RUN_TIMEOUT_MS + 1)).toBe(false);
    });

    it("lives as an in-progress run again once a machine picks the turn up", () => {
      // The lease moves the run on and keeps the interruption as history.
      const resumed = interruptedRun({}, {
        status: "in_progress",
        progressStage: "agent:leased",
        updatedAt: new Date(STOPPED_AT + 600_000).toISOString(),
      });
      expect(isRunActivelyProgressing(resumed, Date.parse(RESUME_BY) + 60_000)).toBe(true);
      const resumedStaleAt = STOPPED_AT + 600_000 + STALE_IN_PROGRESS_RUN_TIMEOUT_MS;
      expect(isRunActivelyProgressing(resumed, resumedStaleAt + 1)).toBe(false);
    });
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
