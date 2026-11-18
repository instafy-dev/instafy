import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../../../types";
import {
  forgetPromptsSentFromThisPageForTests,
  recordRunsStartedByPromptSentFromThisPage,
  rememberPromptSentFromThisPage,
} from "../../../../conversations/sentPromptRegistry";
import type { ChatMessage } from "../../types";
import { BROWSER_BUILD_REQUEST_NOTE_KEY, BROWSER_HAND_BACK_RECORD_KEY } from "../browserHandBack";
import { collapseLifecycleMessages, shouldDisplayChatMessage, synthesizeAgentJobThreadMessages } from "../chatMessagePresentation";
import { resolveRoutedBrowserFold } from "../routedBrowserFold";
import {
  chatRunStopBetweenParts,
  chatRunStopFollowOnTargets,
  chatRunStopNeedsConfirmation,
  chatRunStopOnScreen,
  groupChatRunStopTargets,
  resolveChatRunStopTargets,
  runsCanceledByStop,
  type ChatRunStopTarget,
} from "../chatRunStopTargets";

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
  it("reads canceled only the runs a committed Stop's answer names and the chat holds", () => {
    const runs = { r1: run("r1", { jobId: JOB }), r2: run("r2", { jobId: JOB_2 }), r3: run("r3", null, "canceled") };
    const stopped = runsCanceledByStop({ ok: true, canceledRunIds: ["r1", "r1", "r3", "unknown"] }, runs);
    expect(stopped).toEqual([{ ...runs.r1, status: "canceled" }]);
    expect(runsCanceledByStop({ ok: false, canceledRunIds: ["r1"] }, runs)).toEqual([]);
    expect(runsCanceledByStop({ ok: true, canceledRunIds: ["r1"] }, null)).toEqual([]);
  });
});

// A Stop pressed between two parts of a message stops the part that goes on
// by itself, and nothing anyone sends.
describe("the turns that carry a message on by themselves", () => {
  const target = (jobId: string, runId: string): ChatRunStopTarget =>
    ({ jobId, runId, agentHandle: "octo", agentDisplayName: "Octo", initiatingUserId: "viewer" });
  const prompt = (id: string, metadata: Record<string, unknown>): ChatMessage =>
    ({ id, role: "user", content: "words", timestamp: 1, metadata });

  it("are a browser card's continuation, a hand-back and Instafy's own retry, by the run their prompt names", () => {
    forgetPromptsSentFromThisPageForTests();
    const continuation = prompt("continuation", { runId: "run-browser", browserRequestOf: "job:card" });
    const handBack = prompt("hand-back", { runId: "run-build", browserHandBack: { browserJobId: "job-browser" } });
    const retry = prompt("retry", { runId: "run-retry", retryOfMessageId: "failure-1" });
    const own = prompt("own", { runId: "run-own" });
    const targets = [
      target("job-browser", "run-browser"), target("job-build", "run-build"), target("job-retry", "run-retry"),
      target("job-own", "run-own"),
    ];
    expect(chatRunStopFollowOnTargets(targets, [continuation, handBack, retry, own]).map((entry) => entry.jobId))
      .toEqual(["job-browser", "job-build", "job-retry"]);
    // Octo's own words naming such a claim are no prompt.
    expect(chatRunStopFollowOnTargets(targets, [{ ...handBack, role: "assistant" }])).toEqual([]);
  });

  it("are known by the runs a prompt this page sent started, before the controller's copy names them", () => {
    forgetPromptsSentFromThisPageForTests();
    const sent = prompt("sent", { clientMessageId: "client-hb", continuesFromBrowserJob: "job-browser" });
    rememberPromptSentFromThisPage(sent);
    expect(chatRunStopFollowOnTargets([target("job-build", "run-build")], [sent])).toEqual([]);
    recordRunsStartedByPromptSentFromThisPage(sent, ["run-build", "job-build"]);
    expect(chatRunStopFollowOnTargets([target("job-build", "run-build")], [sent]).map((entry) => entry.jobId))
      .toEqual(["job-build"]);
  });
});

