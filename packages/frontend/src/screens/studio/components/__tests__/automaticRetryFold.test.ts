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

function resend(overrides: { automatic: boolean; runId?: string; content?: string }): ChatMessage {
  return message({
    id: "resend",
    role: "user",
    content: overrides.content ?? PROMPT_TEXT,
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

  // The chat leaves out only a resend it can see repeats the failed turn's
  // own prompt: a message marked automatic is anyone's to send, and it must
  // never hide words no one else has read.
  it("shows a message marked automatic that does not repeat the failed turn's prompt", () => {
    const rows = transcript([
      prompt,
      ...failedAttempt,
      resend({ automatic: true, runId: RETRY_RUN, content: "Also delete the pricing page." }),
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

  it("shows a resend whose failure is not in the loaded transcript", () => {
    // Only the newest page is loaded: the failed turn is out of view.
    const rows = transcript([
      resend({ automatic: true, runId: RETRY_RUN }),
      step("retry-pwd", RETRY_JOB, RETRY_RUN, 6),
      retryReply,
    ]);

    expect(rows.map((row) => row.id)).toEqual(["resend", `agent-job-thread:${RETRY_JOB}`]);
  });

  it("stops trying again once the resend failed before any job started", () => {
    // The controller refused the resend (here: no credits left) and wrote its
    // failure for the resend's run; no job ever ran it.
    const refused = message({
      id: "refused",
      content: "Paused: out of credits",
      timestamp: 6,
      messageType: "error",
      metadata: { runId: RETRY_RUN, source: "controller", outcome: "failed", messageType: "error" },
    });
    const rows = transcript([prompt, ...failedAttempt, resend({ automatic: true, runId: RETRY_RUN }), refused]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${FAILED_JOB}`, "refused"]);
    expect(isAutomaticRetryPending(rows[1])).toBe(false);
  });

});

// A local test: a turn failed (the AI didn't answer), the person
// pressed Try again, and the chat showed their message twice. Their resend now
// folds as Instafy's own does; it is still their turn (billing reads only
// `retryAutomatic`, which it does not carry).
describe("a resend the person asked for with Try again reads as one turn", () => {
  it("leaves out the repeated prompt and moves the failed attempt into the retry's Details", () => {
    const personResend = resend({ automatic: false, runId: RETRY_RUN });
    expect(JSON.stringify(personResend.metadata)).not.toContain("retryAutomatic");
    const rows = transcript([
      prompt,
      ...failedAttempt,
      personResend,
      step("retry-pwd", RETRY_JOB, RETRY_RUN, 6),
      retryReply,
    ]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${RETRY_JOB}`]);
    expect(readEarlierAttempts(rows[1]).map((attempt) => attempt.map((entry) => entry.id))).toEqual([
      ["retry-status", "failed-pwd", "failure"],
    ]);
  });

  it("marks the failed turn as trying again until the retry shows something", () => {
    const rows = transcript([prompt, ...failedAttempt, resend({ automatic: false, runId: RETRY_RUN })]);

    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${FAILED_JOB}`]);
    expect(isAutomaticRetryPending(rows[1])).toBe(true);
  });

  it("shows a resend with other words, or from someone else, as sent", () => {
    for (const other of [
      resend({ automatic: false, runId: RETRY_RUN, content: "Try roborock.de instead." }),
      { ...resend({ automatic: false, runId: RETRY_RUN }), authorId: "someone-else" },
    ]) {
      const rows = transcript([prompt, ...failedAttempt, other, step("retry-pwd", RETRY_JOB, RETRY_RUN, 6), retryReply]);

      expect(rows.map((row) => row.id)).toEqual([
        "prompt",
        `agent-job-thread:${FAILED_JOB}`,
        "resend",
        `agent-job-thread:${RETRY_JOB}`,
      ]);
      expect(readEarlierAttempts(rows[3])).toEqual([]);
    }
  });

  // Try again stays on an older failure, and a resend can wait behind a busy
  // turn: folded, the answer would sit under a later, unrelated message, and
  // the first prompt would have no answer.
  it("shows a resend that went out after another turn, and keeps the failed turn in place", () => {
    const OTHER_JOB = "c7a1b2d3-0000-4000-8000-000000000001";
    const OTHER_RUN = "c7a1b2d3-0000-4000-8000-000000000002";
    const otherPrompt = message({
      id: "other",
      role: "user",
      content: "Never mind, what's the weather in Porto?",
      timestamp: 4.2,
      metadata: { runId: OTHER_RUN },
    });
    const otherReply = message({
      id: "other-reply",
      content: "Sunny, 21 degrees.",
      timestamp: 4.4,
      metadata: { jobId: OTHER_JOB, runId: OTHER_RUN, source: "agent", outcome: "succeeded" },
    });
    for (const between of [[otherPrompt, otherReply], [otherReply]]) {
      for (const automatic of [false, true]) {
        const rows = transcript([
          prompt,
          ...failedAttempt,
          ...between,
          resend({ automatic, runId: RETRY_RUN }),
          step("retry-pwd", RETRY_JOB, RETRY_RUN, 6),
          retryReply,
        ]);

        expect(rows.map((row) => row.id)).toEqual([
          "prompt",
          `agent-job-thread:${FAILED_JOB}`,
          ...between.map((entry) => entry.id),
          "resend",
          `agent-job-thread:${RETRY_JOB}`,
        ]);
        expect(isAutomaticRetryPending(rows[1])).toBe(false);
        expect(readEarlierAttempts(rows.at(-1) as ChatMessage)).toEqual([]);
      }
    }
    // The retry's own first step stored just before its prompt is no other turn.
    const rows = transcript([
      prompt,
      ...failedAttempt,
      step("retry-pwd", RETRY_JOB, RETRY_RUN, 4.5),
      resend({ automatic: false, runId: RETRY_RUN }),
      retryReply,
    ]);
    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${RETRY_JOB}`]);
  });

  // Pressing Try again on a retry that failed too: the turn carries every try
  // before the one that answered, oldest first.
  it("carries every earlier try when a retry failed and was tried again", () => {
    const THIRD_JOB = "5b0c7d1e-0000-4000-8000-000000000003";
    const THIRD_RUN = "5b0c7d1e-0000-4000-8000-000000000004";
    const secondFailure = message({
      id: "failure-2",
      content: RAW_FAILURE,
      timestamp: 6.5,
      messageType: "error",
      metadata: { jobId: RETRY_JOB, runId: RETRY_RUN, source: "agent", outcome: "failed", messageType: "error" },
    });
    const secondResend = message({
      id: "resend-2",
      role: "user",
      content: PROMPT_TEXT,
      timestamp: 7,
      metadata: {
        runId: THIRD_RUN,
        prompt_metadata: buildRunFailureRetryMetadata(secondFailure, { automatic: false }),
      },
    });
    const thirdReply = message({
      id: "third-reply",
      content: "Built the comparison page.",
      timestamp: 9,
      metadata: { jobId: THIRD_JOB, runId: THIRD_RUN, source: "agent", outcome: "succeeded" },
    });
    const head = [
      prompt,
      ...failedAttempt,
      resend({ automatic: false, runId: RETRY_RUN }),
      step("retry-pwd", RETRY_JOB, RETRY_RUN, 6),
      secondFailure,
      secondResend,
    ];

    const pending = transcript(head);
    expect(pending.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${RETRY_JOB}`]);
    expect(isAutomaticRetryPending(pending[1])).toBe(true);

    const rows = transcript([...head, step("third-pwd", THIRD_JOB, THIRD_RUN, 8), thirdReply]);
    expect(rows.map((row) => row.id)).toEqual(["prompt", `agent-job-thread:${THIRD_JOB}`]);
    expect(readEarlierAttempts(rows[1]).map((attempt) => attempt.map((entry) => entry.id))).toEqual([
      ["retry-status", "failed-pwd", "failure"],
      ["retry-pwd", "failure-2"],
    ]);
    expect(agentJobThreadAcknowledgementIds(rows[1])).toEqual(
      expect.arrayContaining(["failure", "failure-2", "third-reply"]),
    );
  });
});
