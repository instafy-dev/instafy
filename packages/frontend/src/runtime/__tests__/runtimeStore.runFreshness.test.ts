import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../types";
import { createInitialRuntimeStoreState, runtimeReducer, type RuntimeStoreState } from "../runtimeStore";

const RUN_ID = "run-1";
// The controller writes run times with microseconds.
const STOPPED_AT = "2026-10-08T12:00:00.123456+00:00";
const LEASED_AT = "2026-10-08T12:00:04.000000Z";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RUN_ID,
    projectId: "project-1",
    sessionId: null,
    conversationId: "conversation-1",
    promptId: null,
    runType: "prompt",
    status: "in_progress",
    progress: 1,
    progressStage: "agent:leased",
    previewUrl: null,
    lastMessage: null,
    metadata: { jobId: "job-1" },
    createdAt: "2026-10-08T11:58:00.000Z",
    updatedAt: "2026-10-08T11:58:01.000Z",
    ...overrides,
  };
}

/** The run as a stop that put it back in the queue records it. */
function requeued(overrides: Partial<RunRecord> = {}): RunRecord {
  return run({
    status: "queued",
    progressStage: "requeued",
    metadata: {
      jobId: "job-1",
      interruption: { reason: "user_stop", jobId: "job-1", interruptedAt: STOPPED_AT },
    },
    updatedAt: STOPPED_AT,
    ...overrides,
  });
}

function upsert(state: RuntimeStoreState, record: RunRecord): RuntimeStoreState {
  return runtimeReducer(state, { type: "upsertRun", run: record });
}

function stateWith(record: RunRecord): RuntimeStoreState {
  return upsert(createInitialRuntimeStoreState(), record);
}

