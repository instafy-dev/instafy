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

/** The run once a machine picked the turn up again: the stop's record stays as history. */
function resumed(from: RunRecord = requeued(), overrides: Partial<RunRecord> = {}): RunRecord {
  return { ...from, status: "in_progress", progressStage: "agent:leased", updatedAt: LEASED_AT, ...overrides };
}

function upsert(state: RuntimeStoreState, record: RunRecord): RuntimeStoreState {
  return runtimeReducer(state, { type: "upsertRun", run: record });
}

function stateWith(record: RunRecord): RuntimeStoreState {
  return upsert(createInitialRuntimeStoreState(), record);
}

describe("runtime store run freshness", () => {
  it("keeps a turn a machine picked up again when the stop's announcement lands after it", () => {
    // The stop answers only once the machine is released, so the lease that
    // picked the turn up again, which keeps the stop's record as history, can
    // be announced first.
    const leased = resumed();
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
    // A queued record that records no stop, such as a stale snapshot.
    const queued = run({ status: "queued", progressStage: null, progress: 0, updatedAt: STOPPED_AT });
    for (const status of ["in_progress", "awaiting_approval"] as const) {
      const moved = stateWith(run({ status, updatedAt: LEASED_AT }));
      expect(upsert(moved, queued), status).toBe(moved);
    }
  });

  it("refuses an older step back whole, leaving the latest run untouched", () => {
    const other = run({ id: "run-2", updatedAt: LEASED_AT });
    const state = upsert(stateWith(resumed()), other);

    const next = upsert(state, requeued());
    expect(next).toBe(state);
    expect(next.latestRunIds).toEqual({ prompt: "run-2" });
  });

  describe("a stop's announcement, by the interruption it records", () => {
    // The controller stamps runs.updated_at with the start of the transaction
    // that writes it, so a requeue can carry an earlier time than a run update
    // that committed just before it.
    const TICKED_AT = "2026-10-08T12:00:00.500000+00:00";

    it("applies a stop the store has not seen, whatever its time", () => {
      for (const status of ["in_progress", "awaiting_approval"] as const) {
        const working = run({ status, progress: 30, lastMessage: "Running tests", updatedAt: TICKED_AT });
        expect(upsert(stateWith(working), requeued()).runs[RUN_ID], status).toEqual(requeued());
      }
    });

    it("refuses a late announcement of a stop the turn has already picked up from", () => {
      const leased = stateWith(resumed());
      // Also when it carries a later time than the lease.
      for (const updatedAt of [STOPPED_AT, "2026-10-08T12:00:05.000000+00:00"]) {
        expect(upsert(leased, requeued({ updatedAt })), updatedAt).toBe(leased);
      }
      // The same instant written another way is the same stop.
      const sameStop = requeued({
        metadata: {
          jobId: "job-1",
          interruption: { reason: "user_stop", jobId: "job-1", interruptedAt: "2026-10-08T12:00:00.123Z" },
        },
      });
      expect(upsert(leased, sameStop)).toBe(leased);
    });

    it("applies a later stop of a turn that picked up again", () => {
      const secondStopAt = "2026-10-08T12:00:05.000000+00:00";
      const second = requeued({
        metadata: {
          jobId: "job-1",
          interruption: { reason: "heartbeat_timeout", jobId: "job-1", interruptedAt: secondStopAt },
        },
        // Earlier than the progress the resumed turn reported just before it.
        updatedAt: secondStopAt,
      });
      const working = resumed(requeued(), { progress: 50, updatedAt: "2026-10-08T12:00:05.200000+00:00" });

      expect(upsert(stateWith(working), second).runs[RUN_ID]).toEqual(second);
    });

    it("refuses the late record of an earlier stop once a later one was recorded", () => {
      const secondStopAt = "2026-10-08T12:00:05.000000+00:00";
      const second = requeued({
        metadata: {
          jobId: "job-2",
          interruption: { reason: "user_stop", jobId: "job-2", interruptedAt: secondStopAt },
        },
        updatedAt: secondStopAt,
      });
      for (const stored of [second, resumed(second, { updatedAt: "2026-10-08T12:00:09.000000+00:00" })]) {
        const state = stateWith(stored);
        expect(upsert(state, requeued()), stored.status).toBe(state);
      }
    });

    it("keeps a finished turn finished against its stop's announcement", () => {
      for (const status of ["success", "failed", "canceled", "expired"] as const) {
        const finished = stateWith(
          resumed(requeued(), { status: status as RunRecord["status"], progress: 100, updatedAt: LEASED_AT }),
        );
        for (const updatedAt of [STOPPED_AT, "2026-10-08T12:03:00.000000+00:00"]) {
          expect(upsert(finished, requeued({ updatedAt })), `${status} at ${updatedAt}`).toBe(finished);
        }
      }
    });
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

  describe("a sparse patch over a run that keeps a stop's record", () => {
    // A viewer who cannot see the run's machine gets each run event projected
    // to its status and progress, stamped with runs.updated_at. Such a patch
    // names no stop, though merged over the stored run it shows the stored
    // one. A projected resume leaves the stored stage at "requeued".
    const resumedInPlace = () => stateWith(resumed(requeued(), { progressStage: "requeued" }));

    it("applies a later step back to the queue, such as a second stop", () => {
      const secondStopAt = "2026-10-08T12:00:09.000000+00:00";
      const next = runtimeReducer(resumedInPlace(), {
        type: "patchRun",
        patch: { id: RUN_ID, status: "queued", progress: 0, updatedAt: secondStopAt },
      });

      expect(next.runs[RUN_ID]).toMatchObject({ status: "queued", updatedAt: secondStopAt });
    });

    it("leaves an older one to the times, which refuse it", () => {
      const state = resumedInPlace();
      const next = runtimeReducer(state, {
        type: "patchRun",
        patch: { id: RUN_ID, status: "queued", progress: 0, updatedAt: STOPPED_AT },
      });

      expect(next).toBe(state);
    });

    it("still decides by the stop when the patch names one itself", () => {
      const state = stateWith(resumed());
      // Later than the lease, so the times alone would apply it.
      const announcement = requeued({ updatedAt: "2026-10-08T12:00:05.000000+00:00" });
      const next = runtimeReducer(state, { type: "patchRun", patch: announcement });

      expect(next).toBe(state);
    });
  });
});