// Stop stays while the chat's newest message passes from one of its parts to
// the next, which goes on by itself. Read from every routed card the chat
// ever had, a message that went to the browser kept such a gap for good:
// Stop stayed in a chat where nothing ran, a press said "Stopping…" with
// nothing to stop, and it stopped the person's next browser turn as it began.
describe("a message between two of its parts", () => {
  const WORDS = "Open https://forms.example/order in your browser and fill in a test order.";
  const ROUTED_JOB = "11111111-1111-4111-8111-111111111111";
  const ROUTED_RUN = "22222222-2222-4222-8222-222222222222";
  const BROWSER_JOB = "33333333-3333-4333-8333-333333333333";
  const BROWSER_RUN = "44444444-4444-4444-8444-444444444444";
  const BUILDING_JOB = "55555555-5555-4555-8555-555555555555";
  const BUILDING_RUN = "66666666-6666-4666-8666-666666666666";
  const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
    id: "message", role: "assistant", authorId: null, content: "", timestamp: 0, files: null, messageType: null, metadata: null,
    ...overrides,
  });
  // One message sent straight to the browser: the routing step's card, the
  // continuation Studio sent for it by itself, and the browser turn.
  function routed(n: number, at: number) {
    const job = (id: string) => (n === 1 ? id : id.replace(/^[0-9a-f]/, String(n + 6)));
    const ids = { routedJob: job(ROUTED_JOB), routedRun: job(ROUTED_RUN), browserJob: job(BROWSER_JOB), browserRun: job(BROWSER_RUN),
      buildingJob: job(BUILDING_JOB), buildingRun: job(BUILDING_RUN) };
    const ask = message({ id: `ask-${n}`, role: "user", authorId: "user-1", content: WORDS, timestamp: at, metadata: { runId: ids.routedRun } });
    const card = message({
      id: `card-${n}`, content: "Continue this task in Instafy's browser.", timestamp: at + 1, messageType: "action_request",
      metadata: { messageType: "action_request", jobId: ids.routedJob, runId: ids.routedRun,
        details: { browserRequest: { task: WORDS, location: "auto", routed: true } } },
    });
    const continuation = message({
      id: `continuation-${n}`, role: "user", authorId: "user-1", content: WORDS, timestamp: at + 2,
      metadata: { runId: ids.browserRun, browserRequestOf: `job:${ids.routedJob}`, browserTransport: "shared", browserAutoStarted: true },
    });
    const step = message({
      id: `step-${n}`, content: "Opened forms.example", timestamp: at + 3, messageType: "mcp_tool_call",
      metadata: { jobId: ids.browserJob, runId: ids.browserRun, source: "agent", kind: "update", outcome: "in_progress",
        messageType: "mcp_tool_call", details: { tool: "navigate", status: "completed" } },
    });
    const reply = message({
      id: `reply-${n}`, content: "I filled in a test order and stopped before sending it.", timestamp: at + 4,
      metadata: { jobId: ids.browserJob, runId: ids.browserRun, source: "agent", outcome: "succeeded" },
    });
    // The browser turn opened no page and handed the message to the building turn.
    const buildRequest = message({
      id: `build-request-${n}`, content: "This needs no website: Octo makes it in the chat.", timestamp: at + 3, messageType: "status",
      metadata: { jobId: ids.browserJob, runId: ids.browserRun, messageType: "status",
        details: { kind: "agent_message", [BROWSER_BUILD_REQUEST_NOTE_KEY]: { version: 1 } } },
    });
    const emptyReply = message({
      id: `empty-reply-${n}`, timestamp: at + 4, metadata: { jobId: ids.browserJob, runId: ids.browserRun, source: "agent", outcome: "succeeded" },
    });
    const handBack = message({
      id: `hand-back-${n}`, role: "user", authorId: "user-1", content: "Octo continued in the chat", timestamp: at + 5,
      metadata: { runId: ids.buildingRun, prompt_metadata: { [BROWSER_HAND_BACK_RECORD_KEY]: { browserJobId: ids.browserJob } } },
    });
    const buildingStep = message({
      id: `building-step-${n}`, content: "Ran a command", timestamp: at + 6, messageType: "command_execution",
      metadata: { jobId: ids.buildingJob, runId: ids.buildingRun, source: "agent", kind: "update", outcome: "in_progress",
        messageType: "command_execution", details: { status: "completed" } },
    });
    const buildingReply = message({
      id: `building-reply-${n}`, content: "I made the three-day map.", timestamp: at + 7,
      metadata: { jobId: ids.buildingJob, runId: ids.buildingRun, source: "agent", outcome: "succeeded" },
    });
    return { ask, card, continuation, step, reply, buildRequest, emptyReply, handBack, buildingStep, buildingReply };
  }
  const first = routed(1, 10);
  const browserOnly = [first.ask, first.card, first.continuation, first.step, first.reply];
  const browserThenBuild = [first.ask, first.card, first.continuation, first.buildRequest, first.emptyReply, first.handBack,
    first.buildingStep, first.buildingReply];

  /** As ChatPanel reads it: the chat's rows, and the routed cards still standing in, while a turn is on its way or once none is. */
  function between(messages: ChatMessage[], turnOnItsWay: boolean, gaps: { browserCardOpening?: boolean; handBackDue?: boolean } = {}) {
    const collapsed = collapseLifecycleMessages(messages);
    const rows = synthesizeAgentJobThreadMessages(collapsed, collapsed.filter(shouldDisplayChatMessage), turnOnItsWay);
    return chatRunStopBetweenParts({
      browserCardOpening: gaps.browserCardOpening ?? false,
      handBackDue: gaps.handBackDue ?? false,
      newestRow: rows.at(-1),
      routedWaitingKeys: resolveRoutedBrowserFold(messages, turnOnItsWay).waitingCardKeys,
    });
  }

  it("is not once a message sent straight to the browser has its answer, also one the browser handed to the building turn", () => {
    expect(between(browserOnly, false)).toBe(false);
    expect(between(browserThenBuild, false)).toBe(false);
    // Nor while a later message's own turn runs: that turn is Stop's to stop.
    const later = message({ id: "later", role: "user", authorId: "user-1", content: "Thanks!", timestamp: 40 });
    expect(between([...browserOnly, later], true)).toBe(false);
    expect(between([...browserThenBuild, later], true)).toBe(false);
  });

  it("is while a routed card stands in for its turn: from Studio's continuation until a turn that carries the message on shows something", () => {
    const sent = [first.ask, first.card, first.continuation];
    expect(between(sent, true)).toBe(true);
    expect(between(sent, false)).toBe(true);
    expect(between([...sent, first.step], true)).toBe(false);
    // Handed to the building turn: until that turn shows something.
    const handedBack = [...sent, first.buildRequest, first.emptyReply, first.handBack];
    expect(between(handedBack, false)).toBe(true);
    expect(between([...handedBack, first.buildingStep], true)).toBe(false);
    // Before its hand-back came, only while a turn of the chat is on its way.
    const noted = [...sent, first.buildRequest, first.emptyReply];
    expect(between(noted, true)).toBe(true);
    expect(between(noted, false)).toBe(false);
  });

  it("is for a newer message's card only, never for one an older message answered", () => {
    const second = routed(2, 30);
    expect(between([...browserOnly, second.ask, second.card, second.continuation], true)).toBe(true);
    expect(between([...browserOnly, second.ask, second.card, second.continuation, second.step, second.reply], false)).toBe(false);
    expect(between([...browserThenBuild, second.ask], true)).toBe(false);
  });

  it("is while Studio opens a card, a hand-back is due, or the newest row stands for a hand-back or a retry that has shown nothing", () => {
    expect(between(browserOnly, false, { browserCardOpening: true })).toBe(true);
    expect(between(browserOnly, false, { handBackDue: true })).toBe(true);
    // The browser turn read pages and the hand-back took them to the building turn.
    expect(between([...browserOnly, first.handBack], false)).toBe(true);
    expect(between([...browserOnly, first.handBack, first.buildingStep, first.buildingReply], false)).toBe(false);
    const retrying = message({ id: "row", metadata: { autoRetryPending: true } });
    expect(chatRunStopBetweenParts({ browserCardOpening: false, handBackDue: false, newestRow: retrying, routedWaitingKeys: new Set() }))
      .toBe(true);
    expect(chatRunStopBetweenParts({ browserCardOpening: false, handBackDue: false, newestRow: undefined, routedWaitingKeys: new Set() }))
      .toBe(false);
  });

  // ChatPanel is wired to a dozen providers, so mounting it in jsdom is not
  // practical (see chatPanelSharedBrowserLateAttach.test.ts): this reads the
  // source for what it gives Stop.
  it("is what ChatPanel gives Stop, from the newest row it shows", () => {
    const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
    const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");
    const start = chatPanel.indexOf("const stopBetweenParts = chatRunStopBetweenParts({");
    expect(start).toBeGreaterThan(-1);
    const call = chatPanel.slice(start, chatPanel.indexOf("});", start));
    expect(call).toContain("newestRow: displayedMessages[displayedMessages.length - 1],");
    expect(call).toContain("routedWaitingKeys: routedBrowserWaiting,");
    expect(chatPanel).toContain("between: stopBetweenParts,");
    expect(chatPanel).not.toContain("routedBrowserWaiting.size");
  });
});

