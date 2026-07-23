// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  fetchStatus: vi.fn(),
  revertCommit: vi.fn(),
  revertPaths: vi.fn(),
  showStatus: vi.fn(),
  syncToRemote: vi.fn(),
}));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({
    activeProjectId: "project-1",
    projectCapabilitiesResolved: true,
    canWriteProject: false,
  }),
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ effectiveRuntimeId: "runtime-1" }),
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: mocks.showStatus }),
}));

vi.mock("../../../../hooks/useBreakpoint", () => ({
  useBreakpoint: () => false,
}));

vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    activeConversationId: null,
    createConversation: vi.fn(() => ({ localId: "conversation-1" })),
    setConversationDraft: vi.fn(),
  }),
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    openConversationTab: vi.fn(),
    openGitReviewTab: vi.fn(),
    openPanelTab: vi.fn(),
    requestUrlPush: vi.fn(),
  }),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      git: {
        fetchHistory: mocks.fetchHistory,
        fetchStatus: mocks.fetchStatus,
        revertCommit: mocks.revertCommit,
        revertPaths: mocks.revertPaths,
        syncToRemote: mocks.syncToRemote,
      },
    },
  },
}));

vi.mock("../WorkspaceGitDiffPanel", () => ({
  WorkspaceGitDiffPanel: () => null,
}));

vi.mock("../WorkspaceGitRollingDiffPanel", () => ({
  WorkspaceGitRollingDiffPanel: () => null,
}));

import { SourceControlDrawer } from "../SourceControlDrawer";

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SourceControlDrawer project access", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchStatus.mockResolvedValue({
      supported: true,
      dirtyCount: 1,
      dirtyPaths: [{ path: "src/app.ts", code: "M" }],
      pathGroups: [],
      busy: false,
      error: null,
    });
    mocks.fetchHistory.mockResolvedValue({
      supported: true,
      entries: [
        {
          commit: "a".repeat(40),
          shortCommit: "aaaaaaaa",
          committedAt: new Date().toISOString(),
          authorName: "Instafy",
          authorEmail: "instafy@example.com",
          subject: "Saved version",
        },
      ],
      busy: false,
      error: null,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps review available but disables every destructive version-control action for a viewer", async () => {
    await act(async () => {
      root.render(<SourceControlDrawer />);
    });
    await flushAsyncWork();

    expect(container.querySelector<HTMLInputElement>('[data-testid="source-control-commit-message"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="source-control-sync"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="source-control-discard"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Discard changes for src/app.ts"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="source-control-history-review"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="source-control-history-toggle"]')
        ?.click();
    });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="source-control-history-revert"]')?.disabled).toBe(true);

    expect(mocks.syncToRemote).not.toHaveBeenCalled();
    expect(mocks.revertPaths).not.toHaveBeenCalled();
    expect(mocks.revertCommit).not.toHaveBeenCalled();
  });
});
