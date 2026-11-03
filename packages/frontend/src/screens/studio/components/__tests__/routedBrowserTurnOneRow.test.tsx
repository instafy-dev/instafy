// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapControllerMessageToChat } from "../../../../conversations/conversationMessageUtils";
import type { ControllerConversationMessage } from "../../../../services/runtimeController/conversations";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import {
  BrowserRequestHostContext,
  browserRequestContinuedKeys,
  newestBrowserRequestKey,
  type BrowserRequestCardState,
  type BrowserRequestHost,
} from "../browserRequest";
import { resolveTypingAgentLanes, type AssistantTypingAgent } from "../chatAssistantIdentity";
import { ChatTypingRows } from "../ChatTypingRows";
import { collapseLifecycleMessages, shouldDisplayChatMessage, synthesizeAgentJobThreadMessages } from "../chatMessagePresentation";
import { ConversationMessageRows } from "../ConversationMessageRows";
import { routedBrowserWaitingKeys } from "../routedBrowserFold";
import { resolveAgentWaitingActivityCopy } from "../runtimeAlertPresentation";
import {
  isTranscriptTailActiveTurnOutcome,
  resolveJobThreadTypingCoverage,
  resolveMultiAgentTypingStatus,
  resolveSingleAgentTypingStatus,
  resolveTranscriptTailKey,
  resolveTypingIndicatorState,
} from "../typingIndicatorState";

// A message Octo sends straight to Instafy's browser reads as one turn: one
// Octo row from the send to the reply. A local test, Nov 2: "Open
// www.visitporto.travel in your browser and find the Livraria Lello opening
// hours." The typing row's "Starting…", with a second Octo, sat under that
// turn's own row twice: under the routing step's card while that run's record
// caught up, and for about four seconds under the card's line "Opening
// Instafy's browser…", from the moment Studio sent the person's words on to
// the browser turn until that turn's first step took the card's place, when
// it went away by itself. Below are that chat's stored rows (their ids, order,
// roles, metadata and times, leaving out only fields nothing here reads) and
// its two runs as Studio held them, step by step.

const mocks = vi.hoisted(() => ({ runs: {} as Record<string, unknown> }));

vi.mock("../../../../services/runtimeController/userInputRequests", () => ({
  getUserInputRequest: vi.fn(),
  answerUserInputRequest: vi.fn(),
}));
vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({ activeConversation: null, conversations: [] }),
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

const CONVERSATION = "9bd1b2f6-9c61-45af-ad57-0c6ee60d0e59";
const PERSON = "person-1";
const WORDS = "Open www.visitporto.travel in your browser and find the Livraria Lello opening hours.";
const ROUTING_RUN = "a78bc4d8-8617-4689-a128-6408b6058272";
const ROUTING_JOB = "1ab0a401-d37a-45e5-9918-b28a692ffd65";
const BROWSER_RUN = "2d2ebd1c-1bd7-4ce0-a5a8-6cff896b39d8";
const BROWSER_JOB = "e20b847d-ca6a-47d1-bac6-ab94e320de4d";
const CARD_KEY = `job:${ROUTING_JOB}`;
const OCTO = { id: "786d5f34-547e-4ca7-8a85-4e1dedec2401", handle: "octo", avatarSeed: "octo", displayName: "Octo" };

const at = (time: string) => `2026-11-02T${time}Z`;

function stored(row: {
  id: string;
  role: "user" | "assistant";
  runId: string;
  time: string;
  content: string;
  metadata: Record<string, unknown>;
}): ChatMessage {
  const message: ControllerConversationMessage = {
    id: row.id,
    conversationId: CONVERSATION,
    projectId: "project-1",
    sessionId: null,
    createdBy: row.role === "user" ? PERSON : null,
    promptId: null,
    runId: row.runId,
    role: row.role,
    content: row.content,
    metadata: row.metadata,
    createdAt: at(row.time),
  };
  return mapControllerMessageToChat(message);
}

