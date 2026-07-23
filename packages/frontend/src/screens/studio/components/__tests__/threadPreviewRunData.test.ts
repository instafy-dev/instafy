import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import {
  isThreadPreviewRunInFlight,
  resolveThreadPreviewMessages,
} from "../threadPreviewRunData";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: "project-1",
    sessionId: null,
    conversationId: "thread-controller-1",
    promptId: null,
    runType: "prompt",
    status: "success",
    progress: 100,
    progressStage: null,
    previewUrl: null,
    lastMessage: "Checked `INSTAFY.md` and finished `/learn`.",
    metadata: null,
    createdAt: "2026-03-11T10:00:00.000Z",
    updatedAt: "2026-03-11T10:00:05.000Z",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    content: "Starting run…",
    timestamp: Date.parse("2026-03-11T10:00:00.000Z"),
    files: null,
    messageType: "status",
    metadata: {
      source: "agent",
      kind: "update",
      outcome: "in_progress",
      status: "queued",
    },
    ...overrides,
  };
}

describe("threadPreviewRunData", () => {
  it("synthesizes a terminal assistant message from the latest thread run when only in-progress preview data exists", () => {
    const threadMessages = [
      makeMessage({
        id: "placeholder-1",
        content: "Starting run…",
      }),
    ];

    const resolved = resolveThreadPreviewMessages({
      threadMessages,
      conversationControllerId: "thread-controller-1",
      runs: {
        "run-1": makeRun(),
      },
      jobId: "run-1",
    });

    expect(resolved).toHaveLength(2);
    expect(resolved.at(-1)?.content).toBe("Checked `INSTAFY.md` and finished `/learn`.");
    expect(resolved.at(-1)?.metadata?.status).toBe("success");
  });

  it("does not duplicate a terminal summary that already exists in the thread messages", () => {
    const threadMessages = [
      makeMessage({
        id: "summary-1",
        role: "assistant",
        content: "Checked `INSTAFY.md` and finished `/learn`.",
        messageType: null,
        metadata: {
          source: "agent",
          kind: "result",
          outcome: "success",
          status: "success",
        },
      }),
    ];

    const resolved = resolveThreadPreviewMessages({
      threadMessages,
      conversationControllerId: "thread-controller-1",
      runs: {
        "run-1": makeRun(),
      },
      jobId: "run-1",
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.id).toBe("summary-1");
  });

  it("does not let an older runtime alert suppress a newer synthesized success summary", () => {
    const threadMessages = [
      makeMessage({
        id: "runtime-alert-1",
        content: "Runtime is still connecting.",
        timestamp: Date.parse("2026-03-11T10:00:01.000Z"),
        messageType: null,
        metadata: {
          source: "controller",
          kind: "runtime_alert",
          details: {
            reason: "runtime_not_ready",
          },
        },
      }),
    ];

    const resolved = resolveThreadPreviewMessages({
      threadMessages,
      conversationControllerId: "thread-controller-1",
      runs: {
        "run-1": makeRun({
          updatedAt: "2026-03-11T10:00:05.000Z",
          lastMessage: "Finished after the runtime reconnected.",
        }),
      },
      jobId: "run-1",
    });

    expect(resolved).toHaveLength(2);
    expect(resolved.at(-1)?.content).toBe("Finished after the runtime reconnected.");
    expect(resolved.at(-1)?.metadata?.status).toBe("success");
  });

  it("keeps the latest controller cancellation notice instead of synthesizing another terminal message", () => {
    const threadMessages = [
      makeMessage({
        id: "cancellation-1",
        content: "Canceled 1 run.",
        timestamp: Date.parse("2026-03-11T10:00:06.000Z"),
        messageType: null,
        metadata: {
          source: "controller",
          kind: "run_cancellation",
          details: {
            reason: "Canceled",
            runCount: 1,
            finalStatus: "canceled",
          },
        },
      }),
    ];

    const resolved = resolveThreadPreviewMessages({
      threadMessages,
      conversationControllerId: "thread-controller-1",
      runs: {
        "run-1": makeRun({
          status: "canceled",
          updatedAt: "2026-03-11T10:00:05.000Z",
          lastMessage: "Run canceled.",
        }),
      },
      jobId: "run-1",
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.id).toBe("cancellation-1");
  });

  it("does not treat stale local pending ids as an in-flight thread once the run is already terminal", () => {
    const result = isThreadPreviewRunInFlight({
      jobId: "run-1",
      pendingRunIds: ["run-1"],
      awaitingLeaseRunIds: [],
      pendingRunSubmittedAt: {
        "run-1": Date.parse("2026-03-11T10:00:00.000Z"),
      },
      runs: {
        "run-1": makeRun({ status: "success" }),
      },
      conversationControllerId: "thread-controller-1",
      matchesRunToJobId: (run, jobId) => run.id === jobId,
      nowMs: Date.parse("2026-03-11T10:05:00.000Z"),
    });

    expect(result).toBe(false);
  });

  it("does not treat old in-progress run records as in-flight without fresh activity", () => {
    const result = isThreadPreviewRunInFlight({
      jobId: "run-1",
      pendingRunIds: ["run-1"],
      awaitingLeaseRunIds: [],
      pendingRunSubmittedAt: {
        "run-1": Date.parse("2026-03-11T10:00:00.000Z"),
      },
      runs: {
        "run-1": makeRun({
          status: "in_progress",
          updatedAt: "2026-03-11T10:00:00.000Z",
        }),
      },
      conversationControllerId: "thread-controller-1",
      matchesRunToJobId: (run, jobId) => run.id === jobId,
      nowMs: Date.parse("2026-03-11T10:31:00.000Z"),
    });

    expect(result).toBe(false);
  });

  it("keeps a thread in flight while the child conversation still has an active run", () => {
    const result = isThreadPreviewRunInFlight({
      jobId: "thread:local-thread",
      pendingRunIds: [],
      awaitingLeaseRunIds: [],
      pendingRunSubmittedAt: {},
      runs: {
        "run-1": makeRun({ status: "in_progress" }),
      },
      conversationControllerId: "thread-controller-1",
      matchesRunToJobId: () => false,
      nowMs: Date.parse("2026-03-11T10:00:02.000Z"),
    });

    expect(result).toBe(true);
  });
});
