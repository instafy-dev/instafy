import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import { BROWSER_BUILD_REQUEST_NOTE_KEY, BROWSER_HAND_BACK_CLAIM_KEY, BROWSER_HAND_BACK_RECORD_KEY } from "../browserHandBack";
import { shouldDisplayChatMessage, synthesizeAgentJobThreadMessages } from "../chatMessagePresentation";
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

// The browser turn's run failed before any job ran it.
const failedBeforeItRan = message({
  id: "failure",
  content: "The browser could not start.",
  timestamp: 4,
  messageType: "error",
  metadata: { runId: BROWSER_RUN, source: "agent", outcome: "failed", messageType: "error" },
});

// The person stopped it before it showed anything: the controller's notice.
const stoppedBeforeItShowedAnything = message({
  id: "stopped",
  content: "Stopped (1 run canceled.)",
  timestamp: 4,
  metadata: {
    runId: BROWSER_RUN,
    source: "controller",
    kind: "run_cancellation",
    details: { runIds: [BROWSER_RUN], jobIds: [BROWSER_JOB], outcome: "canceled", runStatus: "canceled" },
  },
});

describe("a routed card that is still opening", () => {
  it("is waiting while Studio's own continuation has shown nothing", () => {
    expect([...resolveRoutedBrowserFold([ask, routedCard(), continuation()]).waitingCardKeys])
      .toEqual([`job:${ROUTED_JOB}`]);
  });

  it("is not once the person pressed it, or its browser turn failed or was stopped before it showed anything", () => {
    expect(resolveRoutedBrowserFold([ask, routedCard(), continuation(false)]).waitingCardKeys.size).toBe(0);
    const failed = [ask, routedCard(), continuation(), failedBeforeItRan];
    expect(resolveRoutedBrowserFold(failed).waitingCardKeys.size).toBe(0);
    // The card stays, with the failure under it.
    expect(shown(failed)).toEqual(["ask", "card", "failure"]);
    const stopped = [ask, routedCard(), continuation(), stoppedBeforeItShowedAnything];
    expect(resolveRoutedBrowserFold(stopped).waitingCardKeys.size).toBe(0);
    expect(shown(stopped)).toContain("card");
  });
});

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

// The message asked Octo to make something, which a browser turn cannot do:
// its browser turn opened no page, posted no reply and ended with the
// runtime's note, and the hand-back the controller sent took the message to
// the building turn.
const BUILDING_JOB = "55555555-5555-4555-8555-555555555555";
const BUILDING_RUN = "66666666-6666-4666-8666-666666666666";
const buildRequestNote = message({
  id: "build-request",
  content: "This needs no website: Octo makes it in the chat.",
  timestamp: 4,
  messageType: "status",
  metadata: { jobId: BROWSER_JOB, runId: BROWSER_RUN, messageType: "status",
    details: { kind: "agent_message", [BROWSER_BUILD_REQUEST_NOTE_KEY]: { version: 1 } } },
});
const emptyReply = message({
  id: "empty-reply",
  content: "",
  timestamp: 5,
  metadata: { jobId: BROWSER_JOB, runId: BROWSER_RUN, source: "agent", outcome: "succeeded" },
});
function handBack(stored: boolean): ChatMessage {
  return message({
    id: "hand-back",
    role: "user",
    authorId: "user-1",
    content: "Octo continued in the chat",
    timestamp: 6,
    metadata: stored
      ? { runId: BUILDING_RUN, prompt_metadata: { [BROWSER_HAND_BACK_RECORD_KEY]: { browserJobId: BROWSER_JOB } } }
      : { [BROWSER_HAND_BACK_CLAIM_KEY]: BROWSER_JOB },
  });
}
const buildingStep = message({
  id: "building-step",
  content: "Ran a command",
  timestamp: 7,
  messageType: "command_execution",
  metadata: { jobId: BUILDING_JOB, runId: BUILDING_RUN, source: "agent", kind: "update", outcome: "in_progress",
    messageType: "command_execution", details: { status: "completed" } },
});
const buildingReply = message({
  id: "building-reply",
  content: "I made the three-day map.",
  timestamp: 8,
  metadata: { jobId: BUILDING_JOB, runId: BUILDING_RUN, source: "agent", outcome: "succeeded" },
});

