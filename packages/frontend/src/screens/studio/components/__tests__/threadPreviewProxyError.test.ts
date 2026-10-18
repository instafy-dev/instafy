import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import { resolveThreadRunStatusFromMessages } from "../threadPreviewHelpers";
import {
  isTerminalProxyErrorMessage,
  isTransientThreadUpdate,
  resolveTerminalProxyErrorMessage,
} from "../threadPreviewProxyError";

const JOB_ID = "0d4c9c1e-49af-4b1d-9a63-5b8f6f4f2f10";
const RETRY_CONTENT =
  "Retrying: unexpected status 502 Bad Gateway: The upstream request failed., url: http://proxy:8789/v1/responses";
const AUTH_FAILURE = `unexpected status 401 Unauthorized: ${JSON.stringify({
  error: {
    type: "upstream_error",
    code: "upstream_authentication_error",
    message: "The upstream provider rejected authentication.",
  },
})}, url: http://proxy:8789/v1/responses`;

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "content">): ChatMessage {
  return {
    role: "assistant",
    authorId: null,
    timestamp: 0,
    files: null,
    ...overrides,
  };
}

// The status update Codex streams while it reconnects after a proxy 502, as
// the controller stores it under the job.
function retryStatus(timestamp: number): ChatMessage {
  return message({
    id: "retry-status",
    content: RETRY_CONTENT,
    timestamp,
    messageType: "status",
    metadata: {
      jobId: JOB_ID,
      source: "agent",
      kind: "update",
      outcome: "in_progress",
      messageType: "status",
      details: {
        kind: "codex_stream_retry",
        event: { type: "stream_error", message: "Reconnecting... 1/1" },
      },
    },
  });
}

function successReply(timestamp: number): ChatMessage {
  return message({
    id: "final-reply",
    content: "Updated the hero copy and checked the page renders.",
    timestamp,
    metadata: { jobId: JOB_ID, source: "agent", kind: "result", outcome: "success" },
  });
}

function terminalFailure(content: string, timestamp: number): ChatMessage {
  return message({
    id: "final-failure",
    content,
    timestamp,
    messageType: "error",
    metadata: { jobId: JOB_ID, source: "agent", outcome: "failed", messageType: "error" },
  });
}

describe("threadPreviewProxyError", () => {
  it("treats a retry notice quoting a proxy error as transient", () => {
    const retry = retryStatus(1);
    expect(isTransientThreadUpdate(retry)).toBe(true);
    expect(isTerminalProxyErrorMessage(retry)).toBe(false);
  });

  it.each([
    ["a reasoning line", { messageType: "reasoning", metadata: { messageType: "reasoning" } }],
    ["an in-progress error update", { messageType: "error", metadata: { outcome: "in_progress" } }],
    ["a codex_retry status at the top level", { metadata: { kind: "codex_retry" } }],
    ["a bare Retrying: line", { metadata: {} }],
  ] as const)("ignores the proxy error quoted by %s", (_label, overrides) => {
    const candidate = message({ id: "candidate", content: RETRY_CONTENT, ...overrides });
    expect(isTerminalProxyErrorMessage(candidate)).toBe(false);
  });

  it("does not fail a run that recovered from a retried proxy 502", () => {
    const threadMessages = [retryStatus(1), successReply(2)];
    const runStatus = resolveThreadRunStatusFromMessages(threadMessages);
    expect(runStatus).toEqual({ phase: "completed", status: "success" });
    expect(resolveTerminalProxyErrorMessage(threadMessages, runStatus)).toBeNull();
  });

  it("lets a later successful reply supersede an earlier terminal-looking proxy error", () => {
    const threadMessages = [terminalFailure(AUTH_FAILURE, 1), successReply(2)];
    expect(
      resolveTerminalProxyErrorMessage(threadMessages, { phase: "unknown", status: null }),
    ).toBeNull();
  });

  it("lets a successful run status win over a proxy error", () => {
    const threadMessages = [message({ id: "legacy-error", content: AUTH_FAILURE })];
    expect(
      resolveTerminalProxyErrorMessage(threadMessages, { phase: "completed", status: "success" }),
    ).toBeNull();
  });

  it("still picks a genuine terminal proxy error", () => {
    const failure = terminalFailure(AUTH_FAILURE, 2);
    const threadMessages = [retryStatus(1), failure];
    const runStatus = resolveThreadRunStatusFromMessages(threadMessages);
    expect(resolveTerminalProxyErrorMessage(threadMessages, runStatus)).toBe(failure);
  });

  it("still picks a proxy error carried on a failed status line", () => {
    const failure = message({
      id: "failed-status",
      content: AUTH_FAILURE,
      messageType: "status",
      metadata: { messageType: "status", source: "agent", outcome: "failed" },
    });
    expect(resolveTerminalProxyErrorMessage([failure], { phase: "completed", status: "failed" })).toBe(
      failure,
    );
  });
});
