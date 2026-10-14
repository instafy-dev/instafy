import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../../../types";
import { chatRunStopNeedsConfirmation, groupChatRunStopTargets, resolveChatRunStopTargets } from "../chatRunStopTargets";

const JOB = "aaaaaaaa-0000-4000-8000-000000000001";
const JOB_2 = "aaaaaaaa-0000-4000-8000-000000000002";
function run(id: string, metadata: RunRecord["metadata"], status: RunRecord["status"] = "in_progress"): RunRecord {
  return { id, metadata, status, projectId: "project", sessionId: null, conversationId: "chat", promptId: null,
    runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null, createdAt: null, updatedAt: null };
}

describe("chat run stop targets", () => {
  it("includes queued, thinking, and approval turns without command messages, but excludes terminal and ambiguous jobs", () => {
    const targets = resolveChatRunStopTargets([
      run("queued", { jobId: JOB }, "queued"), run("thinking", { jobId: JOB_2 }),
      run("ended", { jobId: "aaaaaaaa-0000-4000-8000-000000000003" }, "canceled"),
      run("ambiguous", { jobId: JOB, job_id: JOB_2 }), run("synthetic", { jobId: "thread:other" }),
      run("run-only-uuid", null),
    ], []);
    expect(targets.map((target) => target.jobId)).toEqual([JOB, JOB_2]);
  });
  it("resolves a missing job only from exact controller-authored assistant linkage", () => {
    const target = run("run-1", { agent: { handle: "octo" } });
    expect(resolveChatRunStopTargets([target], [{ id: "m", role: "user", content: "", timestamp: 0, metadata: { runId: "run-1", jobId: JOB } }])).toEqual([]);
    expect(resolveChatRunStopTargets([target], [{ id: "m", role: "assistant", content: "", timestamp: 0, metadata: { runId: "run-1", jobId: JOB } }])[0]).toMatchObject({ jobId: JOB, runId: "run-1", agentHandle: "octo" });
  });
  it("groups distinct jobs of one agent without losing any exact IDs", () => {
    const targets = resolveChatRunStopTargets([
      run("r1", { jobId: JOB, agent: { handle: "octo" }, initiatingUserId: "viewer" }),
      run("r2", { jobId: JOB_2, agent: { handle: "octo" }, initiatingUserId: "someone-else" }),
    ], []);
    expect(groupChatRunStopTargets(targets)).toMatchObject([{ handle: "octo", targets: [{ jobId: JOB }, { jobId: JOB_2 }] }]);
    expect(chatRunStopNeedsConfirmation(targets, "viewer")).toBe(true);
    expect(chatRunStopNeedsConfirmation(targets.slice(0, 1), "viewer")).toBe(false);
  });
  it("does not infer ownership from user-authored or nested runtime metadata", () => {
    const targets = resolveChatRunStopTargets([run("r1", { jobId: JOB, userId: "viewer", details: { initiatingUserId: "viewer" } })], []);
    expect(targets[0].initiatingUserId).toBeNull();
    expect(chatRunStopNeedsConfirmation(targets, "viewer")).toBe(true);
  });
});
