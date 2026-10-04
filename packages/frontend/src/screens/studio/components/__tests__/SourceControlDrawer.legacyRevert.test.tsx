// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  fetchStatus: vi.fn(),
  revertPaths: vi.fn(),
  syncToRemote: vi.fn(),
  showStatus: vi.fn(),
  token: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({
    activeProjectId: "project-1",
    projectCapabilitiesResolved: true,
    canWriteProject: true,
  }),
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ effectiveRuntimeId: "runtime-1" }),
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: mocks.showStatus }),
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

vi.mock("../../../../services/runtimeController/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../services/runtimeController/core")>()),
  runtimeControllerEnabled: true,
}));
vi.mock("../../../../services/runtimeController/origins", () => ({
  requestOriginAccessToken: mocks.token,
}));
vi.mock("../../../../services/runtimeController/workspaceLeases", () => ({
  acquireWorkspaceLease: mocks.acquire,
  releaseWorkspaceLease: mocks.release,
}));

// The legacy drawer gets the real revert client; only its neighbours are stubbed.
vi.mock("../../../../sdk/instafy", async () => {
  const git = await vi.importActual<typeof import("../../../../services/runtimeController/workspaceGit")>(
    "../../../../services/runtimeController/workspaceGit",
  );
  return {
    controllerClient: {
      workspace: {
        git: {
          fetchHistory: mocks.fetchHistory,
          fetchStatus: mocks.fetchStatus,
          revertCommit: git.revertWorkspaceGitCommitFromController,
          revertPaths: mocks.revertPaths,
          syncToRemote: mocks.syncToRemote,
        },
      },
    },
  };
});

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

describe("SourceControlDrawer (legacy mode) revert", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchStatus.mockResolvedValue({
      supported: true,
      dirtyCount: 0,
      dirtyPaths: [],
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("never issues a revert-commit request against the stateful gateway", async () => {
    await act(async () => {
      root.render(<SourceControlDrawer />);
    });
    await flushAsyncWork();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="source-control-history-toggle"]')?.click();
    });
    const revert = container.querySelector<HTMLButtonElement>('[data-testid="source-control-history-revert"]');
    expect(revert).not.toBeNull();
    await act(async () => {
      revert?.click();
    });
    await flushAsyncWork();

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    // The same outcome the legacy drawer has always had: an error, no request.
    expect(mocks.showStatus).toHaveBeenCalledWith("failed to obtain origin token", "error", 6000);
  });
});
