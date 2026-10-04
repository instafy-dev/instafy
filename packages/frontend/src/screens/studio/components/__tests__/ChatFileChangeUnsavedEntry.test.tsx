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

// The runtime's final job artifacts for a turn that edited one file, with the
// git sync outcome the runtime recorded for its save.
function assistantTurn(
  gitSyncStatus: "synced" | "failed" | "disabled" | "partial",
  report: { conflictedPaths?: string[]; rejectedPaths?: Array<Record<string, unknown>> } = {},
) {
  return mapControllerMessageToChat({
    id: "14141414-1414-1414-1414-141414141414",
    conversationId: "44444444-4444-4444-4444-444444444444",
    projectId: "55555555-5555-5555-5555-555555555555",
    sessionId: null,
    createdBy: null,
    promptId: null,
    runId: null,
    role: "assistant",
    content: "Saved your bookkeeping profile.",
    metadata: {
      artifacts: [
        {
          kind: "apply/files",
          files: [{ path: "bookkeeping/profile.json", change: { type: "changed" } }],
        },
        {
          kind: "origin/apply",
          metadata: {
            originId: "origin-1",
            gitSyncStatus,
            gitSyncAttempted: gitSyncStatus !== "disabled",
            gitSyncError: gitSyncStatus === "failed" ? "git remote is not configured for this project" : null,
            paths: [],
            conflictedPaths: report.conflictedPaths ?? [],
            rejectedPaths: report.rejectedPaths ?? [],
          },
        },
      ],
    },
    createdAt: "2026-09-26T16:00:00.000Z",
  });
}

describe("assistant file changes and their save state", () => {
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

  it("marks the file chips Not saved when the runtime's save failed", async () => {
    const message = assistantTurn("failed");

    await act(async () => {
      root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
    });

    const bubble = container.querySelector('[data-testid="chat-bubble-assistant"]');
    expect(bubble?.querySelector('[data-testid="chat-file-change-file-chip"]')?.textContent).toBe("profile.json");
    const state = bubble?.querySelector<HTMLElement>('[data-testid="chat-file-change-unsaved"]');
    expect(state?.textContent).toContain("Not saved");
    expect(state?.getAttribute("title")).toContain("The agent saves them at its next turn");
  });

  it("marks them Not saved when saving was off for the run", async () => {
    const message = assistantTurn("disabled");

    await act(async () => {
      root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
    });

    expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')?.getAttribute("title")).toContain(
      "These changes weren't saved to the space yet.",
    );
  });

  it("looks like a normal change when the save worked", async () => {
    const message = assistantTurn("synced");

    await act(async () => {
      root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
    });

    expect(container.querySelector('[data-testid="chat-file-change-file-chip"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')).toBeNull();
    expect(container.textContent).not.toContain("Not saved");
  });

  it("marks only the file a partial save left out", async () => {
    const message = assistantTurn("partial", { conflictedPaths: ["bookkeeping/profile.json"] });

    await act(async () => {
      root.render(<AssistantMessageEntry message={message} conversationMessages={[message]} />);
    });

    expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')).toBeNull();
    const chip = container.querySelector<HTMLElement>('[data-testid="chat-file-change-not-saved-chip"]');
    expect(chip?.previousElementSibling?.getAttribute("data-testid")).toBe("chat-file-change-file-chip");
    expect(chip?.getAttribute("title")).toBe(
      "Changed in the space while the agent worked. The agent's version is kept as unsaved work.",
    );
  });
});
