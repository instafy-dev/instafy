// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnEngineTurnOwner } from "../../../../conversations/runFailurePresentation";
import {
  resetViewerConnectionsForTests,
  setViewerConnections,
} from "../../../../conversations/aiSignIns";
import { setClaudeCodeLoginsLoaderForTests } from "../../../../features/claudeCode/claudeCodeLoginsStore";
import type { ControllerCredentialListItem } from "../../../../services/runtimeController/credentials";
import type { ChatMessage } from "../../types";
import { ConversationMessageRows } from "../ConversationMessageRows";
import { RunFailureRetryProvider, type RunFailureRetryContextValue } from "../RunFailureNotice";

// docs/Local-Engine-Turns.md 11.20: the line that names the viewer's own
// sign-in a turn ran on shows as a turn engine's line does, also under a
// reply whose header the chat leaves out, and never as an empty row.

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

const WORK = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e01";
const PERSONAL = "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e02";
const AT = Date.UTC(2026, 10, 22, 10);

function connection(id: string, label: string): ControllerCredentialListItem {
  return {
    id, kind: "codex_auth_json", label, isDefault: false, metadata: null,
    lastUsedAt: null, revokedAt: null, createdAt: "", updatedAt: "",
  } as ControllerCredentialListItem;
}

function reply(id: string, minute: number, metadata: Record<string, unknown>): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content: `Reply ${id}`,
    timestamp: AT + minute * 60_000,
    files: null,
    messageType: null,
    metadata: { source: "agent", outcome: "succeeded", agent: { handle: "octo" }, aiAccessMode: "byoc", ...metadata },
  };
}

function ownerContext(owner: TurnEngineTurnOwner | null): RunFailureRetryContextValue {
  return { pendingRetryKey: null, requestRetry: vi.fn(), autoRetryingKey: null, turnEngineOwnerOf: () => owner };
}

describe("the sign-in line in the chat's rows", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetViewerConnectionsForTests();
    setViewerConnections("user-1", [connection(WORK, "Work ChatGPT"), connection(PERSONAL, "Personal")]);
    setClaudeCodeLoginsLoaderForTests(async () => ({ success: true, logins: [] }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetViewerConnectionsForTests();
    setClaudeCodeLoginsLoaderForTests(null);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(messages: ChatMessage[], identityLayout: "solo" | "participants", owner: TurnEngineTurnOwner | null) {
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={ownerContext(owner)}>
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

  it("names the viewer's own sign-in under each of their replies, with or without a header", async () => {
    await render(
      [reply("reply-1", 0, { aiSignIn: { credentialId: WORK } }), reply("reply-2", 1, { aiSignIn: { credentialId: PERSONAL, backup: true } })],
      "participants",
      { isViewer: true, name: "Ada" },
    );
    expect(linesOf("reply-1")).toEqual(["Ran on Work ChatGPT"]);
    expect(linesOf("reply-2")).toEqual(["Ran on Personal, a backup"]);

    await render([reply("reply-1", 0, { aiSignIn: { credentialId: WORK } })], "solo", { isViewer: true, name: "Ada" });
    expect(container.querySelector('[data-testid="chat-speaker-name"]')).toBeNull();
    expect(linesOf("reply-1")).toEqual(["Ran on Work ChatGPT"]);
  });

  it("leaves no empty line behind for a reply that names nothing of the viewer's", async () => {
    await render(
      [reply("reply-1", 0, { aiSignIn: { credentialId: "8d0c4f5e-1a2b-4c3d-8e9f-0a1b2c3d4e99" } })],
      "solo",
      null,
    );
    expect(container.querySelectorAll('[data-testid="turn-engine-speaker-line"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="chat-speaker-inline"]')).toBeNull();
  });
});
