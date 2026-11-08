// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapControllerMessageToChat } from "../../../../conversations/conversationMessageUtils";
import type { ControllerConversationMessage } from "../../../../services/runtimeController/conversations";
import type { RunRecord } from "../../../../types";
import type { ChatMessage } from "../../types";
import { collapseLifecycleMessages, shouldDisplayChatMessage, synthesizeAgentJobThreadMessages } from "../chatMessagePresentation";
import { ChatRunStopNoticeProvider } from "../ChatRunStopNotice";
import { ConversationMessageRows } from "../ConversationMessageRows";
import { useChatRunStopContinuation } from "../useChatRunStopContinuation";
import type { SubmitMessageFn } from "../useChatSubmitFlow";

// A failed turn sent again reads "Trying again…" until its resend shows
// something: the row stands for that resend. A Stop then left the row on
// "Trying again…", and the Stop showed in a row of its own under it
// ("Stopped · Continue"): one stopped turn, two rows, and a line that never
// ended. A stopped turn is one row: "Stopped", with Continue in it.

const mocks = vi.hoisted(() => ({
  runs: {} as Record<string, unknown>,
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

const CONVERSATION = "9bd1b2f6-9c61-45af-ad57-0c6ee60d0e59";
const PERSON = "person-1";
const OCTO = { id: "786d5f34-547e-4ca7-8a85-4e1dedec2401", handle: "octo", avatarSeed: "octo", displayName: "Octo" };
const RUN = "2d2ebd1c-1bd7-4ce0-a5a8-6cff896b39d8";
const JOB = "e20b847d-ca6a-47d1-bac6-ab94e320de4d";
const RETRY_RUN = "5c0e2b1a-7d1e-4f55-9a43-1f2a3b4c5d6e";
const RETRY_JOB = "6d1f3c2b-8e2f-4a66-8b54-2a3b4c5d6e7f";
const FAILURE = "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f80";
const QUESTION = "What time does Livraria Lello open on Sunday?";
const at = (time: string) => `2026-11-03T${time}Z`;

function stored(row: {
  id: string; role: "user" | "assistant"; time: string; content: string; metadata: Record<string, unknown>; runId?: string;
}): ChatMessage {
  const message: ControllerConversationMessage = {
    id: row.id, conversationId: CONVERSATION, projectId: "project-1", sessionId: null,
    createdBy: row.role === "user" ? PERSON : null, promptId: null, runId: row.runId ?? RUN,
    role: row.role, content: row.content, metadata: row.metadata, createdAt: at(row.time),
  };
  return mapControllerMessageToChat(message);
}

// The turn failed, and its resend went out.
const SENT_AGAIN: ChatMessage[] = [
  stored({
    id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f81", role: "user", time: "06:00:00.000", content: QUESTION,
    metadata: { prompt_metadata: { client: { userId: PERSON, sessionId: "session-1" }, clientMessageId: "send-1" } },
  }),
  stored({
    id: FAILURE, role: "assistant", time: "06:00:05.000", content: "Octo couldn't reach the AI service.",
    metadata: { agent: OCTO, jobId: JOB, source: "agent", outcome: "failed", messageType: "error" },
  }),
  stored({
    id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f82", role: "user", time: "06:00:10.000", content: QUESTION, runId: RETRY_RUN,
    metadata: {
      prompt_metadata: { client: { userId: PERSON, sessionId: "session-1" }, clientMessageId: "send-2", retryOfMessageId: FAILURE },
    },
  }),
];
// What the chat does not show of the resend: its usage, which names its job.
const RETRY_USAGE = stored({
  id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f85", role: "assistant", time: "06:00:11.500", content: "Token usage — input: 9120",
  runId: RETRY_RUN,
  metadata: { agent: OCTO, jobId: RETRY_JOB, source: "agent", kind: "update", outcome: "in_progress", messageType: "token_usage" },
});
function stopNotice(jobIds: string[]): ChatMessage {
  return stored({
    id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f86", role: "assistant", time: "06:00:12.000", content: "Stopped this run.",
    runId: RETRY_RUN,
    metadata: {
      source: "controller", kind: "run_cancellation",
      details: { stopRequested: true, actorUserId: PERSON, agentHandles: ["octo"], jobIds, runIds: [RETRY_RUN], runStatus: "canceled" },
    },
  });
}
function retryRun(status: "in_progress" | "canceled", jobId: string | null): RunRecord {
  return {
    id: RETRY_RUN, status, projectId: "project-1", conversationId: CONVERSATION, sessionId: null, promptId: null,
    runType: "prompt", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
    createdAt: null, updatedAt: null, metadata: { ...(jobId ? { jobId } : {}), agent: OCTO },
  };
}

/** ChatPanel's Stop context: who reads the chat, and Continue for its newest stopped turn. */
function StopNotices({ options, children }: {
  options: Parameters<typeof useChatRunStopContinuation>[0];
  children: ReactNode;
}) {
  return <ChatRunStopNoticeProvider value={useChatRunStopContinuation(options)}>{children}</ChatRunStopNoticeProvider>;
}

describe("a Stop while a failed turn is tried again", () => {
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
    mocks.activeConversation = null;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  /** What ChatPanel shows of `chat` at `time`, with the resend's run as `run`. */
  async function show(chat: ChatMessage[], time: string, run: RunRecord, submit = vi.fn<SubmitMessageFn>()) {
    vi.setSystemTime(Date.parse(at(time)));
    mocks.runs = { [run.id]: run };
    mocks.activeConversation = { controllerId: CONVERSATION, messages: chat };
    const collapsed = collapseLifecycleMessages(chat);
    const displayed = synthesizeAgentJobThreadMessages(collapsed, collapsed.filter(shouldDisplayChatMessage));
    await act(async () => {
      root.render(
        <StopNotices options={{
          conversationId: CONVERSATION, viewerUserId: PERSON, humanLabelByUserId: new Map(), canWrite: true, busy: false,
          messages: chat, hasNewer: false, queuedSends: [], submitMessage: submit,
        }}>
          <ConversationMessageRows
            messages={displayed}
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
          />
        </StopNotices>,
      );
    });
    return {
      text: container.textContent ?? "",
      turns: Array.from(container.querySelectorAll<HTMLElement>('[data-testid="agent-job-thread-preview"]')),
      lines: Array.from(container.querySelectorAll<HTMLElement>('[data-testid="turn-activity-line"] [data-sweep-text]'))
        .map((element) => element.dataset.sweepText ?? ""),
      noticeRows: container.querySelectorAll('[data-testid="chat-run-stop-notice"]').length,
      continues: container.querySelectorAll('[data-testid="chat-run-stop-continue"]').length,
    };
  }

  it("is one row that says Stopped, with Continue in it", async () => {
    const chat = [...SENT_AGAIN, RETRY_USAGE];
    const trying = await show(chat, "06:00:11.900", retryRun("in_progress", RETRY_JOB));
    expect(trying.turns).toHaveLength(1);
    expect(trying.text).toContain("Trying again…");

    // The notice lands before the resend's record says it was canceled.
    const stoppedChat = [...chat, stopNotice([RETRY_JOB])];
    const submit = vi.fn<SubmitMessageFn>().mockResolvedValue(true);
    const stopped = await show(stoppedChat, "06:00:12.100", retryRun("in_progress", RETRY_JOB), submit);
    expect(stopped.turns).toHaveLength(1);
    expect(stopped.lines).toEqual(["Stopped"]);
    expect(stopped.text).not.toContain("Trying again");
    expect(stopped.noticeRows).toBe(0);
    expect(stopped.continues).toBe(1);
    const continueButton = stopped.turns[0]!.querySelector<HTMLElement>('[data-testid="chat-run-stop-continue"]');
    expect(continueButton).not.toBeNull();
    // Continue carries the stopped resend on, as from the notice's own row:
    // the question again, in the person's own words.
    await act(async () => {
      continueButton!.click();
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      message: QUESTION,
      editorState: null,
      targetAgentHandles: ["octo"],
      metadata: { continuedStopMessageId: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f86", continuedRunIds: [RETRY_RUN] },
    }, expect.objectContaining({ automatic: true, intent: "send" }));

    // Minutes on, with the record canceled: still the one row, stopped.
    const later = await show(stoppedChat, "06:02:12.000", retryRun("canceled", RETRY_JOB));
    expect(later.turns).toHaveLength(1);
    expect(later.lines).toEqual(["Stopped"]);
    expect(later.noticeRows).toBe(0);
  });

  // A local test, Nov 8: Continue put a sentence in a bubble in the person's name.
  // It carries the question on in the person's own words, which the chat
  // already shows: no second bubble, and the new turn's row follows the
  // stopped one.
  it("shows no bubble for Continue, and the new turn's row after the stopped one", async () => {
    const CONTINUE_RUN = "8f3c5e4d-0a4b-4c88-8d76-4c5d6e7f8091";
    const CONTINUE_JOB = "9a4d6f5e-1b5c-4d99-9e87-5d6e7f809102";
    const stoppedChat = [...SENT_AGAIN, RETRY_USAGE, stopNotice([RETRY_JOB])];
    const continued = [
      ...stoppedChat,
      stored({
        id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f87", role: "user", time: "06:01:00.000", content: QUESTION,
        runId: CONTINUE_RUN, metadata: { prompt_metadata: {
          client: { userId: PERSON, sessionId: "session-1" }, clientMessageId: "send-3",
          continuedStopMessageId: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f86", continuedRunIds: [RETRY_RUN],
        } },
      }),
      stored({
        id: "7e2a4d3c-9f3a-4b77-9c65-3b4c5d6e7f88", role: "assistant", time: "06:01:09.000",
        content: "Livraria Lello opens at 9:00 on Sunday.", runId: CONTINUE_RUN,
        metadata: { agent: OCTO, jobId: CONTINUE_JOB, source: "agent", outcome: "succeeded" },
      }),
    ];
    const view = await show(continued, "06:01:10.000", retryRun("canceled", RETRY_JOB));
    expect(view.text.split(QUESTION)).toHaveLength(2);
    expect(view.text).toContain("Livraria Lello opens at 9:00 on Sunday.");
    expect(view.text.indexOf("Stopped")).toBeLessThan(view.text.indexOf("Livraria Lello opens"));
    expect(view.continues).toBe(0);
  });

  it("is one stopped row when the resend was stopped before its job showed anything", async () => {
    const stopped = await show([...SENT_AGAIN, stopNotice([])], "06:00:12.100", retryRun("canceled", null));
    expect(stopped.turns).toHaveLength(1);
    expect(stopped.lines).toEqual(["Stopped"]);
    expect(stopped.text).not.toContain("Trying again");
    expect(stopped.noticeRows).toBe(0);
  });

  it("says Stopped once the resend's record says it was canceled, before any notice", async () => {
    const stopped = await show([...SENT_AGAIN, RETRY_USAGE], "06:00:12.100", retryRun("canceled", RETRY_JOB));
    expect(stopped.turns).toHaveLength(1);
    expect(stopped.lines).toEqual(["Stopped"]);
    expect(stopped.text).not.toContain("Trying again");
  });
});
