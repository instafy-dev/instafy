import { describe, expect, it } from "vitest";

import { buildRunFailureRetryMetadata } from "../../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../../types";
import {
  agentJobThreadAcknowledgementIds,
  collapseLifecycleMessages,
  shouldDisplayChatMessage,
  synthesizeAgentJobThreadMessages,
} from "../chatMessagePresentation";
import { isAutomaticRetryPending, readEarlierAttempts } from "../automaticRetryFold";

// Local Studio, Oct 28: a turn failed, Studio sent its prompt again by itself,
// and the chat showed the prompt twice, the failure with "Retried", and then
// the second turn. It now reads as one turn.
const PROMPT_TEXT =
  "roborock.com doesn't load, try www.roborock.com instead, then build the comparison page with what you can verify.";
const FAILED_JOB = "a00e3297-00b0-42d2-b168-40115fccf8ea";
const FAILED_RUN = "746e45cc-088e-42f0-8781-24d319e19d3c";
const RETRY_JOB = "9176f4c6-d088-4402-ad7f-9492aaf376e2";
const RETRY_RUN = "75a86477-9264-40a5-ac33-afe0f640dba7";
const RAW_FAILURE = "Codex did not apply any workspace changes for a file-modifying request.";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message",
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 0,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

function step(id: string, jobId: string, runId: string, timestamp: number): ChatMessage {
  return message({
    id,
    content: "/bin/bash -lc pwd",
    timestamp,
    messageType: "command_execution",
    metadata: {
      jobId,
      runId,
      source: "agent",
      kind: "update",
      outcome: "in_progress",
      messageType: "command_execution",
      details: { itemId: `item-${id}`, command: "/bin/bash -lc pwd", status: "completed", exitCode: 0 },
    },
  });
}

const prompt = message({ id: "prompt", role: "user", content: PROMPT_TEXT, timestamp: 1, metadata: { runId: FAILED_RUN } });
const retryStatus = message({
  id: "retry-status",
  content: "Retrying: accepted execution evidence is still missing.",
  timestamp: 2,
  messageType: "status",
  metadata: { jobId: FAILED_JOB, runId: FAILED_RUN, source: "agent", messageType: "status", kind: "codex_retry" },
});
const failure = message({
  id: "failure",
  content: RAW_FAILURE,
  timestamp: 4,
  messageType: "error",
  metadata: { jobId: FAILED_JOB, runId: FAILED_RUN, source: "agent", outcome: "failed", messageType: "error" },
});
const failedAttempt = [retryStatus, step("failed-pwd", FAILED_JOB, FAILED_RUN, 3), failure];

function resend(overrides: { automatic: boolean; runId?: string }): ChatMessage {
  return message({
    id: "resend",
    role: "user",
    content: PROMPT_TEXT,
    timestamp: 5,
    metadata: {
      ...(overrides.runId ? { runId: overrides.runId } : {}),
      prompt_metadata: buildRunFailureRetryMetadata(failure, { automatic: overrides.automatic }),
    },
  });
}

const retryReply = message({
  id: "retry-reply",
  content: "I can't try www.roborock.com in this run, so I left the comparison page unbuilt.",
  timestamp: 7,
  metadata: { jobId: RETRY_JOB, runId: RETRY_RUN, source: "agent", outcome: "succeeded" },
});

function transcript(messages: ChatMessage[]): ChatMessage[] {
  const all = collapseLifecycleMessages(messages);
  return synthesizeAgentJobThreadMessages(all, all.filter((candidate) => shouldDisplayChatMessage(candidate)));
}

function threadIds(row: ChatMessage | undefined): string[] {
  const threadMessages = (row?.metadata as Record<string, unknown> | null)?.threadMessages;
  return Array.isArray(threadMessages) ? (threadMessages as ChatMessage[]).map((entry) => entry.id) : [];
}

describe("an automatic retry reads as one turn", () => {
  it("leaves out the resent prompt and moves the failed attempt into the retry's Details", () => {
    const rows = transcript([
      prompt,
      ...failedAttempt,
      resend({ automatic: true, runId: RETRY_RUN }),
      step("retry-pwd", RETRY_JOB, RETRY_RUN, 6),
      retryReply,
    ]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${RETRY_JOB}`]);
    expect(threadIds(rows[1])).toEqual(["retry-pwd", "retry-reply"]);
    expect(readEarlierAttempts(rows[1]).map((attempt) => attempt.map((entry) => entry.id))).toEqual([
      ["retry-status", "failed-pwd", "failure"],
    ]);
    expect(isAutomaticRetryPending(rows[1])).toBe(false);
    // Reading the turn acknowledges the folded failure as well.
    expect(agentJobThreadAcknowledgementIds(rows[1])).toEqual(["retry-reply", "failure", "retry-status"]);
  });

  it("makes a retry that only replied a turn of its own, so its Details can hold the first try", () => {
    const rows = transcript([prompt, ...failedAttempt, resend({ automatic: true, runId: RETRY_RUN }), retryReply]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${RETRY_JOB}`]);
    expect(threadIds(rows[1])).toEqual(["retry-reply"]);
    expect(readEarlierAttempts(rows[1])).toHaveLength(1);
  });

  it("marks the failed turn as trying again until the retry shows something", () => {
    const rows = transcript([prompt, ...failedAttempt, resend({ automatic: true, runId: RETRY_RUN })]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${FAILED_JOB}`]);
    expect(isAutomaticRetryPending(rows[1])).toBe(true);
  });

  it("keeps the failed turn trying again while the retry has written only what the chat hides", () => {
    const usage = message({
      id: "retry-usage",
      content: "Token usage — input: 134669, cached: 132352, output: 165",
      timestamp: 6,
      messageType: "token_usage",
      metadata: { jobId: RETRY_JOB, runId: RETRY_RUN, source: "agent", messageType: "token_usage" },
    });
    const rows = transcript([prompt, ...failedAttempt, resend({ automatic: true, runId: RETRY_RUN }), usage]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${FAILED_JOB}`]);
    expect(isAutomaticRetryPending(rows[1])).toBe(true);
  });

  it("leaves a resend the controller has not taken to the page that sent it", () => {
    // No run yet: the page that sent it shows "Trying again…" while it goes
    // out, and its failure block again if it never does.
    const rows = transcript([prompt, ...failedAttempt, resend({ automatic: true })]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${FAILED_JOB}`]);
    expect(isAutomaticRetryPending(rows[1])).toBe(false);
  });

  it("keeps a resend the person asked for with Try again as they sent it", () => {
    const rows = transcript([
      prompt,
      ...failedAttempt,
      resend({ automatic: false, runId: RETRY_RUN }),
      step("retry-pwd", RETRY_JOB, RETRY_RUN, 6),
      retryReply,
    ]);

    expect(rows.map((row) => row.id)).toEqual([
      "prompt",
      `agent-job-thread:${FAILED_JOB}`,
      "resend",
      `agent-job-thread:${RETRY_JOB}`,
    ]);
    expect(readEarlierAttempts(rows[3])).toEqual([]);
  });
});
