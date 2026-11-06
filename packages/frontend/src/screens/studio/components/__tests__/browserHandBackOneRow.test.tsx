// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapControllerMessageToChat } from "../../../../conversations/conversationMessageUtils";
import {
  placeReplyDrafts,
  replyDraftChatMessage,
  selectVisibleReplyDrafts,
  type ReplyDraft,
} from "../../../../conversations/replyDrafts";
import type { ControllerConversationMessage } from "../../../../services/runtimeController/conversations";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import {
  BrowserRequestHostContext,
  browserRequestContinuedKeys,
  newestBrowserRequestKey,
  type BrowserRequestHost,
} from "../browserRequest";
import { isBrowserNoticePrompt } from "../browserHandBack";
import { resolveTypingAgentLanes } from "../chatAssistantIdentity";
import { ChatTypingRows } from "../ChatTypingRows";
import { collapseLifecycleMessages, shouldDisplayChatMessage, synthesizeAgentJobThreadMessages } from "../chatMessagePresentation";
import { ConversationMessageRows } from "../ConversationMessageRows";
import { routedBrowserWaitingKeys } from "../routedBrowserFold";
import { resolveJobThreadTypingCoverage, resolveTranscriptTailKey } from "../typingIndicatorState";
import storedChats from "./fixtures/browserHandBackChats.json";

// A message Octo answers in its browser and then builds from what it found
// reads as one answer: one Octo row from the send to the card, with one line,
// one reply and the card. A local test, Nov 4: "Plan 3 days in Seville …, on
// a map." and the two messages of "Compare the three latest Framework laptops
// …" each showed the browser turn's row with only its line ("Opened 4 pages
// on visitasevilla.es ›"), then "Octo continued with what it found in the
// browser" across the chat, then a second Octo row with the reply and the
// card. Below are those chats' stored rows (their ids, order, roles, times and
// what Studio reads of their metadata), and their runs as their rows date them.

const mocks = vi.hoisted(() => ({
  runs: {} as Record<string, unknown>,
  // The chat as ChatPanel's provider holds it, for what a turn's row reads of
  // it (a stop notice, the runs it waits on); none unless a test says so.
  activeConversation: null as Record<string, unknown> | null,
}));

vi.mock("../../../../services/runtimeController/userInputRequests", () => ({
  getUserInputRequest: vi.fn(),
  answerUserInputRequest: vi.fn(),
}));
vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({ activeConversation: mocks.activeConversation, conversations: [] }),
}));
vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({ activeProjectId: "project-1" }),
}));
vi.mock("../../../../runtime/useRuntimeMenu", () => ({
  useRuntimeMenuOptions: () => ({ runtime: { effectiveRuntimeId: null, preferredRuntimeId: null } }),
}));
vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => ({ activeConversationId: "conversation-local", agentHandles: [] }),
}));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openConversationTab: vi.fn(), openJobThreadTab: vi.fn(), requestUrlPush: vi.fn() }),
}));
vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ runs: mocks.runs }),
}));

type StoredRow = Omit<ControllerConversationMessage, "conversationId" | "projectId" | "sessionId" | "promptId">;
const CHATS = storedChats as unknown as Record<"seville" | "framework" | "pizza", StoredRow[]>;

const CONVERSATION = "cd37f74a-8b1e-4fb8-9dc6-75989a1cf05d";
const PERSON = "person-1";
const OCTO = { id: "786d5f34-547e-4ca7-8a85-4e1dedec2401", handle: "octo", avatarSeed: "octo", displayName: "Octo" };
const HAND_BACK_NOTICE = "Octo continued with what it found in the browser";
/** The Seville map's building turn: the hand-back's run and the job that ran it. */
const SEVILLE_BUILD = { jobId: "4e9714c9-3bf5-4695-8611-6a58fb38cff0", runId: "a64022f9-e961-4e00-a854-3a7499157929" };

function chatOf(rows: StoredRow[]): ChatMessage[] {
  return rows.map((row) => mapControllerMessageToChat({
    ...row,
    conversationId: CONVERSATION,
    projectId: "project-1",
    sessionId: null,
    promptId: null,
  }));
}

