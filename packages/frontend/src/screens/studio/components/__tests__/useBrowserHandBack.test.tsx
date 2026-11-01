// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findPromptSentFromThisPageForRun,
  forgetPromptsSentFromThisPageForTests,
  recordRunsStartedByPromptSentFromThisPage,
  recordSendFailedForPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
} from "../../../../conversations/sentPromptRegistry";
import type { RunStatus } from "../../../../types";
import type { ChatMessage } from "../../types";
import {
  BROWSER_BUILD_REQUEST_NOTE_KEY,
  BROWSER_BUILD_REQUEST_RECORD_KEY,
  BROWSER_HAND_BACK_CLAIM_KEY,
  BROWSER_HAND_BACK_PROMPT,
  BROWSER_HAND_BACK_RECORD_KEY,
  browserBuildRequestNotice,
  browserHandBackCandidate,
  browserHandBackNotice,
  forgetBrowserHandBacksForTests,
  isBrowserNoticePrompt,
  isUnsentBrowserNoticePrompt,
  readBrowserHandBackOf,
  type BrowserHandBackInput,
} from "../browserHandBack";
import { useBrowserHandBack } from "../useBrowserHandBack";
import { BROWSER_HUMAN_INPUT_CONTINUE_PROMPT } from "../useBrowserHumanInput";

// The browser turn's reply and the hand-back's claim and prompt are the
// controller's fixture: the same file its dispatch test and the runtime's
// prompt test read, so the three halves of the hand-back cannot drift.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../../../..");
const fixtures = JSON.parse(readFileSync(
  resolve(repo, "packages/runtime-controller/src/browser_hand_back_fixtures.json"), "utf8",
)) as {
  claimKey: string; recordKey: string; handBackPrompt: string; browserReply: string; postedReply: string;
  findingLines: string[]; letOctoContinuePrompt: string; buildRequestNoteKey: string; buildRequestRecordKey: string;
};

const CARD_JOB = "job-card";
const BROWSER_JOB = "job-browser";

/** A prompt this page sent, and the run and job it started. */
function sent(jobId: string, metadata: Record<string, unknown>, timestamp: number, content = "Plan a day on the coast."): ChatMessage {
  const prompt = { id: `prompt-${jobId}`, metadata: { clientMessageId: `client-${jobId}`, ...metadata } };
  rememberPromptSentFromThisPage(prompt);
  recordRunsStartedByPromptSentFromThisPage({ metadata: { clientMessageId: `client-${jobId}` } }, [`run-${jobId}`, jobId]);
  return { id: prompt.id, role: "user", authorId: "user-1", content, timestamp, metadata: prompt.metadata };
}

function reply(jobId: string, content: string, timestamp: number, metadata: Record<string, unknown> = {}): ChatMessage {
  return { id: `reply-${jobId}-${timestamp}`, role: "assistant", content, timestamp, metadata: { jobId, ...metadata } };
}

/** The runtime's Details note with the finding lines it moved out of the reply. */
function findingsNote(jobId: string, timestamp: number, pagesRead = 2): ChatMessage {
  return reply(jobId, fixtures.findingLines.join("\n"), timestamp, {
    messageType: "status",
    details: { kind: "agent_message", browserFindings: { pages: fixtures.findingLines.length, pagesRead } },
  });
}

/**
 * The runtime's note on a browser turn that carried on the person's own
 * message, opened no page and asked Octo to make what it asks; its reply is
 * empty.
 */
function buildRequestNote(jobId: string, timestamp: number): ChatMessage {
  return reply(jobId, "This needs no website: Octo makes it in the chat.", timestamp, {
    messageType: "status",
    details: { kind: "agent_message", [BROWSER_BUILD_REQUEST_NOTE_KEY]: { version: 1 } },
  });
}

/**
 * The person's message, which the routing step sent straight to the browser
 * with a routed card that does not continue building, and its browser turn,
 * which opened no page and asked Octo to make it.
 */
function routedBuildRequest(now: number, note = true): ChatMessage[] {
  return [
    sent(CARD_JOB, {}, now - 60_000, "Plan three days in the old town, on a map."),
    reply(CARD_JOB, "Continue this task in Instafy's browser.", now - 50_000, {
      messageType: "action_request",
      details: { browserRequest: { task: "Plan three days in the old town, on a map.", location: "auto", routed: true } },
    }),
    sent(BROWSER_JOB, { browserRequestOf: `job:${CARD_JOB}`, browserTransport: "shared", browserAutoStarted: true },
      now - 40_000, "Plan three days in the old town, on a map."),
    ...(note ? [buildRequestNote(BROWSER_JOB, now - 1_100)] : []),
    reply(BROWSER_JOB, "", now - 1_000),
  ];
}

