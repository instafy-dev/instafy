import { describe, expect, it } from "vitest";
import {
  requireExpectedJobForSteer,
  resolveComposerPrimaryActionMode,
  resolveExpectedSteerJobId,
  resolveSteerableComposerRuns,
} from "../composerSendMode";

describe("resolveSteerableComposerRuns", () => {
  const silentEvaluationRun = {
    id: "11111111-1111-4111-8111-111111111111",
    metadata: {
      jobId: "22222222-2222-4222-8222-222222222222",
      groupParticipation: {
        decision: "agent_evaluation",
        reason: "skill_mode_ambient",
      },
    },
  };
  const directRun = {
    id: "33333333-3333-4333-8333-333333333333",
    metadata: {
      jobId: "44444444-4444-4444-8444-444444444444",
      agent: { handle: "octo" },
    },
  };

  it("hides silent agent evaluations without hiding direct cross-device runs", () => {
    expect(resolveSteerableComposerRuns([silentEvaluationRun, directRun], [])).toEqual([
      directRun,
    ]);
  });

  it("allows an agent evaluation to become steerable once it starts speaking", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "I found something relevant.",
        timestamp: Date.now(),
        metadata: { runId: silentEvaluationRun.id },
      },
    ];

    expect(resolveSteerableComposerRuns([silentEvaluationRun], messages)).toEqual([
      silentEvaluationRun,
    ]);
  });
});

describe("resolveComposerPrimaryActionMode", () => {
  it("steers only a matching active agent", () => {
    expect(
      resolveComposerPrimaryActionMode({
        isAssistantActive: true,
        targetAgentHandles: ["reviewer"],
        activeAgentHandles: new Set(["reviewer"]),
      }),
    ).toBe("steer");
    expect(
      resolveComposerPrimaryActionMode({
        isAssistantActive: true,
        targetAgentHandles: ["planner"],
        activeAgentHandles: new Set(["reviewer"]),
      }),
    ).toBe("send");
  });

  it("never steers an untargeted record-only human message", () => {
    expect(
      resolveComposerPrimaryActionMode({
        isAssistantActive: true,
        targetAgentHandles: [],
        activeAgentHandles: new Set(["octo"]),
      }),
    ).toBe("send");
  });
});

describe("resolveExpectedSteerJobId", () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const jobId = "22222222-2222-4222-8222-222222222222";

  it("uses an explicit agent-job id", () => {
    expect(
      resolveExpectedSteerJobId({
        id: runId,
        metadata: { jobId },
      }),
    ).toBe(jobId);
  });

  it("does not mistake the RunRecord id for an agent-job id", () => {
    expect(
      resolveExpectedSteerJobId({
        id: runId,
        metadata: { runId },
      }),
    ).toBeNull();
    expect(resolveExpectedSteerJobId({ id: runId, metadata: null })).toBeNull();
  });

  it("uses one exact job id from message upserts for the active run", () => {
    expect(
      resolveExpectedSteerJobId(
        { id: runId, metadata: { runId } },
        [
          {
            role: "assistant",
            metadata: {
              runId: "33333333-3333-4333-8333-333333333333",
              jobId: "44444444-4444-4444-8444-444444444444",
            },
          },
          { role: "assistant", metadata: { runId, jobId } },
          { role: "assistant", metadata: { run_id: runId, job_id: jobId } },
        ],
      ),
    ).toBe(jobId);
  });

  it("falls back safely when one run reports multiple job ids", () => {
    expect(
      resolveExpectedSteerJobId(
        { id: runId, metadata: null },
        [
          { role: "assistant", metadata: { runId, jobId } },
          {
            role: "assistant",
            metadata: {
              runId,
              jobId: "55555555-5555-4555-8555-555555555555",
            },
          },
        ],
      ),
    ).toBeNull();
  });

  it("ignores human, nested, and malformed routing hints", () => {
    expect(
      resolveExpectedSteerJobId(
        { id: runId, metadata: { jobId: "not-a-uuid" } },
        [
          { role: "user", metadata: { runId, jobId } },
          {
            role: "assistant",
            metadata: { details: { runId, jobId } },
          },
        ],
      ),
    ).toBeNull();
  });

  it("fails closed when run metadata and its assistant messages disagree", () => {
    expect(
      resolveExpectedSteerJobId(
        { id: runId, metadata: { jobId } },
        [
          {
            role: "assistant",
            metadata: {
              runId,
              jobId: "55555555-5555-4555-8555-555555555555",
            },
          },
        ],
      ),
    ).toBeNull();
  });
});

describe("requireExpectedJobForSteer", () => {
  it("falls back to send when the active job cannot be fenced exactly", () => {
    expect(requireExpectedJobForSteer("steer", null)).toBe("send");
    expect(requireExpectedJobForSteer("steer", "job-1")).toBe("steer");
    expect(requireExpectedJobForSteer("send", "job-1")).toBe("send");
  });
});
