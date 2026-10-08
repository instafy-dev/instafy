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

  it("refuses an older record whole, leaving the latest run untouched", () => {
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
