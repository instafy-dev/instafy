// A plan agent the controller started again in its group (a turn that ran out
// of time, or a run stopped by a short provider rate limit) is one lane, not a
// failure and a second lane: the new job's result stands for the old one's.
// The new job names the job it reruns in `metadata.multiAgentPlan.<reason>.of`;
// the controller's group status names it the other way, as `retriedAs`.

export type PlanRerun = {
  /** The job that ran the agent again. */
  jobId: string;
  /** Why: "turn_continuation", "rate_limit", or any other reason the controller names. */
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Where the controller records a rerun in the new job's plan metadata, with
// the reason it reports as `retriedFor`. A retry of a continuation turn
// carries both; the retry is what replaced the failed run, so it is read first.
const RERUN_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["rateLimitRetry", "rate_limit"],
  ["continuation", "turn_continuation"],
];

/** The job a plan job ran again, and why, from its `multiAgentPlan` metadata. */
export function readRerunOf(planMeta: Record<string, unknown> | null | undefined): { of: string; reason: string } | null {
  if (!planMeta) return null;
  for (const [key, reason] of RERUN_KEYS) {
    const entry = planMeta[key];
    const of = isRecord(entry) ? stringField(entry.of) : "";
    if (of) return { of, reason };
  }
  return null;
}

/**
 * Collects which jobs were run again and by which job: from the plan metadata
 * of the jobs that reran them, and from a group status's `retriedAs`.
 */
export class PlanReruns {
  private readonly next = new Map<string, PlanRerun>();

  /** Records the plan job `jobId` (with its `multiAgentPlan` metadata) if it reruns another. */
  addJob(jobId: string, planMeta: Record<string, unknown> | null | undefined): void {
    const rerun = readRerunOf(planMeta);
    if (jobId && rerun && rerun.of !== jobId) this.next.set(rerun.of, { jobId, reason: rerun.reason });
  }

  /** Records a group status worker's `retriedAs`/`retriedFor`. */
  addStatus(jobId: string, retriedAs: unknown, retriedFor: unknown): void {
    const rerun = stringField(retriedAs);
    if (jobId && rerun && rerun !== jobId && !this.next.has(jobId)) {
      this.next.set(jobId, { jobId: rerun, reason: stringField(retriedFor) });
    }
  }

  /** Whether another job ran this one's agent again (its result does not stand for the lane). */
  isSuperseded(jobId: string | null | undefined): boolean {
    return Boolean(jobId && this.next.has(jobId));
  }

  /**
   * The job that now stands for `jobId`'s lane (following a continuation that
   * was itself continued or retried), with the reason the lane first ran
   * again; null when nothing reran it.
   */
  latest(jobId: string | null | undefined): PlanRerun | null {
    if (!jobId) return null;
    const first = this.next.get(jobId);
    if (!first) return null;
    let current = first.jobId;
    const seen = new Set([jobId, current]);
    for (let step = this.next.get(current); step && !seen.has(step.jobId); step = this.next.get(current)) {
      current = step.jobId;
      seen.add(current);
    }
    return { jobId: current, reason: first.reason };
  }
}

/** A run record or chat message: its job id and plan metadata live in `metadata`. */
type WithMetadata = { metadata?: Record<string, unknown> | null };

function readPlanMeta(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const plan = metadata?.multiAgentPlan ?? metadata?.multi_agent_plan;
  return isRecord(plan) ? plan : null;
}

/** The reruns the given runs and messages record (each names the job it ran again). */
export function collectPlanReruns(items: Iterable<WithMetadata>, reruns = new PlanReruns()): PlanReruns {
  for (const item of items) {
    const metadata = isRecord(item.metadata) ? item.metadata : null;
    const planMeta = readPlanMeta(metadata);
    if (planMeta) reruns.addJob(stringField(metadata?.jobId ?? metadata?.job_id), planMeta);
  }
  return reruns;
}

/** What happened to a lane the controller started again, after its name: "@a ran out of …". */
export function describePlanRerun(reason: string): string {
  switch (reason) {
    case "turn_continuation":
      return "ran out of turn time and continued in a new turn";
    case "rate_limit":
      return "stopped on a short rate limit and ran again";
    default:
      return "continued in a new run";
  }
}