/** Each run's record at a moment: running from its prompt until its last row. */
function runsAt(chat: ChatMessage[], now: number): RunRecord[] {
  const spans = new Map<string, { from: number; to: number; jobId: string | null }>();
  for (const message of chat) {
    const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId : null;
    if (!runId) continue;
    const span = spans.get(runId) ?? { from: message.timestamp, to: message.timestamp, jobId: null };
    span.to = Math.max(span.to, message.timestamp);
    if (typeof message.metadata?.jobId === "string") span.jobId ??= message.metadata.jobId;
    spans.set(runId, span);
  }
  return [...spans].filter(([, span]) => span.from <= now && now < span.to).map(([id, span]) => ({
    id, status: "in_progress", projectId: "project-1", conversationId: CONVERSATION, sessionId: null, promptId: null,
    runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
    createdAt: null, updatedAt: null, metadata: { ...(span.jobId ? { jobId: span.jobId } : {}), agent: OCTO },
  }));
}

/**
 * Whether a face shows at a width: phone hides the gutter and shows inline
 * faces; desktop does the reverse (as routedBrowserTurnOneRow.test.tsx reads it).
 */
function shows(element: Element, width: "phone" | "desktop"): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const classes = Array.from(node.classList);
    if (classes.includes("chat-typing-speaker-header")) return false;
    if (width === "phone" && (classes.includes("hidden") ||
      classes.includes("chat-message-avatar-gutter--responsive"))) return false;
    if (width === "desktop" && (classes.includes("sm:hidden") ||
      classes.includes("chat-narrow-speaker-identity") ||
      classes.includes("chat-speaker-inline-avatar--narrow") ||
      (classes.includes("hidden") && !classes.some((name) => /^sm:(block|flex|inline|inline-flex|grid)$/.test(name))))) {
      return false;
    }
  }
  return true;
}

