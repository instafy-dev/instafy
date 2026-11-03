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
import { collapseLifecycleMessages, shouldDisplayChatMessage, synthesizeAgentJobThreadMessages } from "../chatMessagePresentation";
import { ConversationMessageRows } from "../ConversationMessageRows";

// A turn's reply grows in the turn's own row, where the reply lands. A local
// test, Nov 3: as each of ten replies landed, a second Octo row showed for
// 0.5 to 6 s (the hours turn: 05:52:21.18 to 21.80), with no typing row on
// screen. The streamed draft came after the chat's rows as a row of its own,
// whose speaker the turn's row above never matched, so it drew a second face.

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
const RUN = "2d2ebd1c-1bd7-4ce0-a5a8-6cff896b39d8";
const JOB = "e20b847d-ca6a-47d1-bac6-ab94e320de4d";
const OCTO = { id: "786d5f34-547e-4ca7-8a85-4e1dedec2401", handle: "octo", avatarSeed: "octo", displayName: "Octo" };
const REPLY = "Livraria Lello’s official site lists its opening hours as daily, 9:00 AM–7:30 PM.";
const at = (time: string) => `2026-11-03T${time}Z`;

function stored(row: {
  id: string; role: "user" | "assistant"; time: string; content: string; metadata: Record<string, unknown>; runId?: string;
}): ChatMessage {
  const message: ControllerConversationMessage = {
    id: row.id,
    conversationId: CONVERSATION,
    projectId: "project-1",
    sessionId: null,
    createdBy: row.role === "user" ? PERSON : null,
    promptId: null,
    runId: row.runId ?? RUN,
    role: row.role,
    content: row.content,
    metadata: row.metadata,
    createdAt: at(row.time),
  };
  return mapControllerMessageToChat(message);
}

function step(id: string, time: string, status: string): ChatMessage {
  return stored({
    id,
    role: "assistant",
    time,
    content: `Tool call ${status === "in_progress" ? "started" : status}: instafy_shared_browser/navigate`,
    metadata: {
      kind: "update",
      agent: OCTO,
      jobId: JOB,
      source: "agent",
      outcome: "in_progress",
      activity: {
        v: 1, key: "browser/open", also: [], live: "Opening {host}", host: "livrarialello.pt", role: "content",
        step: "navigate", when: "success", count: 1,
        done: { one: "opened {host}", some: "opened pages on {host}", other: "opened {n} pages on {host}" },
      },
      messageType: "mcp_tool_call",
      details: {
        kind: "codex_mcp_tool_call",
        tool: "navigate",
        server: "instafy_shared_browser",
        status,
        eventType: status === "in_progress" ? "item.started" : "item.completed",
        itemId: `exec-${id}`,
      },
    },
  });
}

const CHAT: ChatMessage[] = [
  stored({
    id: "a6adce77-36b0-4457-8867-02ccd43a29ad",
    role: "user",
    time: "05:51:29.722",
    content: "Open www.visitporto.travel in your browser and find the Livraria Lello opening hours.",
    metadata: { prompt_metadata: { client: { userId: PERSON, sessionId: "session-1" } } },
  }),
  step("7b39166e-ec62-48b4-930a-3dd102c9d858", "05:52:11.586", "in_progress"),
  step("2c7e174e-ece6-42c3-b6e6-d06e66bac4a3", "05:52:18.500", "completed"),
  stored({
    id: "605bdff9-e197-41f9-b8a8-bbaaa2c488d4",
    role: "assistant",
    time: "05:52:21.799",
    content: REPLY,
    metadata: { agent: OCTO, jobId: JOB, source: "agent", outcome: "succeeded", details: { kind: "runtime_selection" } },
  }),
];