describe("runtime store run freshness", () => {
  it("keeps a turn a machine picked up again when the stop's announcement lands after it", () => {
    // The lease's run.progress is stamped when it is sent; the stop's
    // announcement carries the earlier time the stop put the turn back.
    const leased = run({ updatedAt: LEASED_AT });
    const state = upsert(stateWith(leased), requeued());

    expect(state.runs[RUN_ID]).toEqual(leased);
  });

  it("applies a newer record whatever its status", () => {
    // A newer queued record after an in-progress one is a real requeue.
    const stopped = upsert(stateWith(run()), requeued());
    expect(stopped.runs[RUN_ID]).toMatchObject({ status: "queued", progressStage: "requeued", updatedAt: STOPPED_AT });

    const resumed = upsert(stopped, run({ updatedAt: LEASED_AT }));
    expect(resumed.runs[RUN_ID]).toMatchObject({ status: "in_progress", updatedAt: LEASED_AT });

    const completedAt = "2026-10-08T12:03:00.000Z";
    const completed = upsert(resumed, run({ status: "success", progress: 100, updatedAt: completedAt }));
    expect(completed.runs[RUN_ID]).toMatchObject({ status: "success", updatedAt: completedAt });
  });

  it("applies a record stamped at the same time, such as a repeated announcement", () => {
    const state = stateWith(requeued({ lastMessage: null }));
    // The same instant written with fewer digits.
    const repeat = requeued({ lastMessage: "Running sleep 120", updatedAt: "2026-10-08T12:00:00.123Z" });

    expect(upsert(state, repeat).runs[RUN_ID]).toEqual(repeat);
  });

  it("applies a record as before when either time is missing or unreadable", () => {
    for (const [stored, incoming] of [
      [null, "2026-10-08T11:00:00.000Z"],
      ["2026-10-08T12:00:00.000Z", null],
      ["soon", "2026-10-08T11:00:00.000Z"],
      ["2026-10-08T12:00:00.000Z", "later"],
    ] as const) {
      const record = run({ status: "success", updatedAt: incoming });
      expect(upsert(stateWith(run({ updatedAt: stored })), record).runs[RUN_ID], `${stored} -> ${incoming}`).toEqual(
        record,
      );
    }
  });

  it("applies an older record that finishes the turn, since times from two clocks can disagree", () => {
    // Live events carry the controller's clock, hydration and the run events
    // other viewers get carry the database's; a few milliseconds apart.
    const working = run({ updatedAt: "2026-10-08T12:03:00.004Z" });
    // "completed" reads as awaiting_approval (normalizeRunStatus).
    for (const status of ["success", "failed", "canceled", "awaiting_approval"] as const) {
      const finished = run({ status, progress: 100, updatedAt: "2026-10-08T12:03:00.001+00:00" });
      expect(upsert(stateWith(working), finished).runs[RUN_ID], status).toEqual(finished);
    }
  });

  it("applies an older record that moves the run forward or only reports progress", () => {
    const waiting = requeued();
    const leased = run({ updatedAt: "2026-10-08T12:00:00.120Z" });
    expect(upsert(stateWith(waiting), leased).runs[RUN_ID]).toEqual(leased);

    const tick = run({ progress: 20, lastMessage: "Running tests", updatedAt: "2026-10-08T12:00:03.990Z" });
    expect(upsert(stateWith(run({ progress: 10, updatedAt: LEASED_AT })), tick).runs[RUN_ID]).toEqual(tick);

    // From one end to another is not a step back either.
    const canceled = run({ status: "canceled", updatedAt: LEASED_AT });
    const success = run({ status: "success", updatedAt: STOPPED_AT });
    expect(upsert(stateWith(canceled), success).runs[RUN_ID]).toEqual(success);
  });

  it("refuses an older record that would reopen a finished turn", () => {
    const finishedAt = "2026-10-08T12:03:00.000Z";
    for (const status of ["success", "failed", "canceled", "merged", "expired"] as const) {
      const finished = stateWith(run({ status: status as RunRecord["status"], updatedAt: finishedAt }));
      for (const older of [run({ updatedAt: LEASED_AT }), requeued(), run({ status: "awaiting_approval" })]) {
        expect(upsert(finished, older), `${status} -> ${older.status}`).toBe(finished);
      }
    }
  });

  it("refuses an older queued record over a turn that had moved past the queue", () => {
    for (const status of ["in_progress", "awaiting_approval"] as const) {
      const moved = stateWith(run({ status, updatedAt: LEASED_AT }));
      expect(upsert(moved, requeued()), status).toBe(moved);
    }
  });

  it("refuses an older step back whole, leaving the latest run untouched", () => {
    const other = run({ id: "run-2", updatedAt: LEASED_AT });
    const state = upsert(stateWith(run({ updatedAt: LEASED_AT })), other);

    const next = upsert(state, requeued());
    expect(next).toBe(state);
    expect(next.latestRunIds).toEqual({ prompt: "run-2" });
  });

  it("holds a sparse lifecycle patch to the same rule", () => {
    const state = stateWith(run({ updatedAt: LEASED_AT }));

    const stale = runtimeReducer(state, {
      type: "patchRun",
      patch: { id: RUN_ID, status: "queued", updatedAt: STOPPED_AT },
    });
    expect(stale.runs[RUN_ID]).toMatchObject({ status: "in_progress", updatedAt: LEASED_AT });

    // A patch without a time keeps the stored one and applies.
    const preview = runtimeReducer(stale, {
      type: "patchRun",
      patch: { id: RUN_ID, previewUrl: "https://preview.example.test" },
    });
    expect(preview.runs[RUN_ID]).toMatchObject({ previewUrl: "https://preview.example.test", updatedAt: LEASED_AT });

    const completedAt = "2026-10-08T12:03:00.000Z";
    const completed = runtimeReducer(preview, {
      type: "patchRun",
      patch: { id: RUN_ID, status: "success", progress: 100, updatedAt: completedAt },
    });
    expect(completed.runs[RUN_ID]).toMatchObject({ status: "success", updatedAt: completedAt });
  });
});
