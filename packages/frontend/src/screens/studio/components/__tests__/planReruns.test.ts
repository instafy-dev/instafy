import { describe, expect, it } from "vitest";
import { collectPlanReruns, describePlanRerun, PlanReruns, readRerunOf } from "../planReruns";

describe("plan reruns", () => {
  it("reads the job a plan job ran again, preferring the retry when a continuation was retried", () => {
    expect(readRerunOf({ continuation: { of: " job-1 ", turn: 1 } })).toEqual({ of: "job-1", reason: "turn_continuation" });
    expect(readRerunOf({ rateLimitRetry: { of: "job-1" } })).toEqual({ of: "job-1", reason: "rate_limit" });
    // The retry of turn 2 copies turn 2's continuation entry (which names turn 1).
    expect(readRerunOf({ continuation: { of: "job-1" }, rateLimitRetry: { of: "job-2" } }))
      .toEqual({ of: "job-2", reason: "rate_limit" });
    expect(readRerunOf({ continuation: { turn: 1 } })).toBeNull();
    expect(readRerunOf({ groupId: "group", parentJobId: "job-0" })).toBeNull();
    expect(readRerunOf(null)).toBeNull();
  });

  it("follows a lane through its continuations and keeps the reason it first ran again", () => {
    const reruns = collectPlanReruns([
      { metadata: { jobId: "job-2", multiAgentPlan: { continuation: { of: "job-1" } } } },
      { metadata: { job_id: "job-3", multi_agent_plan: { continuation: { of: "job-1" }, rateLimitRetry: { of: "job-2" } } } },
      { metadata: { jobId: "job-9", multiAgentPlan: { role: "worker" } } },
      { metadata: null },
    ]);
    expect(reruns.isSuperseded("job-1")).toBe(true);
    expect(reruns.isSuperseded("job-2")).toBe(true);
    expect(reruns.isSuperseded("job-3")).toBe(false);
    expect(reruns.isSuperseded("job-9")).toBe(false);
    expect(reruns.latest("job-1")).toEqual({ jobId: "job-3", reason: "turn_continuation" });
    expect(reruns.latest("job-2")).toEqual({ jobId: "job-3", reason: "rate_limit" });
    expect(reruns.latest("job-3")).toBeNull();
    expect(reruns.latest(null)).toBeNull();
  });

  it("reads the controller's retriedAs without letting it replace a rerun a job already names", () => {
    const reruns = new PlanReruns();
    reruns.addStatus("job-1", "job-2", "rate_limit");
    reruns.addStatus("job-4", null, null);
    expect(reruns.latest("job-1")).toEqual({ jobId: "job-2", reason: "rate_limit" });
    expect(reruns.isSuperseded("job-4")).toBe(false);
    reruns.addJob("job-6", { continuation: { of: "job-5" } });
    reruns.addStatus("job-5", "job-7", "rate_limit");
    expect(reruns.latest("job-5")).toEqual({ jobId: "job-6", reason: "turn_continuation" });
  });

  it("stops on a loop instead of following it forever", () => {
    const reruns = new PlanReruns();
    reruns.addJob("job-2", { continuation: { of: "job-1" } });
    reruns.addJob("job-1", { continuation: { of: "job-2" } });
    reruns.addJob("job-3", { continuation: { of: "job-3" } });
    expect(reruns.latest("job-1")).toEqual({ jobId: "job-2", reason: "turn_continuation" });
    expect(reruns.isSuperseded("job-3")).toBe(false);
  });

  it("says what happened without calling it a failure", () => {
    expect(describePlanRerun("turn_continuation")).toBe("ran out of turn time and continued in a new turn");
    expect(describePlanRerun("rate_limit")).toBe("stopped on a short rate limit and ran again");
    expect(describePlanRerun("")).toBe("continued in a new run");
    for (const reason of ["turn_continuation", "rate_limit", "something_new"]) {
      expect(describePlanRerun(reason)).not.toMatch(/fail/i);
    }
  });
});