function browserStep(id: string, time: string, tool: string, status: string, activity: Record<string, unknown>) {
  return stored({
    id,
    role: "assistant",
    runId: BROWSER_RUN,
    time,
    content: `Tool call ${status === "in_progress" ? "started" : status}: instafy_shared_browser/${tool}`,
    metadata: {
      kind: "update",
      agent: OCTO,
      jobId: BROWSER_JOB,
      source: "agent",
      outcome: "in_progress",
      activity,
      messageType: "mcp_tool_call",
      details: {
        kind: "codex_mcp_tool_call",
        tool,
        server: "instafy_shared_browser",
        status,
        eventType: status === "in_progress" ? "item.started" : "item.completed",
        itemId: `exec-${id}`,
      },
    },
  });
}

const USE_THE_BROWSER = {
  v: 1, key: "browser/use", also: [], live: "Using the browser", done: "used the browser", role: "content",
  step: "snapshot", count: 1,
};
const openHost = (host: string) => ({
  v: 1, key: "browser/open", also: [], live: "Opening {host}", host, role: "content", step: "navigate",
  when: "success", count: 1,
  done: { one: "opened {host}", some: "opened pages on {host}", other: "opened {n} pages on {host}" },
});

const CHAT: ChatMessage[] = [
  stored({
    id: "a6adce77-36b0-4457-8867-02ccd43a29ad",
    role: "user",
    runId: ROUTING_RUN,
    time: "13:07:55.960",
    content: WORDS,
    metadata: {
      intent: "feature",
      prompt_metadata: {
        client: { userId: PERSON, sessionId: "session-1" },
        agentSelection: { active: ["octo"], mentions: [] },
        clientMessageId: "8eda4526-35a5-4e4d-a981-a1b5e1b666fc",
        conversationId: CONVERSATION,
      },
    },
  }),
  // The routing step's whole turn: a card for Instafy's browser.
  stored({
    id: "c832289d-50da-4554-b0c7-5641b9d1f45a",
    role: "assistant",
    runId: ROUTING_RUN,
    time: "13:07:59.673",
    content: "Continue this task in Instafy's browser.",
    metadata: {
      kind: "update",
      agent: OCTO,
      jobId: ROUTING_JOB,
      source: "agent",
      outcome: "in_progress",
      messageType: "action_request",
      details: {
        kind: "runtime_selection",
        source: "conversation",
        messageType: "action_request",
        details: {
          title: "Continue in Instafy's browser",
          testId: "browser-request-card",
          actions: [{
            id: "continue-browser", event: "instafy:request-browser", label: "Open browser and continue",
            testId: "browser-request-continue", variant: "primary", busyLabel: "Opening browser…",
          }],
          browserRequest: { task: WORDS, routed: true, location: "auto" },
        },
      },
    },
  }),
  // Studio opened that card by itself and sent the person's own words on.
  stored({
    id: "49e1e5ca-4602-4ea5-963a-58ecde923025",
    role: "user",
    runId: BROWSER_RUN,
    time: "13:08:00.463",
    content: WORDS,
    metadata: {
      intent: "feature",
      prompt_metadata: {
        client: { userId: PERSON, sessionId: "session-1" },
        agentSelection: { active: ["octo"], mentions: [] },
        browserCardTurn: { routed: true, version: 1, cardJobId: ROUTING_JOB },
        clientMessageId: "2c8bd5cc-1a14-417c-b41a-25fffbd83de7",
        conversationId: CONVERSATION,
        browserPageUrl: "about:blank",
        browserRequestOf: CARD_KEY,
        browserTransport: "shared",
        browserAutoStarted: true,
      },
    },
  }),
  browserStep("a84dfadc-4b3b-4ab4-aa8d-169fb785b5e8", "13:08:04.037", "snapshot", "in_progress", USE_THE_BROWSER),
  browserStep("06a4f15b-6295-4979-bd21-14d6a6ecb6ee", "13:08:04.584", "snapshot", "completed", USE_THE_BROWSER),
  browserStep("10dc29eb-2a04-44c0-bde3-3f11ffbbd32c", "13:08:09.017", "navigate", "in_progress", openHost("visitporto.travel")),
  browserStep("c45f71a0-24ef-457a-8094-ca818707386a", "13:08:29.585", "navigate", "failed", openHost("visitporto.travel")),
  browserStep("7b39166e-ec62-48b4-930a-3dd102c9d858", "13:08:34.306", "navigate", "in_progress", openHost("livrarialello.pt")),
  browserStep("2c7e174e-ece6-42c3-b6e6-d06e66bac4a3", "13:08:40.209", "navigate", "completed", openHost("livrarialello.pt")),
  stored({
    id: "605bdff9-e197-41f9-b8a8-bbaaa2c488d4",
    role: "assistant",
    runId: BROWSER_RUN,
    time: "13:08:42.988",
    content: "Livraria Lello’s official website lists its opening hours as daily, 9:00 a.m.–7:30 p.m.",
    metadata: { agent: OCTO, jobId: BROWSER_JOB, source: "agent", outcome: "succeeded", details: { kind: "runtime_selection" } },
  }),
];