// A sign-in pause in a local test: Studio brought the chat's Browser view
// forward by itself, and Stop went with the Chat view, though the turn that
// paused went on writing its reply for 14 s.
describe("where the chat offers Stop", () => {
  it("is in Chat and in the chat's Browser view, never in a job thread's tab", () => {
    expect(chatRunStopOnScreen({ chatVisible: true, browserVisible: false, jobThread: false })).toBe(true);
    expect(chatRunStopOnScreen({ chatVisible: false, browserVisible: true, jobThread: false })).toBe(true);
    expect(chatRunStopOnScreen({ chatVisible: true, browserVisible: true, jobThread: false })).toBe(true);
    // Another of the chat's views, a file or a preview, in front alone.
    expect(chatRunStopOnScreen({ chatVisible: false, browserVisible: false, jobThread: false })).toBe(false);
    expect(chatRunStopOnScreen({ chatVisible: true, browserVisible: false, jobThread: true })).toBe(false);
  });

  it("is what ChatPanel gives Stop", () => {
    const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
    const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");
    const start = chatPanel.indexOf("const runStop = useChatRunStop({");
    expect(start).toBeGreaterThan(-1);
    const call = chatPanel.slice(start, chatPanel.indexOf("});", start));
    expect(call).toContain("active: chatRunStopOnScreen({ chatVisible, browserVisible, jobThread: Boolean(jobThread) }),");
    // The Browser view keeps Escape for the browser, and Stop's words say so.
    expect(call).toContain("escapeStops: !browserVisible,");
  });
});