// A building turn that posts its site's card before it is done with it, as
// the map turn did (its card at 05:36:43, its first place a minute later).
const MAP_REPLY = "I made a three-day Seville map with a Santa Cruz stay recommendation and a day-by-day plan.";
function command(id: string, time: string, status: string): ChatMessage {
  return stored({
    id,
    role: "assistant",
    time,
    content: "/bin/bash -lc uw validate sites/seville-3-days",
    metadata: {
      kind: "update", agent: OCTO, jobId: JOB, source: "agent", outcome: "in_progress", messageType: "command_execution",
      details: { kind: "codex_command_execution", status, eventType: status === "in_progress" ? "item.started" : "item.completed", itemId: `exec-${id}` },
    },
  });
}
const MAP_CHAT: ChatMessage[] = [
  stored({
    id: "11c57e4d-6000-4000-8000-000000000001",
    role: "user",
    time: "05:36:15.093",
    content: "Plan 3 days in Seville for a first visit: where to stay, what to see each day, on a map.",
    metadata: { prompt_metadata: { client: { userId: PERSON, sessionId: "session-1" } } },
  }),
  command("11c57e4d-6000-4000-8000-000000000002", "05:36:20.858", "in_progress"),
  stored({
    id: "11c57e4d-6000-4000-8000-000000000003",
    role: "assistant",
    time: "05:36:43.300",
    content: "Three days in Seville is ready to preview.",
    metadata: {
      kind: "update", agent: OCTO, jobId: JOB, source: "agent", outcome: "in_progress", messageType: "action_request",
      details: { messageType: "action_request", details: { title: "Three days in Seville", testId: "turn-card", actions: [] } },
    },
  }),
  command("11c57e4d-6000-4000-8000-000000000004", "05:39:20.000", "completed"),
  stored({
    id: "11c57e4d-6000-4000-8000-000000000005",
    role: "assistant",
    time: "05:39:25.100",
    content: MAP_REPLY,
    metadata: { agent: OCTO, jobId: JOB, source: "agent", outcome: "succeeded", details: { kind: "runtime_selection" } },
  }),
];

const RUN_RECORD: RunRecord = {
  id: RUN, status: "in_progress", projectId: "project-1", conversationId: CONVERSATION, sessionId: null, promptId: null,
  runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
  createdAt: null, updatedAt: null, metadata: { jobId: JOB, agent: OCTO, browserTransport: "shared" },
};

// A turn that failed and was sent again (Try again, or Instafy by itself),
// whose retry writes its reply before it shows any step: the failed turn's
// row stands for the retry ("Trying again…") until the retry shows something.
const RETRY_RUN = "5c0e2b1a-7d1e-4f55-9a43-1f2a3b4c5d6e";
const RETRY_JOB = "6d1f3c2b-8e2f-4a66-8b54-2a3b4c5d6e7f";
const FAILURE = "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f80";
const QUESTION = "What time does Livraria Lello open on Sunday?";
const RETRY_REPLY = "Livraria Lello opens at 9:00 AM on Sundays.";
const RETRY_CHAT: ChatMessage[] = [
  stored({
    id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f81", role: "user", time: "06:00:00.000", content: QUESTION,
    metadata: { prompt_metadata: { client: { userId: PERSON, sessionId: "session-1" }, clientMessageId: "send-1" } },
  }),
  stored({
    id: FAILURE, role: "assistant", time: "06:00:05.000", content: "Octo couldn't reach the AI service.",
    metadata: { agent: OCTO, jobId: JOB, source: "agent", outcome: "failed", messageType: "error" },
  }),
  stored({
    id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f83", role: "user", time: "06:00:10.000", content: QUESTION, runId: RETRY_RUN,
    metadata: { prompt_metadata: { client: { userId: PERSON, sessionId: "session-1" }, clientMessageId: "send-2", retryOfMessageId: FAILURE } },
  }),
  stored({
    id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f84", role: "assistant", time: "06:00:14.000", content: RETRY_REPLY, runId: RETRY_RUN,
    metadata: { agent: OCTO, jobId: RETRY_JOB, source: "agent", outcome: "succeeded", details: { kind: "runtime_selection" } },
  }),
];
// The same, with the retry's usage already stored: the chat knows the retry's
// job, which still shows nothing.
const RETRY_CHAT_WITH_USAGE: ChatMessage[] = [
  ...RETRY_CHAT.slice(0, 3),
  stored({
    id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f85", role: "assistant", time: "06:00:11.500", content: "Token usage — input: 9120",
    runId: RETRY_RUN,
    metadata: { agent: OCTO, jobId: RETRY_JOB, source: "agent", kind: "update", outcome: "in_progress", messageType: "token_usage" },
  }),
  ...RETRY_CHAT.slice(3),
];
const RETRY_RUN_RECORD: RunRecord = { ...RUN_RECORD, id: RETRY_RUN, metadata: { jobId: RETRY_JOB, agent: OCTO } };

