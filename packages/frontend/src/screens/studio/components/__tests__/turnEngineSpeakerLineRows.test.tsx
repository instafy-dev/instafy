// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnEngineTurnOwner } from "../../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../../types";
import { ConversationMessageRows } from "../ConversationMessageRows";
import { RunFailureRetryProvider, type RunFailureRetryContextValue } from "../RunFailureNotice";

// docs/Local-Engine-Turns.md 5.7: a Claude Code turn's reply says whose own
// Claude Code ran it, in one plain line under its header. A reply with no turn
// row (a turn that used no tools) whose header the chat leaves out (a quiet
// reply in a chat of one, or the same speaker again) still says it.

const userInputRequests = vi.hoisted(() => ({ getUserInputRequest: vi.fn(), answerUserInputRequest: vi.fn() }));
vi.mock("../../../../services/runtimeController/userInputRequests", () => userInputRequests);

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
  useRuntime: () => ({ runs: [] }),
}));

const STAMPED = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };
const AT = Date.UTC(2026, 10, 13, 10);

function reply(id: string, minute: number, metadata: Record<string, unknown> = STAMPED): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content: `Reply ${id}`,
    timestamp: AT + minute * 60_000,
    files: null,
    messageType: null,
    metadata: { source: "agent", outcome: "succeeded", agent: { handle: "octo" }, ...metadata },
  };
}

function ownerContext(owner: TurnEngineTurnOwner | null): RunFailureRetryContextValue {
  return { pendingRetryKey: null, requestRetry: vi.fn(), autoRetryingKey: null, turnEngineOwnerOf: () => owner };
}

describe("a turn-engine reply whose header the chat leaves out", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(messages: ChatMessage[], identityLayout: "solo" | "participants") {
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={ownerContext({ isViewer: false, name: "Sam" })}>
          <ConversationMessageRows
            identityLayout={identityLayout}
            messages={messages}
            currentUserId="user-1"
            chatClientSessionId="session-1"
            projectId="project-1"
            runtimeId={null}
            conversationLocalId="conversation-local"
            conversationControllerId="conversation-controller"
            firstPlanMessageId={null}
            humanLabelByUserId={new Map()}
            runAgentIdentityByRunId={new Map()}
            runAgentHandleByRunId={new Map()}
            renderAssistantAvatar={() => <span data-testid="assistant-avatar" />}
            assistantAvatarPlaceholder={<span aria-hidden="true" className="h-8 w-8" />}
            onRequestActions={vi.fn()}
            onRequestActionsAtPoint={vi.fn()}
            onCancelTerminalCommand={null}
            onMessageContextMenu={vi.fn()}
          />
        </RunFailureRetryProvider>,
      );
    });
  }

  const linesOf = (messageId: string) =>
    [
      ...container.querySelectorAll(
        `[data-chat-scroll-message-id="${messageId}"] [data-testid="turn-engine-speaker-line"]`,
      ),
    ].map((node) => node.textContent);

  it("still names whose own Claude Code ran it in a chat of one", async () => {
    await render([reply("reply-1", 0)], "solo");
    // The header stays out, as for any quiet reply.
    expect(container.querySelector('[data-testid="chat-speaker-name"]')).toBeNull();
    expect(linesOf("reply-1")).toEqual(["Ran on Sam's own Claude Code, on their computer"]);
  });

  it("says it once for each reply of the same speaker, with or without a header", async () => {
    await render([reply("reply-1", 0), reply("reply-2", 1)], "participants");
    // The first reply's header carries the line; the second has none of its own.
    expect(container.querySelector('[data-chat-scroll-message-id="reply-1"] [data-testid="chat-speaker-name"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-scroll-message-id="reply-2"] [data-testid="chat-speaker-name"]')).toBeNull();
    expect(linesOf("reply-1")).toEqual(["Ran on Sam's own Claude Code, on their computer"]);
    expect(linesOf("reply-2")).toEqual(["Ran on Sam's own Claude Code, on their computer"]);
  });

  it("adds nothing to a reply the controller did not stamp", async () => {
    await render([reply("reply-1", 0, { turnEngine: "claude-code" }), reply("reply-2", 1, {})], "solo");
    expect(container.querySelectorAll('[data-testid="turn-engine-speaker-line"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="chat-speaker-inline"]')).toBeNull();
  });
});
