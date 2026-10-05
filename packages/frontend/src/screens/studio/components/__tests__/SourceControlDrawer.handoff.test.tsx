// @vitest-environment jsdom

/**
 * The real drawers under the switch: when a probe Retry answers that the
 * space uses Changes, History (and the Retry that had focus) goes away, and
 * the Changes title takes keyboard focus with a note saying why.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probeStatus: vi.fn(),
  fetchHistory: vi.fn(),
  fetchStatus: vi.fn(),
  fetchRecovery: vi.fn(),
  origin: { originId: "gateway", mode: "hosted" },
}));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({ activeProjectId: "project-1", projectCapabilitiesResolved: true, canWriteProject: true }),
}));
vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ desktopOrigin: mocks.origin, effectiveRuntimeId: "runtime-1" }),
}));
vi.mock("../../../../providers/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: vi.fn() }),
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
// The mode probe's status call.
vi.mock("../../../../services/runtimeController/workspaceGit", () => ({
  fetchWorkspaceGitStatusFromController: mocks.probeStatus,
}));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      git: {
        fetchHistory: mocks.fetchHistory,
        fetchStatus: mocks.fetchStatus,
        fetchRecovery: mocks.fetchRecovery,
        revertCommit: vi.fn(),
        revertPaths: vi.fn(),
        syncToRemote: vi.fn(),
      },
    },
  },
}));
vi.mock("../WorkspaceGitDiffPanel", () => ({ WorkspaceGitDiffPanel: () => null }));
vi.mock("../WorkspaceGitRollingDiffPanel", () => ({ WorkspaceGitRollingDiffPanel: () => null }));

import { resetWorkspaceVersioningProbesForTests } from "../../../../services/runtimeController/workspaceVersioning";
import { resetWorkspaceVersioningCacheForTests } from "../../../../services/runtimeController/workspaceVersioningCache";
import { resetUnsavedWorkStoreForTests } from "../../../../workspace/unsavedWorkStore";
import { SourceControlDrawer } from "../SourceControlDrawer";

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("SourceControlDrawer: focus across a mode swap", () => {
  let container: HTMLDivElement;
  let root: Root;
  let header: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    Object.values(mocks).forEach((mock) => {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    });
    mocks.fetchHistory.mockResolvedValue({ supported: true, entries: [], hasMore: false, busy: false, error: null });
    mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [], busy: false, error: null });
    mocks.fetchRecovery.mockResolvedValue({ status: "unsupported", entries: [], originId: "gateway", originMode: "hosted" });
    resetWorkspaceVersioningCacheForTests();
    resetWorkspaceVersioningProbesForTests();
    resetUnsavedWorkStoreForTests();
    window.localStorage.clear();
    // The last visit saw a stateless gateway: History shows while the probe runs.
    window.localStorage.setItem("instafy.versioning.mode.project-1", "stateless");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    header = document.createElement("div");
    document.body.append(header);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    header.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([false, true])("lands on the Changes title after a mode swap, with mobile header %s", async (mobileHeader) => {
    // The probe made on opening gets no answer; Retry's probe answers Changes.
    mocks.probeStatus
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] });
    await act(async () => root.render(<SourceControlDrawer actionsPortalTarget={mobileHeader ? header : null} />));
    await flush();
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="history-probe-retry"]');
    expect(retry).not.toBeNull();

    await act(async () => retry?.focus());
    await act(async () => retry?.click());
    await flush();

    const drawer = container.querySelector('[data-testid="source-control-drawer"]');
    expect(drawer?.getAttribute("data-mode")).toBe("legacy");
    const title = Array.from(container.querySelectorAll("p")).find((element) => element.textContent === "Changes");
    expect(document.activeElement).toBe(title);
    expect(title?.classList.contains("sr-only")).toBe(mobileHeader);
    if (mobileHeader) {
      expect(header.querySelector('[data-testid="source-control-refresh"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="source-control-refresh"]')).toBeNull();
    }
    const describedBy = title?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("This space shows Changes instead of History.");
  });
});