function draft(text: string, time: string, run: { runId: string; jobId: string } = { runId: RUN, jobId: JOB }): ReplyDraft {
  const now = Date.parse(at(time));
  return { conversationId: CONVERSATION, ...run, attempt: 0, segment: 1, seq: text.length, text, startedAt: now, updatedAt: now };
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

function faces(container: HTMLElement) {
  const all = Array.from(container.querySelectorAll('[data-testid="octo-face"], [data-testid="chat-avatar-assistant"]'));
  return { desktop: all.filter((face) => shows(face, "desktop")).length, phone: all.filter((face) => shows(face, "phone")).length };
}

describe("a turn's reply while the model writes it", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  /** The transcript ChatPanel shows at `time`: the stored rows, their turns, and the turn's draft, placed as ChatPanel places it. */
  async function show(time: string, drafts: ReplyDraft[], chat: ChatMessage[] = CHAT, runs: RunRecord[] = [RUN_RECORD]) {
    const now = Date.parse(at(time));
    vi.setSystemTime(now);
    mocks.runs = Object.fromEntries(runs.map((run) => [run.id, run]));
    const messages = chat.filter((message) => message.timestamp <= now);
    const collapsed = collapseLifecycleMessages(messages);
    const displayed = synthesizeAgentJobThreadMessages(collapsed, collapsed.filter(shouldDisplayChatMessage));
    const visible = selectVisibleReplyDrafts(drafts, messages, new Set(runs.map((run) => run.id)), now)
      .map(replyDraftChatMessage);
    await act(async () => {
      root.render(
        <ConversationMessageRows
          messages={placeReplyDrafts(displayed, visible)}
          currentUserId={PERSON}
          chatClientSessionId="session-1"
          projectId="project-1"
          runtimeId={null}
          conversationLocalId="conversation-local"
          conversationControllerId={CONVERSATION}
          firstPlanMessageId={null}
          humanLabelByUserId={new Map()}
          runAgentIdentityByRunId={new Map([[RUN, OCTO], [RETRY_RUN, OCTO]])}
          runAgentHandleByRunId={new Map([[RUN, OCTO.handle], [RETRY_RUN, OCTO.handle]])}
          renderAssistantAvatar={() => <span data-testid="octo-face" />}
          assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
          onRequestActions={vi.fn()}
          onRequestActionsAtPoint={vi.fn()}
          onCancelTerminalCommand={null}
          onMessageContextMenu={vi.fn()}
        />,
      );
    });
    const turn = container.querySelector('[data-testid="agent-job-thread-preview"]');
    return {
      // Octo's rows: every row that names an AI here is Octo's.
      octoRows: container.querySelectorAll('[data-testid="chat-speaker-marker"]').length,
      faces: faces(container),
      draftInTurn: turn?.querySelector('[data-testid="chat-reply-draft"]')?.textContent ?? null,
      draftRows: container.querySelectorAll('[data-testid="chat-reply-draft"]').length,
      busy: Boolean(turn?.querySelector('[data-testid="chat-reply-draft"] [aria-busy="true"]')),
      replyInTurn: turn?.textContent?.includes(REPLY) ?? false,
      text: container.textContent ?? "",
      /** What the turn's row shows, top to bottom: its reply (or its draft) and its cards. */
      order: Array.from(turn?.querySelectorAll<HTMLElement>('[data-testid="chat-reply-draft"], [data-testid="turn-card"], p') ?? [])
        .flatMap((element) => element.dataset.testid === "chat-reply-draft" ? ["draft"]
          : element.dataset.testid === "turn-card" ? ["card"]
            : element.textContent?.includes(MAP_REPLY) ? ["reply"] : []),
    };
  }

  it("grows in the turn's own row, in the reply's place, and the reply lands there: one Octo row throughout", async () => {
    const growing = await show("05:52:21.178", [draft("Livraria Lello’s official site lists", "05:52:21.178")]);
    expect(growing).toMatchObject({
      octoRows: 1, faces: { desktop: 1, phone: 1 }, draftInTurn: "Livraria Lello’s official site lists", draftRows: 1, busy: true,
      replyInTurn: false,
    });

    const longer = await show("05:52:21.576", [draft("Livraria Lello’s official site lists its opening hours", "05:52:21.576")]);
    expect(longer).toMatchObject({ octoRows: 1, faces: { desktop: 1, phone: 1 }, draftRows: 1 });
    expect(longer.draftInTurn).toContain("its opening hours");

    // The reply lands while the run's record still says it runs: the draft
    // gives way to it in the same render, in the same row.
    const landed = await show("05:52:21.799", [draft("Livraria Lello’s official site lists its opening hours", "05:52:21.576")]);
    expect(landed).toMatchObject({
      octoRows: 1, faces: { desktop: 1, phone: 1 }, draftInTurn: null, draftRows: 0, busy: false, replyInTurn: true,
    });
  });

  // A Try again whose retry wrote its reply before any step drew it as a row
  // of its own under the failed turn's "Trying again…", with a second face.
  it.each([
    ["has stored nothing yet", RETRY_CHAT],
    ["has stored only what the chat does not show", RETRY_CHAT_WITH_USAGE],
  ])("grows a retry's reply in the row of the turn it tries again, under its Trying again line, while the retry %s",
    async (_case, chat) => {
      const retry = { runId: RETRY_RUN, jobId: RETRY_JOB };
      const sent = await show("06:00:11.900", [], chat, [RETRY_RUN_RECORD]);
      expect(sent).toMatchObject({ octoRows: 1, faces: { desktop: 1, phone: 1 }, draftRows: 0 });
      expect(sent.text).toContain("Trying again");

      const growing = await show("06:00:12.000", [draft("Livraria Lello opens", "06:00:12.000", retry)], chat,
        [RETRY_RUN_RECORD]);
      expect(growing).toMatchObject({
        octoRows: 1, faces: { desktop: 1, phone: 1 }, draftInTurn: "Livraria Lello opens", draftRows: 1, busy: true,
      });
      // The line stays, as a turn's line stays above its growing reply.
      expect(growing.text.indexOf("Trying again")).toBeGreaterThan(-1);
      expect(growing.text.indexOf("Trying again")).toBeLessThan(growing.text.indexOf("Livraria Lello opens"));

      const landed = await show("06:00:14.000", [draft("Livraria Lello opens at 9:00", "06:00:13.000", retry)],
        chat, [RETRY_RUN_RECORD]);
      expect(landed).toMatchObject({ octoRows: 1, faces: { desktop: 1, phone: 1 }, draftRows: 0 });
      expect(landed.text).toContain(RETRY_REPLY);
    });

  it("puts the reply, and the draft before it, above the turn's card: the card follows what the turn says", async () => {
    // While the turn works, its card shows under its line.
    expect((await show("05:37:00.000", [], MAP_CHAT)).order).toEqual(["card"]);
    // The reply grows where it lands, above the card.
    expect((await show("05:39:24.660", [draft("I made a three-day Seville map", "05:39:24.660")], MAP_CHAT)).order)
      .toEqual(["draft", "card"]);
    // Done: the reply, then its card.
    expect((await show("05:39:27.470", [], MAP_CHAT)).order).toEqual(["reply", "card"]);
  });
});