function run(id: string, jobId: string, status: RunRecord["status"], metadata: Record<string, unknown> = {}): RunRecord {
  return {
    id, status, projectId: "project-1", conversationId: CONVERSATION, sessionId: null, promptId: null,
    runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
    createdAt: null, updatedAt: null, metadata: { jobId, agent: OCTO, ...metadata },
  };
}
const routingRun = (status: RunRecord["status"]) => run(ROUTING_RUN, ROUTING_JOB, status);
const browserRun = (status: RunRecord["status"]) =>
  run(BROWSER_RUN, BROWSER_JOB, status, { browserTransport: "shared", browserRequestOf: CARD_KEY });

type Step = {
  /** When, as the chat's rows and runs say. */
  time: string;
  /** The chat's runs that have not ended, as Studio holds them then. */
  runs: RunRecord[];
  /** A send whose run Studio has not seen yet still counts as one on its way. */
  awaitingLease?: boolean;
  /** What Studio's own start of the card says, once it decided. */
  card?: BrowserRequestCardState;
};

/**
 * What ChatPanel shows at one moment: the transcript from the stored rows
 * (collapse, display, job threads and folds) and the typing row it puts
 * under it, with the same inputs ChatPanel gives each.
 */
function chatPanel(step: Step) {
  const now = Date.parse(at(step.time));
  const messages = CHAT.filter((message) => message.timestamp <= now);
  const collapsed = collapseLifecycleMessages(messages);
  const displayed = synthesizeAgentJobThreadMessages(collapsed, collapsed.filter(shouldDisplayChatMessage));
  const tail = displayed.at(-1);
  const isAssistantTyping = step.runs.length > 0 || step.awaitingLease === true;
  const coverage = isAssistantTyping ? resolveJobThreadTypingCoverage(tail, step.runs, messages) : "none";
  // Who the typing row speaks for, as ChatPanel works it out: one lane per AI
  // at work (the newest run first), Octo while a send waits for its run.
  const lanes = resolveTypingAgentLanes(step.runs, new Map());
  const agents: AssistantTypingAgent[] = lanes.agents.length > 0
    ? lanes.agents
    : [{ handle: "octo", avatarSeed: "octo", displayName: "Octo", isThinking: false }];
  const lead = agents[0]!;
  // The typing row's phase and words: a run in progress is thinking (Octo's
  // phone-only face moves), anything else waits; two AIs at work read as a
  // count.
  const activeRun = step.runs[0] ?? null;
  const state = isAssistantTyping
    ? resolveTypingIndicatorState(
      messages,
      activeRun?.status === "in_progress" ? { phase: "thinking", label: "Thinking…" } : { phase: "waiting", label: null },
      activeRun,
    )
    : null;
  const waiting = resolveAgentWaitingActivityCopy({
    displayNames: agents.map((agent) => agent.displayName),
    workspaceStarting: false,
    queued: activeRun?.status === "queued",
  });
  const multiple = agents.length > 1;
  const multiStatus = multiple
    ? resolveMultiAgentTypingStatus(step.runs.map((entry) => ({
      status: entry.status,
      displayName: lanes.agentByRunId.get(entry.id)?.displayName ?? "Agent",
    })))
    : null;
  const status = multiStatus ??
    resolveSingleAgentTypingStatus({ state, runStatus: activeRun?.status ?? null, agentName: lead.displayName, waiting });
  const host: BrowserRequestHost = {
    transport: "shared",
    personalAvailable: false,
    sharedUnavailable: false,
    cardStates: new Map(step.card ? [[CARD_KEY, step.card]] : []),
    continuedKeys: browserRequestContinuedKeys(messages),
    routedWaitingKeys: routedBrowserWaitingKeys(messages),
    newestCardKey: newestBrowserRequestKey(messages),
  };
  return {
    now,
    displayed,
    host,
    typing: {
      isAssistantTyping,
      covered: coverage !== "none",
      tailKey: resolveTranscriptTailKey(tail),
      tailEndsTurn: isAssistantTyping && isTranscriptTailActiveTurnOutcome(tail, step.runs, messages),
      agents,
      multiple,
      lead,
      state: multiStatus ? { phase: multiStatus.phase, label: null } : state,
      label: status.label,
      ariaLabel: status.ariaLabel,
    },
  };
}