/** Card, browser turn, its findings note and reply: the chain as this page sent it. */
function chain(now: number, cardPrompt: Record<string, unknown> = {}): ChatMessage[] {
  return [
    sent(CARD_JOB, cardPrompt, now - 60_000),
    reply(CARD_JOB, "Continue this task in Instafy's browser.", now - 50_000, {
      messageType: "action_request",
      details: { browserRequest: { task: "Read the timetable", location: "auto", continueBuilding: true } },
    }),
    sent(BROWSER_JOB, { browserRequestOf: `job:${CARD_JOB}`, browserTransport: "shared", browserHandsBack: true },
      now - 40_000, "Opened Instafy's browser for rail.example.org"),
    findingsNote(BROWSER_JOB, now - 1_100),
    reply(BROWSER_JOB, fixtures.postedReply, now - 1_000),
  ];
}

describe("browser hand-back: when Studio sends one", () => {
  const now = 1_800_000_000_000;
  let input: BrowserHandBackInput;
  const statuses = new Map<string, RunStatus>();

  beforeEach(() => {
    forgetPromptsSentFromThisPageForTests();
    statuses.clear();
    statuses.set(BROWSER_JOB, "success");
    input = {
      messages: chain(now),
      openedAtMs: now - 120_000,
      activeRunIds: new Set(),
      runStatus: (id) => statuses.get(id) ?? null,
      sentPromptForRun: findPromptSentFromThisPageForRun,
      nowMs: now,
    };
  });

  it("names the claim and prompt the controller and runtime expect", () => {
    expect(BROWSER_HAND_BACK_CLAIM_KEY).toBe(fixtures.claimKey);
    expect(BROWSER_HAND_BACK_RECORD_KEY).toBe(fixtures.recordKey);
    expect(BROWSER_HAND_BACK_PROMPT).toBe(fixtures.handBackPrompt);
  });

  // A building turn reads a Let Octo continue press as one line; the
  // controller and the runtime know the press by this same text.
  it("sends the Let Octo continue words the controller and runtime know", () => {
    expect(BROWSER_HUMAN_INPUT_CONTINUE_PROMPT).toBe(fixtures.letOctoContinuePrompt);
  });

  it("hands back a finished browser turn that continued this page's card", () => {
    expect(browserHandBackCandidate(input)).toBe(BROWSER_JOB);
  });

  it("names the build request note and record the runtime and controller use", () => {
    expect(BROWSER_BUILD_REQUEST_NOTE_KEY).toBe(fixtures.buildRequestNoteKey);
    expect(BROWSER_BUILD_REQUEST_RECORD_KEY).toBe(fixtures.buildRequestRecordKey);
  });

  // A message the routing step sent to the browser asked for a map, which a
  // browser turn cannot make: it opened no page and asked Octo to make it. The
  // message goes to the building turn, though its card does not continue
  // building and no page was read; without the runtime's note it does not.
  it("hands back a message the browser turn asked Octo to make, from a card that does not continue building", () => {
    forgetPromptsSentFromThisPageForTests();
    input.messages = routedBuildRequest(now);
    expect(browserHandBackCandidate(input)).toBe(BROWSER_JOB);
    forgetPromptsSentFromThisPageForTests();
    input.messages = routedBuildRequest(now, false);
    expect(browserHandBackCandidate(input)).toBeNull();
  });

  it.each([
    ["the person wrote after it", () => {
      input.messages = [...input.messages, { id: "later", role: "user", content: "Never mind", timestamp: now }];
    }],
    ["the browser turn failed", () => { statuses.set(BROWSER_JOB, "failed"); }],
    ["another page sent the browser continuation", () => {
      forgetPromptsSentFromThisPageForTests();
      sent(CARD_JOB, {}, now - 60_000);
    }],
    ["it was handed back already", () => {
      input.messages = [...input.messages.slice(0, -1), {
        id: "hand-back", role: "user", content: browserBuildRequestNotice("Octo"), timestamp: now - 900,
        metadata: { prompt_metadata: { [BROWSER_HAND_BACK_RECORD_KEY]: { browserJobId: BROWSER_JOB } } },
      }, input.messages.at(-1)!];
    }],
  ] as const)("hands no build request back when %s", (_name, arrange) => {
    forgetPromptsSentFromThisPageForTests();
    input.messages = routedBuildRequest(now);
    arrange();
    expect(browserHandBackCandidate(input)).toBeNull();
  });

  it.each([
    ["the browser turn is still running", () => { input.activeRunIds = new Set([BROWSER_JOB]); }],
    ["the browser turn failed", () => { statuses.set(BROWSER_JOB, "failed"); }],
    ["the browser turn was canceled", () => { statuses.set(BROWSER_JOB, "canceled"); }],
    ["the person wrote after it", () => {
      input.messages = [...input.messages, { id: "later", role: "user", content: "Never mind", timestamp: now }];
    }],
    ["the browser turn stopped for the person's step on the page", () => {
      input.messages = [...input.messages, reply(BROWSER_JOB, "Tool call completed", now - 500, {
        messageType: "mcp_tool_call", details: { tool: "request_human_input", status: "completed" },
      })];
    }],
    ["a step's approval ended the browser turn", () => {
      input.messages = [...input.messages, reply(BROWSER_JOB, "Tool call failed", now - 500, {
        messageType: "mcp_tool_call", details: { tool: "click", status: "failed", terminalConsent: { state: "blocked" } },
      })];
    }],
    ["it was handed back already (the controller's copy, after a reload)", () => {
      input.messages = [...input.messages.slice(0, -1), {
        id: "hand-back", role: "user", content: browserHandBackNotice("Octo"), timestamp: now - 900,
        metadata: { prompt_metadata: { [BROWSER_HAND_BACK_RECORD_KEY]: { browserJobId: BROWSER_JOB } } },
      }, input.messages.at(-1)!];
    }],
    ["the reply is history from before the conversation was opened", () => { input.openedAtMs = now + 5_000; }],
    ["the reply is older than ten minutes", () => { input.nowMs = now + 11 * 60_000; }],
    ["another page sent the browser continuation", () => {
      forgetPromptsSentFromThisPageForTests();
      sent(CARD_JOB, {}, now - 60_000);
    }],
    ["another page sent the card's own prompt", () => {
      forgetPromptsSentFromThisPageForTests();
      sent(BROWSER_JOB, { browserRequestOf: `job:${CARD_JOB}`, browserTransport: "shared" }, now - 40_000);
    }],
    ["the card came from a hand-back turn: one automatic hop only", () => {
      forgetPromptsSentFromThisPageForTests();
      input.messages = chain(now, { [BROWSER_HAND_BACK_CLAIM_KEY]: "job-earlier-browser" });
    }],
    ["the card came from a browser turn", () => {
      forgetPromptsSentFromThisPageForTests();
      input.messages = chain(now, { browserTransport: "desktop-personal" });
    }],
    ["the card has no job to check", () => {
      forgetPromptsSentFromThisPageForTests();
      sent(CARD_JOB, {}, now - 60_000);
      sent(BROWSER_JOB, { browserRequestOf: "message:card-1", browserTransport: "shared" }, now - 40_000);
    }],
    ["the browser continuation was not a browser turn", () => {
      forgetPromptsSentFromThisPageForTests();
      sent(CARD_JOB, {}, now - 60_000);
      sent(BROWSER_JOB, { browserRequestOf: `job:${CARD_JOB}`, browserHandsBack: true }, now - 40_000);
    }],
    // Local drive, Oct 28: "find the opening hours" and "how do I get there
    // by tram" were each answered twice, once by a turn nobody asked for.
    ["the card was for a question: its browser turn answered it", () => {
      forgetPromptsSentFromThisPageForTests();
      sent(CARD_JOB, {}, now - 60_000);
      sent(BROWSER_JOB, { browserRequestOf: `job:${CARD_JOB}`, browserTransport: "shared" }, now - 40_000);
    }],
    ["the browser turn read no page", () => {
      input.messages = input.messages.map((message) =>
        message.id === findingsNote(BROWSER_JOB, now - 1_100).id ? findingsNote(BROWSER_JOB, now - 1_100, 0) : message);
    }],
    ["the browser turn left no findings", () => {
      input.messages = input.messages.filter((message) => message.id !== findingsNote(BROWSER_JOB, now - 1_100).id);
    }],
  ] as const)("sends nothing when %s", (_name, arrange) => {
    arrange();
    expect(browserHandBackCandidate(input)).toBeNull();
  });
});

