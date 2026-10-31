import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import { synthesizeAgentJobThreadMessages } from "../chatMessagePresentation";
import { resolveRoutedBrowserFold } from "../routedBrowserFold";

// A message that names the browser goes straight to it: its job posts only a
// routed card, Studio opens the card by itself with the person's own words,
// and the browser turn answers. The chat reads that as one turn.
const WORDS = "Open https://forms.example/order in your browser and fill in a test order.";
const ROUTED_JOB = "11111111-1111-4111-8111-111111111111";
const ROUTED_RUN = "22222222-2222-4222-8222-222222222222";
const BROWSER_JOB = "33333333-3333-4333-8333-333333333333";
const BROWSER_RUN = "44444444-4444-4444-8444-444444444444";

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

const ask = message({ id: "ask", role: "user", authorId: "user-1", content: WORDS, timestamp: 1, metadata: { runId: ROUTED_RUN } });
function routedCard(routed = true): ChatMessage {
  return message({
    id: "card",
    content: "Continue this task in Instafy's browser.",
    timestamp: 2,
    messageType: "action_request",
    metadata: {
      messageType: "action_request",
      jobId: ROUTED_JOB,
      runId: ROUTED_RUN,
      details: { browserRequest: { task: WORDS, location: "auto", ...(routed ? { routed: true } : {}) } },
    },
  });
}
function continuation(autoStarted = true): ChatMessage {
  return message({
    id: "continuation",
    role: "user",
    authorId: "user-1",
    content: WORDS,
    timestamp: 3,
    metadata: {
      runId: BROWSER_RUN,
      browserRequestOf: `job:${ROUTED_JOB}`,
      browserTransport: "shared",
      ...(autoStarted ? { browserAutoStarted: true } : {}),
    },
  });
}
const step = message({
  id: "step",
  content: "Opened forms.example",
  timestamp: 4,
  messageType: "mcp_tool_call",
  metadata: { jobId: BROWSER_JOB, runId: BROWSER_RUN, source: "agent", kind: "update", outcome: "in_progress",
    messageType: "mcp_tool_call", details: { tool: "navigate", status: "completed" } },
});
const reply = message({
  id: "reply",
  content: "I filled in a test order and stopped before sending it.",
  timestamp: 5,
  metadata: { jobId: BROWSER_JOB, runId: BROWSER_RUN, source: "agent", outcome: "succeeded" },
});

function shown(messages: ChatMessage[]): string[] {
  return synthesizeAgentJobThreadMessages(messages, messages).map((entry) => entry.id);
}

describe("a message sent straight to the browser", () => {
  it("reads as the person's message and then the browser turn, once that turn shows something", () => {
    expect(shown([ask, routedCard(), continuation(), step, reply])).toEqual([
      "ask",
      `agent-job-thread:${BROWSER_JOB}`,
    ]);
  });

  it("keeps the card's opening line until the browser turn shows something, never the continuation", () => {
    expect(shown([ask, routedCard()])).toEqual(["ask", "card"]);
    expect(shown([ask, routedCard(), continuation()])).toEqual(["ask", "card"]);
  });

  it("leaves a card the person pressed, or one the routing step did not send, as it was", () => {
    expect(resolveRoutedBrowserFold([ask, routedCard(), continuation(false), step, reply]).hiddenPromptIds.size).toBe(0);
    expect(shown([ask, routedCard(), continuation(false), step, reply])).toContain("card");
    expect(shown([ask, routedCard(), continuation(false), step, reply])).toContain("continuation");
    const ordinary = [ask, routedCard(false), continuation(), step, reply];
    expect(resolveRoutedBrowserFold(ordinary).hiddenPromptIds.size).toBe(0);
    expect(shown(ordinary)).toContain("card");
    expect(shown(ordinary)).toContain("continuation");
  });
});