/**
 * Standalone rows retain a viewport fallback: phone hides the gutter and
 * shows inline faces; desktop does the reverse. The transcript-only typing
 * heading stays hidden here. Pane-aware visibility is covered in the browser.
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

describe("a message Octo sends straight to Instafy's browser", () => {
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function show(step: Step) {
    const view = chatPanel(step);
    vi.setSystemTime(view.now);
    mocks.runs = Object.fromEntries(step.runs.map((entry) => [entry.id, entry]));
    await act(async () => {
      root.render(
        <BrowserRequestHostContext.Provider value={view.host}>
          <ConversationMessageRows
            messages={view.displayed}
            currentUserId={PERSON}
            chatClientSessionId="session-1"
            projectId="project-1"
            runtimeId={null}
            conversationLocalId="conversation-local"
            conversationControllerId={CONVERSATION}
            firstPlanMessageId={null}
            humanLabelByUserId={new Map()}
            runAgentIdentityByRunId={new Map([[ROUTING_RUN, OCTO], [BROWSER_RUN, OCTO]])}
            runAgentHandleByRunId={new Map([[ROUTING_RUN, OCTO.handle], [BROWSER_RUN, OCTO.handle]])}
            renderAssistantAvatar={() => <span data-testid="octo-face" />}
            assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
            onRequestActions={vi.fn()}
            onRequestActionsAtPoint={vi.fn()}
            onCancelTerminalCommand={null}
            onMessageContextMenu={vi.fn()}
          />
          <ChatTypingRows
            peerTypingLabel={null}
            isAssistantTyping={view.typing.isAssistantTyping}
            isAssistantTypingCoveredByJobThreadPreview={view.typing.covered}
            typingAgents={view.typing.agents}
            hasMultipleTypingAgents={view.typing.multiple}
            typingAgentHandle={view.typing.lead.handle}
            typingAgentAvatarSeed={view.typing.lead.avatarSeed}
            typingIndicatorState={view.typing.state}
            typingStatusLabel={view.typing.label}
            typingStatusAriaLabel={view.typing.ariaLabel}
            isThinkingLabelExpanded={false}
            onToggleThinkingLabel={() => undefined}
            latestDisplayedMessageId={view.typing.tailKey}
            latestDisplayedMessageEndsActiveTurn={view.typing.tailEndsTurn}
            renderAssistantAvatar={() => <span data-testid="octo-face" />}
          />
        </BrowserRequestHostContext.Provider>,
      );
    });
    return read(step.time);
  }

  /**
   * What the chat says at that moment: every Octo row (the transcript's rows
   * that name Octo, and the typing row, named with or without its words),
   * every face (a typing row for two AIs draws both), and what each says,
   * top to bottom: a card shown as a card, a turn's line, or the typing
   * row's words.
   */
  function read(time: string) {
    const says: string[] = [];
    const typingRow = container.querySelector<HTMLElement>('[data-testid="assistant-typing-indicator"]');
    for (const element of Array.from(container.querySelectorAll<HTMLElement>(
      '[data-testid="browser-request-card"], [data-testid="turn-activity-line"] [data-sweep-text], [data-testid="assistant-typing-indicator"]',
    ))) {
      if (element.dataset.testid === "browser-request-card") says.push("card");
      else if (element.dataset.testid !== "assistant-typing-indicator") says.push(element.dataset.sweepText ?? "");
      else if (element.getAttribute("aria-hidden") !== "true") {
        says.push(element.querySelector<HTMLElement>("[data-sweep-text]")?.dataset.sweepText ?? "");
      }
    }
    const faces = Array.from(container.querySelectorAll(
      '[data-testid="octo-face"], [data-testid="chat-avatar-assistant"], [data-testid="assistant-thinking-octo-compact"]',
    ));
    // Octo's rows: those that name Octo, and its turns' rows, whose marker
    // names no AI (a turn's row is the turn's); another AI's rows name it.
    const octoRows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-speaker-marker"]'))
      .filter((marker) => !marker.dataset.agentHandle || marker.dataset.agentHandle === "octo").length;
    return {
      time,
      octoRows,
      faces: {
        desktop: faces.filter((face) => shows(face, "desktop")).length,
        phone: faces.filter((face) => shows(face, "phone")).length,
      },
      says,
      typingAnnounces: typingRow && typingRow.getAttribute("aria-hidden") !== "true"
        ? typingRow.querySelector(".sr-only")?.textContent ?? ""
        : null,
    };
  }

  it("shows one Octo row from the send to the reply, and never a Starting… under the turn's own line", async () => {
    const seen: Array<ReturnType<typeof read>> = [];
    // Sent: the routing step is on its way.
    seen.push(await show({ time: "13:07:55.960", runs: [], awaitingLease: true }));
    // Its card lands; that run's record says it ended 20 ms later. The card
    // is all that turn says, so "Starting…" hands over to it. Studio opens it
    // once that run has ended, and it reads as the browser turn's line from
    // the moment it lands (useChatBrowserRequest), never as a button.
    seen.push(await show({ time: "13:07:59.673", runs: [routingRun("in_progress")], card: { kind: "opening", note: null } }));
    seen.push(await show({ time: "13:07:59.693", runs: [], card: { kind: "opening", note: null } }));
    // Studio opens the card by itself.
    seen.push(await show({ time: "13:08:00.084", runs: [], card: { kind: "opening", note: null } }));
    // The person's words go on to the browser turn, queued and then leased.
    seen.push(await show({ time: "13:08:00.463", runs: [browserRun("queued")], card: { kind: "opening", note: null } }));
    seen.push(await show({ time: "13:08:00.572", runs: [browserRun("in_progress")], card: { kind: "opened" } }));
    // Its first step takes the card's place, in the same row.
    seen.push(await show({ time: "13:08:04.037", runs: [browserRun("in_progress")], card: { kind: "opened" } }));
    seen.push(await show({ time: "13:08:09.017", runs: [browserRun("in_progress")], card: { kind: "opened" } }));
    // The reply lands before the run's record catches up, and then it ends.
    seen.push(await show({ time: "13:08:42.988", runs: [browserRun("in_progress")], card: { kind: "opened" } }));
    seen.push(await show({ time: "13:08:43.066", runs: [], card: { kind: "opened" } }));

    // One Octo row at every step, with one face: on a phone the typing row
    // that waits draws none (its gutter collapses; only a thinking Octo
    // shows a face of its own there).
    const one = (time: string, says: string[], typingAnnounces: string | null = null, phoneFaces = 1) =>
      ({ time, octoRows: 1, faces: { desktop: 1, phone: phoneFaces }, says, typingAnnounces });
    expect(seen).toEqual([
      one("13:07:55.960", ["Starting…"], "Octo is starting", 0),
      one("13:07:59.673", ["Opening Instafy's browser…"]),
      one("13:07:59.693", ["Opening Instafy's browser…"]),
      one("13:08:00.084", ["Opening Instafy's browser…"]),
      one("13:08:00.463", ["Opening Instafy's browser…"]),
      one("13:08:00.572", ["Opening Instafy's browser…"]),
      one("13:08:04.037", ["Using the browser…"]),
      one("13:08:09.017", ["Opening visitporto.travel…"]),
      one("13:08:42.988", ["Opened livrarialello.pt"]),
      one("13:08:43.066", ["Opened livrarialello.pt"]),
    ]);
  });

  // A teammate in the same chat: their Studio opens nothing (the card is the
  // sender's to open), so the card stays a card until the sender's own
  // continuation reaches them, and then reads as the browser turn's line.
  it("shows a teammate one Octo row too, while the sender's Studio opens the card", async () => {
    const seen: Array<ReturnType<typeof read>> = [];
    seen.push(await show({ time: "13:07:55.960", runs: [routingRun("in_progress")] }));
    seen.push(await show({ time: "13:07:59.673", runs: [routingRun("in_progress")] }));
    seen.push(await show({ time: "13:07:59.693", runs: [] }));
    seen.push(await show({ time: "13:08:00.463", runs: [browserRun("queued")] }));
    seen.push(await show({ time: "13:08:00.572", runs: [browserRun("in_progress")] }));
    seen.push(await show({ time: "13:08:04.037", runs: [browserRun("in_progress")] }));

    // The routing step is thinking here, so the phone shows its face too.
    const one = (time: string, says: string[], typingAnnounces: string | null = null) =>
      ({ time, octoRows: 1, faces: { desktop: 1, phone: 1 }, says, typingAnnounces });
    expect(seen).toEqual([
      one("13:07:55.960", ["Starting…"], "Octo is starting"),
      one("13:07:59.673", ["card"]),
      one("13:07:59.693", ["card"]),
      one("13:08:00.463", ["Opening Instafy's browser…"]),
      one("13:08:00.572", ["Opening Instafy's browser…"]),
      one("13:08:04.037", ["Using the browser…"]),
    ]);
  });

  // A second AI in the chat starts its own turn on the same message. While
  // Studio opens Octo's card, the typing row says that AI is starting: it has
  // no row of its own yet. Once Octo's browser turn is on its way, the card
  // reads that turn's line and covers the typing row, as that turn's own row
  // does once it shows something. No row speaks for Octo's browser turn under
  // its line, and no face stays behind.
  it("never speaks for Octo's browser turn under its line while another AI's turn runs", async () => {
    const researcher = run("77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888", "in_progress", {
      agent: { id: "researcher-id", handle: "researcher", avatarSeed: "hatchling:3" },
    });
    const seen: Array<ReturnType<typeof read>> = [];
    seen.push(await show({ time: "13:08:00.084", runs: [researcher], card: { kind: "opening", note: null } }));
    seen.push(await show({ time: "13:08:00.463", runs: [browserRun("queued"), researcher], card: { kind: "opening", note: null } }));
    seen.push(await show({ time: "13:08:00.572", runs: [browserRun("in_progress"), researcher], card: { kind: "opened" } }));
    seen.push(await show({ time: "13:08:04.037", runs: [browserRun("in_progress"), researcher], card: { kind: "opened" } }));

    const octoAlone = (time: string, says: string) =>
      ({ time, octoRows: 1, faces: { desktop: 1, phone: 1 }, says: [says], typingAnnounces: null });
    expect(seen).toEqual([
      {
        time: "13:08:00.084",
        octoRows: 1,
        faces: { desktop: 2, phone: 1 },
        says: ["Opening Instafy's browser…", "Starting…"],
        typingAnnounces: "@researcher is starting",
      },
      octoAlone("13:08:00.463", "Opening Instafy's browser…"),
      octoAlone("13:08:00.572", "Opening Instafy's browser…"),
      octoAlone("13:08:04.037", "Using the browser…"),
    ]);
  });
});