describe("browser hand-back: how the chat shows it", () => {
  beforeEach(() => forgetPromptsSentFromThisPageForTests());

  it("reads the browser job from the claim as sent and from the controller's stored copy", () => {
    const local: ChatMessage = { id: "local", role: "user", content: "notice", timestamp: 1,
      metadata: { [BROWSER_HAND_BACK_CLAIM_KEY]: BROWSER_JOB } };
    const stored: ChatMessage = { id: "stored", role: "user", content: "notice", timestamp: 1,
      metadata: { [BROWSER_HAND_BACK_RECORD_KEY]: { browserJobId: BROWSER_JOB, findingCount: 4 } } };
    expect(readBrowserHandBackOf(local)).toBe(BROWSER_JOB);
    expect(readBrowserHandBackOf(stored)).toBe(BROWSER_JOB);
    expect(readBrowserHandBackOf({ ...stored, role: "assistant" })).toBeNull();
    expect(isBrowserNoticePrompt(stored)).toBe(true);
    expect(isBrowserNoticePrompt({ role: "user", metadata: { clientMessageId: "c" } })).toBe(false);
    expect(browserHandBackNotice("Octo")).toBe("Octo continued with what it found in the browser");
  });

  it("shows nothing for a hand-back the controller refused", () => {
    const message: ChatMessage = { id: "hb", role: "user", content: "notice", timestamp: 1,
      metadata: { clientMessageId: "client-hb", [BROWSER_HAND_BACK_CLAIM_KEY]: BROWSER_JOB } };
    rememberPromptSentFromThisPage(message);
    expect(isUnsentBrowserNoticePrompt(message)).toBe(false);
    recordSendFailedForPromptSentFromThisPage(message);
    expect(isUnsentBrowserNoticePrompt(message)).toBe(true);
  });
});