/** What the chat lists, from the messages it shows (ChatPanel's groupedMessages). */
function listed(messages: ChatMessage[]): string[] {
  return synthesizeAgentJobThreadMessages(messages, messages.filter(shouldDisplayChatMessage)).map((entry) => entry.id);
}

describe("a message the browser turn handed to the building turn", () => {
  it("reads as the person's message and then the building turn: no card, no notice", () => {
    for (const stored of [false, true]) {
      const messages = [ask, routedCard(), continuation(), buildRequestNote, emptyReply, handBack(stored), buildingStep, buildingReply];
      expect(listed(messages)).toEqual(["ask", `agent-job-thread:${BUILDING_JOB}`]);
      const fold = resolveRoutedBrowserFold(messages);
      expect([...fold.buildRequestJobIds]).toEqual([BROWSER_JOB]);
      expect(fold.hiddenPromptIds.has("hand-back")).toBe(true);
    }
  });

  it("stops reading Opening as soon as the note arrives", () => {
    const messages = [ask, routedCard(), continuation(), buildRequestNote, emptyReply];
    expect(resolveRoutedBrowserFold(messages).waitingCardKeys.size).toBe(0);
    expect(listed(messages)).toEqual(["ask"]);
  });

  // The browser turn looked at the browser before it answered (its first step
  // has to be a tool call): that look shows while the turn runs, and goes with
  // the rest of the turn once the building turn has the message.
  it("shows nothing of the browser turn once its hand-back is in the chat", () => {
    const looked = message({
      id: "looked",
      content: "Looked at the browser",
      timestamp: 4,
      messageType: "mcp_tool_call",
      metadata: { jobId: BROWSER_JOB, runId: BROWSER_RUN, source: "agent", kind: "update", outcome: "in_progress",
        messageType: "mcp_tool_call", details: { tool: "status", status: "completed" } },
    });
    const ended = [ask, routedCard(), continuation(), looked, buildRequestNote, emptyReply];
    expect(listed(ended)).toEqual(["ask", `agent-job-thread:${BROWSER_JOB}`]);
    const handedBack = [...ended, handBack(true), buildingStep, buildingReply];
    expect(listed(handedBack)).toEqual(["ask", `agent-job-thread:${BUILDING_JOB}`]);
    expect([...resolveRoutedBrowserFold(ended).handedBackBuildRequestJobIds]).toEqual([]);
    expect([...resolveRoutedBrowserFold(handedBack).handedBackBuildRequestJobIds]).toEqual([BROWSER_JOB]);
  });

  // The controller could not send the hand-back (no prompts left, say): it
  // leaves the reason as the browser turn's reply, and the chat shows it.
  it("shows the reason a refused hand-back left as the browser turn's reply", () => {
    const reason = message({
      id: "reason",
      content: "Connect your own AI to continue. You have used all 20 Instafy AI prompts available today.",
      timestamp: 6,
      metadata: { jobId: BROWSER_JOB, runId: BROWSER_RUN },
    });
    const messages = [ask, routedCard(), continuation(), buildRequestNote, emptyReply, reason];
    expect(listed(messages)).toEqual(["ask", "reason"]);
  });

  it("keeps a hand-back of what a browser turn found as it was", () => {
    const messages = [ask, routedCard(), continuation(), step, reply, handBack(true), buildingStep, buildingReply];
    expect(resolveRoutedBrowserFold(messages).hiddenPromptIds.has("hand-back")).toBe(false);
    expect(listed(messages)).toContain("hand-back");
  });
});
