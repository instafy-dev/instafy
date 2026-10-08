import type { RunRecord } from "../types";

/** A stop that put a running turn back in the queue, as the controller records it. */
export interface RunInterruption {
  /** The stop's reason, such as `user_stop` or `heartbeat_timeout`; "" when unnamed. */
  reason: string;
  /**
   * The earliest time the controller may give up on the turn, or null when
   * the record has no readable one.
   */
  resumeByMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The interruption a waiting run records, or null. A stop that cuts off a
 * running turn moves its run back to queued at progress stage `requeued` and
 * adds `metadata.interruption` {reason, jobId, interruptedAt, resumeBy}, both
 * live (run.progress) and on reload (GET /runs). A machine that picks the
 * turn up again moves the run on and leaves the record behind as history, so
 * it describes the run only in that exact shape. Controllers before this
 * record keep a cut-off run in progress and record nothing.
 */
export function readRunInterruption(run: RunRecord): RunInterruption | null {
  if (run.status !== "queued" || run.progressStage !== "requeued") {
    return null;
  }
  const interruption = run.metadata?.["interruption"];
  if (!isRecord(interruption)) {
    return null;
  }
  const reason = typeof interruption["reason"] === "string" ? interruption["reason"].trim().toLowerCase() : "";
  const resumeBy = typeof interruption["resumeBy"] === "string" ? Date.parse(interruption["resumeBy"]) : Number.NaN;
  return { reason, resumeByMs: Number.isFinite(resumeBy) ? resumeBy : null };
}