type Options = Parameters<typeof useBrowserHandBack>[0];
function Harness({ value }: { value: Options }) { useBrowserHandBack(value); return null; }

describe("useBrowserHandBack", () => {
  let root: Root;
  let container: HTMLDivElement;
  let value: Options;
  async function render() { await act(async () => root.render(<Harness value={{ ...value }} />)); }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    forgetPromptsSentFromThisPageForTests();
    forgetBrowserHandBacksForTests();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    value = {
      identity: "user/project/conversation", messages: [], canWrite: true, busy: false,
      activeRunIds: new Set(), runStatuses: new Map(), held: false, agentName: "Octo",
      send: vi.fn(async () => true),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  /** The conversation is open; then card, browser turn and reply arrive. */
  async function browserTurnFinishes() {
    await render();
    vi.advanceTimersByTime(5_000);
    value.messages = chain(Date.now());
    value.runStatuses = new Map([[BROWSER_JOB, "success"]]);
    await render();
  }

  it("sends one hand-back with the fixed prompt, a notice and the claim, once", async () => {
    await browserTurnFinishes();
    expect(value.send).toHaveBeenCalledExactlyOnceWith(fixtures.handBackPrompt, {
      display: "Octo continued with what it found in the browser",
      metadata: { [fixtures.claimKey]: BROWSER_JOB },
    });
    // Remounts and later renders never send it again.
    await render();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(value.send).toHaveBeenCalledTimes(1);
  });

  it("sends a build request with its own notice", async () => {
    await render();
    vi.advanceTimersByTime(5_000);
    value.messages = routedBuildRequest(Date.now());
    value.runStatuses = new Map([[BROWSER_JOB, "success"]]);
    await render();
    expect(value.send).toHaveBeenCalledExactlyOnceWith(fixtures.handBackPrompt, {
      display: "Octo continued in the chat",
      metadata: { [fixtures.claimKey]: BROWSER_JOB },
    });
  });

  it("waits while the person holds it (a draft, or a step of theirs in the browser) or a turn runs", async () => {
    value.held = true;
    await browserTurnFinishes();
    value.busy = true; value.held = false; await render();
    expect(value.send).not.toHaveBeenCalled();
    value.busy = false; await render();
    expect(value.send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a viewer who cannot write", async () => {
    value.canWrite = false;
    await browserTurnFinishes();
    expect(value.send).not.toHaveBeenCalled();
  });

  it("never sends a hand-back for a browser turn the person answered while it was held", async () => {
    value.held = true;
    await browserTurnFinishes();
    value.messages = [...value.messages, { id: "own", role: "user", content: "Use the later train.", timestamp: Date.now() }];
    value.held = false; await render();
    expect(value.send).not.toHaveBeenCalled();
  });
});
