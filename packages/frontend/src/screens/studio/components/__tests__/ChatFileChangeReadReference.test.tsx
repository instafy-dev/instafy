// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapControllerMessageToChat } from "../../../../conversations/conversationMessageUtils";
import { AssistantMessageEntry } from "../ChatMessageEntries";

// The assistant bubble mounts the real file-change rail. Its runtime, status
// and tab dependencies are stubbed; nothing here may hit the network.
vi.mock("../../../../sdk/instafy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../sdk/instafy")>();
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      workspace: {
        ...actual.controllerClient.workspace,
        files: { ...actual.controllerClient.workspace.files, read: vi.fn() },
        git: { ...actual.controllerClient.workspace.git, fetchDiff: vi.fn(), revertPaths: vi.fn() },
      },
    },
  };
});

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ effectiveRuntimeId: null, runtimeReady: false }),
}));

// A member who can write to the space, so the card would offer Undo for any
// file it lists.
vi.mock("../../../../projects/ProjectAccessProvider", () => ({
  useOptionalProjectAccess: () => ({ projectCapabilitiesResolved: true, canWriteProject: true }),
}));

vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => {
    throw new Error("Message bodies must not subscribe to composer draft state.");
  },
}));

vi.mock("../../../../conversations/ConversationMessageMetadata", () => ({
  useConversationMessageMetadata: () => ({
    resolveConversationLocalId: () => null,
    extraAgentHandles: [],
  }),
}));

vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => {
    throw new Error("Message bodies must not mount conversation history or dispatch effects.");
  },
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    openConversationTab: vi.fn(),
    openPanelTab: vi.fn(),
    requestUrlPush: vi.fn(),
    openGitDiffTab: vi.fn(),
  }),
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: vi.fn() }),
}));

const readReference = {
  path: "notes/a.md",
  workspacePath: "notes/a.md",
  change: "read",
  changeType: "read",
  source: "workspace",
};

// A turn's final message with the apply/files artifact the runtime recorded.
function assistantTurn(files: Array<Record<string, unknown>>) {
  return mapControllerMessageToChat({
    id: "16161616-1616-1616-1616-161616161616",
    conversationId: "44444444-4444-4444-4444-444444444444",
    projectId: "55555555-5555-5555-5555-555555555555",
    sessionId: null,
    createdBy: null,
    promptId: null,
    runId: null,
    role: "assistant",
    content: "The notes list three open tasks.",
    metadata: { artifacts: [{ kind: "apply/files", files }] },
    createdAt: "2026-10-02T09:00:00.000Z",
  });
}

describe("assistant file changes and files the turn only read", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows no change card for a turn that only read a file", async () => {
    const message = assistantTurn([readReference]);

    await act(async () => {
      root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
    });

    expect(container.textContent).toContain("The notes list three open tasks.");
    expect(container.querySelector('[data-testid="chat-file-change-summary"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-review"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-undo"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-revert"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')).toBeNull();
  });

  it("lists and counts only the real changes of a turn that also read a file", async () => {
    const message = assistantTurn([
      readReference,
      { path: "notes/todo.md", change: "created", changeType: "created" },
      { path: "README.md", change: { type: "changed" }, changeType: "changed" },
    ]);

    await act(async () => {
      root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
    });

    const chips = Array.from(container.querySelectorAll('[data-testid="chat-file-change-file-chip"]'));
    expect(chips.map((chip) => chip.textContent)).toEqual(["todo.md", "README.md"]);
    expect(container.querySelector('[data-testid="chat-file-change-toggle-files"]')?.textContent).toContain(
      "Edited 2 files",
    );
    expect(container.querySelector('[data-testid="chat-file-change-review"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-undo"]')).not.toBeNull();
  });
});