describe("what a routed card covers", () => {
  const [ask, card, continuation, firstStep] = CHAT as [ChatMessage, ChatMessage, ChatMessage, ChatMessage];
  const another = run("77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888", "queued");

  it("stands for its routing step until that run's record ends, and for its browser turn until that turn shows something", () => {
    // All the routing step says is its card: the run's record catches up.
    expect(resolveJobThreadTypingCoverage(card, [routingRun("in_progress")], [ask, card])).toBe("answered");
    expect(isTranscriptTailActiveTurnOutcome(card, [routingRun("in_progress")], [ask, card])).toBe(true);
    // Its browser turn on its way: the card is that turn's line, also before
    // Studio has that run's record, and while the routing step's record
    // still catches up.
    for (const status of ["queued", "in_progress"] as const) {
      expect(resolveJobThreadTypingCoverage(card, [browserRun(status)], [ask, card, continuation])).toBe("live");
    }
    expect(resolveJobThreadTypingCoverage(card, [], [ask, card, continuation])).toBe("live");
    expect(resolveJobThreadTypingCoverage(card, [routingRun("in_progress"), browserRun("queued")], [ask, card, continuation]))
      .toBe("live");
    // Once that turn shows something, its own row takes the card's place.
    const shown = [ask, card, continuation, firstStep];
    expect(synthesizeAgentJobThreadMessages(shown, shown.filter(shouldDisplayChatMessage)).map((row) => row.id))
      .toEqual([ask.id, `agent-job-thread:${BROWSER_JOB}`]);

    // Before anything went on from it (Studio left it a button, or it is
    // still deciding), it is only its routing step's answer: another turn
    // starting gets its own typing row.
    expect(resolveJobThreadTypingCoverage(card, [another], [ask, card])).toBe("none");
    expect(isTranscriptTailActiveTurnOutcome(card, [another], [ask, card])).toBe(false);
    // Once its browser turn is on its way, it is that turn's row: it covers
    // the typing row whatever else runs, as a running turn's own row does, so
    // nothing under it speaks for that turn again (a second AI's turn, say).
    expect(resolveJobThreadTypingCoverage(card, [browserRun("queued"), another], [ask, card, continuation])).toBe("live");
    // The person pressed it themselves: their press is a turn of its own.
    const pressed: ChatMessage = {
      ...continuation,
      metadata: { ...continuation.metadata, prompt_metadata: { browserRequestOf: CARD_KEY, browserTransport: "shared" } },
    };
    expect(resolveJobThreadTypingCoverage(card, [browserRun("queued")], [ask, card, pressed])).toBe("none");
    // Its browser turn was stopped before it showed anything: the card stands
    // for that turn no more, also while the stopped run's record catches up,
    // and the next turn's typing row says it is starting.
    const stopped = stored({
      id: "stopped",
      role: "assistant",
      runId: BROWSER_RUN,
      time: "13:08:02.000",
      content: "Stopped this run.",
      metadata: {
        kind: "run_cancellation",
        source: "controller",
        details: { runIds: [BROWSER_RUN], jobIds: [BROWSER_JOB], outcome: "canceled", runStatus: "canceled" },
      },
    });
    expect(resolveJobThreadTypingCoverage(card, [browserRun("in_progress")], [ask, card, continuation, stopped]))
      .toBe("none");
    expect(resolveJobThreadTypingCoverage(card, [another], [ask, card, continuation, stopped])).toBe("none");
    // A card that the routing step did not send is any card.
    const ordinary: ChatMessage = {
      ...card,
      metadata: {
        ...card.metadata,
        details: { messageType: "action_request", details: { title: "Continue in Instafy's browser",
          browserRequest: { task: WORDS, location: "auto" } } },
      },
    };
    expect(resolveJobThreadTypingCoverage(ordinary, [routingRun("in_progress")], [ask, ordinary])).toBe("none");
  });
});