describe("a message Octo answers in its browser and then builds from what it found", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const globalWithCss = globalThis as { CSS?: { escape?: (value: string) => string } };
    globalWithCss.CSS = {
      ...globalWithCss.CSS,
      escape: globalWithCss.CSS?.escape ?? ((value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")),
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    container.remove();
    mocks.runs = {};
    mocks.activeConversation = null;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  /**
   * What ChatPanel shows at `now`: the transcript from the stored rows
   * (collapse, display, job threads and folds), the reply drafts placed in
   * their turns, and the typing row under it, with the inputs ChatPanel gives each.
   */
  async function show(chat: ChatMessage[], now: number, drafts: ReplyDraft[] = [], given?: { runs: RunRecord[] }) {
    vi.setSystemTime(now);
    const messages = chat.filter((message) => message.timestamp <= now);
    const runs = given?.runs ?? runsAt(chat, now);
    mocks.runs = Object.fromEntries(runs.map((run) => [run.id, run]));
    const collapsed = collapseLifecycleMessages(messages);
    const displayed = synthesizeAgentJobThreadMessages(collapsed, collapsed.filter(shouldDisplayChatMessage));
    const visibleDrafts = selectVisibleReplyDrafts(drafts, messages, new Set(runs.map((run) => run.id)), now)
      .map(replyDraftChatMessage);
    const tail = displayed.at(-1);
    const isAssistantTyping = runs.length > 0;
    const coverage = resolveJobThreadTypingCoverage(tail, runs, messages);
    const covered = isAssistantTyping && coverage !== "none";
    const lanes = resolveTypingAgentLanes(runs, new Map());
    const lead = lanes.agents[0] ?? { handle: "octo", avatarSeed: "octo", displayName: "Octo", isThinking: false };
    const host: BrowserRequestHost = {
      transport: "shared",
      personalAvailable: false,
      sharedUnavailable: false,
      cardStates: new Map(),
      continuedKeys: browserRequestContinuedKeys(messages),
      routedWaitingKeys: routedBrowserWaitingKeys(messages),
      newestCardKey: newestBrowserRequestKey(messages),
    };
    const runIds = new Map(runs.map((run) => [run.id, OCTO]));
    await act(async () => {
      root.render(
        <BrowserRequestHostContext.Provider value={host}>
          <ConversationMessageRows
            messages={placeReplyDrafts(displayed, visibleDrafts)}
            currentUserId={PERSON}
            chatClientSessionId="session-1"
            projectId="project-1"
            runtimeId={null}
            conversationLocalId="conversation-local"
            conversationControllerId={CONVERSATION}
            firstPlanMessageId={null}
            humanLabelByUserId={new Map()}
            runAgentIdentityByRunId={runIds}
            runAgentHandleByRunId={new Map([...runIds.keys()].map((id) => [id, OCTO.handle]))}
            renderAssistantAvatar={() => <span data-testid="octo-face" />}
            assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
            onRequestActions={vi.fn()}
            onRequestActionsAtPoint={vi.fn()}
            onCancelTerminalCommand={null}
            onMessageContextMenu={vi.fn()}
          />
          <ChatTypingRows
            peerTypingLabel={null}
            isAssistantTyping={isAssistantTyping}
            isAssistantTypingCoveredByJobThreadPreview={covered}
            typingAgents={lanes.agents.length > 0 ? lanes.agents : [lead]}
            hasMultipleTypingAgents={lanes.agents.length > 1}
            typingAgentHandle={lead.handle}
            typingAgentAvatarSeed={lead.avatarSeed}
            typingIndicatorState={isAssistantTyping ? { phase: "thinking", label: "Thinking…" } : null}
            typingStatusLabel="Starting…"
            typingStatusAriaLabel="Octo is starting"
            isThinkingLabelExpanded={false}
            onToggleThinkingLabel={() => undefined}
            latestDisplayedMessageId={resolveTranscriptTailKey(tail)}
            latestDisplayedMessageEndsActiveTurn={false}
            renderAssistantAvatar={() => <span data-testid="octo-face" />}
          />
        </BrowserRequestHostContext.Provider>,
      );
    });
    const typingRow = container.querySelector<HTMLElement>('[data-testid="assistant-typing-indicator"]');
    const faces = Array.from(container.querySelectorAll(
      '[data-testid="octo-face"], [data-testid="chat-avatar-assistant"], [data-testid="assistant-thinking-octo-compact"]',
    ));
    return {
      // Octo's rows: those that name Octo, and its turns' rows, whose marker names no AI.
      octoRows: Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-speaker-marker"]'))
        .filter((marker) => !marker.dataset.agentHandle || marker.dataset.agentHandle === "octo").length,
      desktopFaces: faces.filter((face) => shows(face, "desktop")).length,
      typingRow: typingRow !== null && typingRow.getAttribute("aria-hidden") !== "true",
      notice: container.textContent?.includes(HAND_BACK_NOTICE) ?? false,
      lines: Array.from(container.querySelectorAll<HTMLElement>('[data-testid="turn-activity-line"] [data-sweep-text]'))
        .map((element) => element.dataset.sweepText ?? ""),
      // Each turn row's line is a running one (it announces its changes), not what the turn did.
      live: Array.from(container.querySelectorAll<HTMLElement>('[data-testid="turn-activity"]'))
        .map((line) => line.querySelector('[data-testid="turn-activity-announcement"]') !== null),
      // How the newest row covers the typing row: "live" while it is a turn at work.
      coverage,
      turns: Array.from(container.querySelectorAll<HTMLElement>('[data-testid="agent-job-thread-preview"]')),
    };
  }

  /** Every moment the chat changed, and a moment just after each. */
  function moments(chat: ChatMessage[]): number[] {
    return [...new Set(chat.flatMap((message) => [message.timestamp, message.timestamp + 150]))].sort((a, b) => a - b);
  }

  it("shows the map request as one Octo row from the send to the card, with no line across the chat", async () => {
    const chat = chatOf(CHATS.seville);
    const seen: Array<{ at: string; octoRows: number; faces: number; typingRow: boolean; notice: boolean }> = [];
    for (const now of moments(chat)) {
      const view = await show(chat, now);
      seen.push({
        at: new Date(now).toISOString().slice(11, 23),
        octoRows: view.octoRows,
        faces: view.desktopFaces,
        typingRow: view.typingRow,
        notice: view.notice,
      });
    }
    // Before Octo's first row, the typing row is its one row.
    const answered = seen.filter((moment) => moment.at >= "08:10:59.594");
    expect(answered.filter((moment) => moment.octoRows !== 1 || moment.faces !== 1 || moment.typingRow || moment.notice))
      .toEqual([]);

    // The hand-back went out, and its turn has shown nothing yet: the row goes on.
    const handedBack = await show(chat, Date.parse("2026-11-04T08:11:53.700Z"));
    expect(handedBack).toMatchObject({ octoRows: 1, typingRow: false, notice: false, lines: ["Thinking…"] });

    const done = await show(chat, Date.parse("2026-11-04T08:13:49.000Z"));
    expect(done).toMatchObject({ octoRows: 1, typingRow: false, notice: false });
    expect(done.lines).toEqual(["Opened 4 pages on visitasevilla.es, built the map"]);
    expect(done.turns).toHaveLength(1);
    const turn = done.turns[0]!;
    expect(turn.textContent).toContain("I built a three-day Seville map");
    expect(turn.textContent).toContain("Seville: first visit, 3 days");
  });

  it("shows each comparison message as one Octo row", async () => {
    const chat = chatOf(CHATS.framework);
    // The person's own messages: not the prompts Studio sent for Octo.
    const asked = (now: number) =>
      chat.filter((message) => message.timestamp <= now && message.role === "user" && !isBrowserNoticePrompt(message)).length;
    const seen: Array<{ at: string; octoRows: number; asked: number; typingRow: boolean; notice: boolean }> = [];
    for (const now of moments(chat)) {
      const view = await show(chat, now);
      seen.push({
        at: new Date(now).toISOString().slice(11, 23),
        octoRows: view.octoRows,
        asked: asked(now),
        typingRow: view.typingRow,
        notice: view.notice,
      });
    }
    // One answer per message, once the first one shows: never a second row,
    // a typing row under a turn's own row, or a line across the chat.
    expect(seen.filter((moment) => moment.at >= "08:18:07.130" &&
      (moment.octoRows !== moment.asked || moment.notice || (moment.typingRow && moment.at < "08:21:33.864"))))
      .toEqual([]);
    const done = await show(chat, Date.parse("2026-11-04T08:27:15.000Z"));
    // Two messages from the person, two answers.
    expect(done).toMatchObject({ octoRows: 2, typingRow: false, notice: false });
    expect(done.turns).toHaveLength(2);
    // The follow-up's browser turn opened 17 pages on frame.work, pcworld.com,
    // phoronix.com and tomshardware.com, and read 2 more there when an
    // opening's time ran out: its line counts them all, never two of the
    // sites and nothing of the others.
    expect(done.lines).toEqual([
      "Opened frame.work, edited a file",
      "Opened 19 pages on 4 sites, edited a file",
    ]);
    expect(done.turns[0]!.textContent).toContain("Built and opened the Framework laptop comparison page");
    expect(done.turns[1]!.textContent).toContain("Updated the comparison page");
  });

  // Played on the same stored rows: between the building turn's steps, the
  // one row read as done ("Opened 4 pages on visitasevilla.es, ran 2
  // commands") while that turn went on, the browser turn's reply being the
  // newest end of a turn it held; and a Stop then never read "Stopped".
  it("reads as at work from the hand-back until the building turn ends, never as done", async () => {
    const builds = [
      { chat: chatOf(CHATS.seville), from: "08:11:53.593", to: "08:13:48.358" },
      { chat: chatOf(CHATS.framework), from: "08:18:28.378", to: "08:19:45.550" },
      { chat: chatOf(CHATS.framework), from: "08:26:15.441", to: "08:27:14.166" },
    ];
    const notAtWork: string[] = [];
    for (const { chat, from, to } of builds) {
      for (const now of moments(chat)) {
        const at = new Date(now).toISOString().slice(11, 23);
        if (at < from || at >= to) continue;
        const view = await show(chat, now);
        const line = view.lines.at(-1) ?? "";
        if (!view.live.at(-1) || !line.endsWith("…") || view.coverage !== "live") {
          notAtWork.push(`${at} ${line} (${view.coverage})`);
        }
      }
    }
    expect(notAtWork).toEqual([]);
  });

  it("reads as stopped when the person stops the building turn between its steps", async () => {
    const stoppedAt = Date.parse("2026-11-04T08:12:15.000Z");
    // The controller's notice of the stop (conversations.rs build_interruption_notice).
    const notice: ChatMessage = {
      id: "stop-notice",
      role: "assistant",
      authorId: null,
      content: "Run stopped.",
      timestamp: stoppedAt,
      files: null,
      messageType: "run_cancellation",
      metadata: {
        source: "controller",
        kind: "run_cancellation",
        details: {
          stopRequested: true,
          actorUserId: PERSON,
          agentHandles: ["octo"],
          jobIds: [SEVILLE_BUILD.jobId],
          runIds: [SEVILLE_BUILD.runId],
          runStatus: "canceled",
        },
      },
    };
    const chat = [...chatOf(CHATS.seville).filter((message) => message.timestamp < stoppedAt), notice];
    mocks.activeConversation = { controllerId: CONVERSATION, messages: chat };
    const view = await show(chat, stoppedAt + 1_000);
    expect(view.turns).toHaveLength(1);
    expect(view.lines).toEqual(["Stopped · opened 4 pages on visitasevilla.es, ran 2 commands"]);
  });

  it("shows the building turn's failure in the row, also one posted for its run alone", async () => {
    const failedAt = Date.parse("2026-11-04T08:12:21.000Z");
    const failure = (jobId: string | null): ChatMessage => ({
      id: "build-failed",
      role: "assistant",
      authorId: null,
      content: "Instafy AI isn't answering right now.",
      timestamp: failedAt,
      files: null,
      messageType: "error",
      metadata: {
        ...(jobId ? { jobId } : {}),
        runId: SEVILLE_BUILD.runId,
        source: "agent",
        outcome: "failed",
        messageType: "error",
      },
    });
    for (const jobId of [SEVILLE_BUILD.jobId, null]) {
      const chat = [...chatOf(CHATS.seville).filter((message) => message.timestamp < failedAt), failure(jobId)];
      const view = await show(chat, failedAt + 1_000);
      expect(view.turns).toHaveLength(1);
      // The turn's failure block, in place of its line.
      expect(view.turns[0]!.querySelector('[data-testid="run-failure-body"]')?.textContent)
        .toContain("Instafy AI isn't answering right now.");
      expect(view.lines).toEqual([]);
    }
  });

  /** The rows of the turn's Details, opened from its line: each label with its second line, or the answer's words. */
  async function details(turn: HTMLElement): Promise<string[]> {
    const line = turn.querySelector<HTMLButtonElement>('button[data-testid="turn-activity-line"]');
    await act(async () => {
      line?.click();
    });
    return Array.from(turn.querySelectorAll<HTMLElement>('[data-testid="turn-activity-details"] [role="listitem"]'))
      .map((row) => {
        const approval = row.querySelector('[data-testid="turn-activity-approval"]');
        if (approval) return approval.textContent ?? "";
        const label = row.querySelector('[data-testid="turn-activity-step-label"]')?.textContent ?? "";
        const second = row.querySelector('[data-testid="turn-activity-step-label"] + span')?.textContent ?? "";
        const times = row.querySelector('[data-testid="turn-activity-step-times"] [aria-hidden="true"]')?.textContent ?? "";
        return [label, second, times].filter(Boolean).join(" ");
      });
  }

  it("lists both turns' steps in the one row's Details, each file from the space's folder", async () => {
    const chat = chatOf(CHATS.seville);
    const done = await show(chat, Date.parse("2026-11-04T08:13:49.000Z"));
    const rows = await details(done.turns[0]!);
    // The browser turn's pages, then the building turn's steps.
    expect(rows.slice(0, 3)).toEqual([
      "Used the browser",
      "Opened visitasevilla.es ×4",
      "Ran a command python AGENTS.py && pwd && rg --files -g 'AGENTS.md' -g 'package.json' -g 'map.config.json' | head -80",
    ]);
    expect(rows).toContain("Edited a file sites/seville-three-days/map.config.json");
    expect(rows.join("\n")).not.toContain("/workspace/");
    // A step of two add-points looked up more than one place.
    expect(rows.some((row) => row.startsWith("Looked up places cat "))).toBe(true);
  });

  // A local test, Nov 4: a form's submit the person said no to was listed
  // twice in Details, as "Tried browsing httpbin.org" and as "You said no to
  // a click on httpbin.org", and the turn's reply, while the model wrote it,
  // read "…the browser did not allow the final Submit order action…" for
  // about a second before the runtime's own sentence replaced it.
  describe("a step the person said no to", () => {
    const chat = chatOf(CHATS.pizza);
    const writing = (now: number): ReplyDraft => ({
      conversationId: CONVERSATION,
      jobId: "92adef49-1c98-485d-9a3c-0b8f8e04658b",
      runId: "95e6c84b-186c-4689-9632-29f8e3ec03fd",
      attempt: 0,
      segment: 1,
      seq: 9,
      text: "I filled in the made-up medium pizza order with bacon, but the browser did not allow the final Submit order action",
      startedAt: now,
      updatedAt: now,
    });

    it("is listed once in Details, by its answer", async () => {
      const done = await show(chat, Date.parse("2026-11-04T08:58:11.000Z"));
      const rows = await details(done.turns[0]!);
      expect(rows.filter((row) => row.startsWith("You said no"))).toEqual(["You said no to a click on httpbin.org"]);
      // The row before the answer is the step before it, never the step itself.
      expect(rows.at(-2)).toBe("Browsed httpbin.org ×7");
      expect(rows.at(-1)).toBe("You said no to a click on httpbin.org");
    });

    it("keeps the model's draft hidden until the runtime's sentence lands", async () => {
      const before = Date.parse("2026-11-04T08:58:08.000Z");
      const drafting = await show(chat, before, [writing(before)]);
      expect(drafting.turns).toHaveLength(1);
      expect(drafting.turns[0]!.querySelector('[data-testid="chat-reply-draft"]')).toBeNull();
      expect(drafting.turns[0]!.textContent).not.toContain("did not allow");
      const landed = await show(chat, Date.parse("2026-11-04T08:58:10.700Z"), [writing(before)]);
      expect(landed.turns[0]!.textContent).toContain("You said no, so that step didn't happen, and nothing from it was sent.");
      expect(landed.turns[0]!.textContent).not.toContain("did not allow");
    });
  });

  /** What the Seville map's building turn drafts of its reply, at `now`. */
  const buildDraft = (now: number, text: string): ReplyDraft => ({
    conversationId: CONVERSATION,
    jobId: SEVILLE_BUILD.jobId,
    runId: SEVILLE_BUILD.runId,
    attempt: 0,
    segment: 1,
    seq: 3,
    text,
    startedAt: now,
    updatedAt: now,
  });

  it("grows the building turn's reply in the browser turn's row", async () => {
    const chat = chatOf(CHATS.seville);
    const now = Date.parse("2026-11-04T08:13:44.500Z");
    const view = await show(chat, now, [buildDraft(now, "I built a three-day Seville map")]);
    expect(view).toMatchObject({ octoRows: 1, typingRow: false });
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]!.querySelector('[data-testid="chat-reply-draft"]')?.textContent).toBe("I built a three-day Seville map");
  });

  // Its words before its first step come while its job has written nothing
  // the chat keeps: the row knows that turn only by its run.
  it("grows what the building turn writes before its first step in the browser turn's row", async () => {
    const chat = chatOf(CHATS.seville);
    const now = Date.parse("2026-11-04T08:11:55.000Z");
    const view = await show(chat, now, [buildDraft(now, "I am building the Seville map")]);
    expect(view).toMatchObject({ octoRows: 1, typingRow: false });
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]!.querySelector('[data-testid="chat-reply-draft"]')?.textContent).toBe("I am building the Seville map");
  });

  it("keeps the row's Details open as the building turn starts", async () => {
    const chat = chatOf(CHATS.seville);
    const handedBack = await show(chat, Date.parse("2026-11-04T08:11:55.000Z"));
    await act(async () => {
      handedBack.turns[0]!.querySelector<HTMLButtonElement>('button[data-testid="turn-activity-line"]')?.click();
    });
    expect(container.querySelector('[data-testid="turn-activity-details"]')).not.toBeNull();
    const started = await show(chat, Date.parse("2026-11-04T08:11:59.300Z"));
    expect(started.turns).toHaveLength(1);
    expect(container.querySelector('[data-testid="turn-activity-details"]')).not.toBeNull();
  });

  it("goes on saying Octo is at work while the building turn waits for its machine", async () => {
    const sent = Date.parse("2026-11-04T08:11:53.600Z");
    const chat = chatOf(CHATS.seville).filter((message) => message.timestamp <= sent);
    mocks.activeConversation = { controllerId: CONVERSATION, messages: chat };
    // A minute on, its run still waits for a machine, and its job has written nothing.
    const waiting: RunRecord = {
      id: SEVILLE_BUILD.runId, status: "queued", projectId: "project-1", conversationId: CONVERSATION, sessionId: null,
      promptId: null, runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
      createdAt: new Date(sent).toISOString(), updatedAt: new Date(sent).toISOString(), metadata: { agent: OCTO },
    };
    const view = await show(chat, sent + 60_000, [], { runs: [waiting] });
    expect(view).toMatchObject({ octoRows: 1, typingRow: false, lines: ["Thinking…"] });
  });
});
