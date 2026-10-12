// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  availability: { issue: null as null | { kind: "connection" }, recoveryVersion: 0, reportFailure: vi.fn() },
  canWrite: true,
  projectId: "project-1",
  fetchHistory: vi.fn(),
  fetchStatus: vi.fn(),
  revertCommit: vi.fn(),
  revertPaths: vi.fn(),
  showStatus: vi.fn(),
  syncToRemote: vi.fn(),
}));

vi.mock("../../../../workspace/WorkspaceAvailabilityProvider", () => ({ useWorkspaceAvailability: () => mocks.availability }));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({
    activeProjectId: mocks.projectId,
    projectCapabilitiesResolved: true,
    canWriteProject: mocks.canWrite,
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

import { LegacyChangesDrawer } from "../LegacyChangesDrawer";

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("LegacyChangesDrawer project access", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes("min-width: 900px") && window.innerWidth >= 900,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.values(mocks).forEach((mock) => { if (typeof mock === "function") mock.mockReset(); });
    mocks.canWrite = false;
    mocks.projectId = "project-1";
    mocks.availability.issue = null;
    mocks.availability.recoveryVersion = 0;
    mocks.availability.reportFailure.mockReset();
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
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([899, 900, 960, 1024])("uses Studio's responsive review layout at %ipx", async (width) => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    await act(async () => {
      root.render(<LegacyChangesDrawer openRequest={{ key: 1, previewPath: "src/app.ts", reviewMode: "focused" }} />);
    });
    await flushAsyncWork();

    const desktop = width >= 900;
    expect(container.querySelector('[data-testid="source-control-review-layout"]') !== null).toBe(desktop);
    expect(container.querySelector('[data-testid="source-control-diff-sheet"]') !== null).toBe(!desktop);
    const focused = container.querySelector<HTMLInputElement>('[data-testid="source-control-review-mode-focused"] input[type="radio"]')!;
    const all = container.querySelector<HTMLInputElement>('[data-testid="source-control-review-mode-all"] input[type="radio"]')!;
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Changes view");
    expect(focused.checked).toBe(true);
    await act(async () => container.querySelector<HTMLLabelElement>('[data-testid="source-control-review-mode-all"]')?.click());
    expect(all.checked).toBe(true);
    expect(focused.checked).toBe(false);
    expect(container.querySelector('[data-testid="source-control-rolling-diff-preview"]') !== null).toBe(desktop);
    expect(container.querySelector('[data-testid="source-control-rolling-diff-sheet"]') !== null).toBe(!desktop);
  });

  it("selects the adjacent review mode with arrow keys and retains one tab stop", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    await act(async () => root.render(<LegacyChangesDrawer />));
    await flushAsyncWork();
    const focused = container.querySelector<HTMLInputElement>('input[type="radio"][value="focused"]')!;
    const all = container.querySelector<HTMLInputElement>('input[type="radio"][value="all"]')!;
    await act(async () => focused.focus());
    await act(async () => focused.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(all.checked).toBe(true);
    expect(document.activeElement).toBe(all);
    expect(all.tabIndex).toBe(0);
    expect(focused.tabIndex).toBe(-1);
    expect(container.querySelector('[data-testid="source-control-rolling-diff-preview"]')).not.toBeNull();
    await act(async () => all.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    expect(focused.checked).toBe(true);
    expect(document.activeElement).toBe(focused);
    expect(container.querySelector('[data-testid="source-control-rolling-diff-preview"]')).toBeNull();
  });

  it("announces local read failures but suppresses them when the shared outage owns recovery", async () => {
    mocks.fetchStatus.mockResolvedValue({
      supported: true, dirtyCount: 1, dirtyPaths: [{ path: "src/app.ts", code: "M" }],
      busy: false, error: "Unable to inspect this path.",
    });
    mocks.fetchHistory.mockResolvedValue({ supported: true, entries: [], busy: false, error: "Invalid saved history." });
    await act(async () => root.render(<LegacyChangesDrawer />));
    await flushAsyncWork();
    expect([...container.querySelectorAll('[role="alert"]')].map(notice => notice.textContent))
      .toEqual(["Unable to inspect this path.", "Invalid saved history."]);
    mocks.availability.issue = { kind: "connection" };
    await act(async () => root.render(<LegacyChangesDrawer />));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("src/app.ts");
    expect(container.querySelector('[data-testid="source-control-stale-notice"]')).not.toBeNull();
  });

  it.each([390, 1280])("places Changes controls in the top row only on desktop (%ipx)", async (width) => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    const header = document.createElement("div");
    document.body.append(header);
    const close = vi.fn();
    try {
      await act(async () => root.render(<LegacyChangesDrawer headerPortalTarget={header} onRequestClose={close} />));
      await flushAsyncWork();
      const target = width >= 900 ? header : container;
      const other = width >= 900 ? container : header;
      expect(target.querySelector('[data-testid="source-control-refresh"]')).not.toBeNull();
      expect(other.querySelector('[data-testid="source-control-refresh"]')).toBeNull();
      mocks.fetchStatus.mockClear();
      await act(async () => target.querySelector<HTMLButtonElement>('[data-testid="source-control-refresh"]')?.click());
      await flushAsyncWork();
      expect(mocks.fetchStatus).toHaveBeenCalledOnce();
      await act(async () => target.querySelector<HTMLButtonElement>('[data-testid="source-control-close"]')?.click());
      expect(close).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-testid="source-control-commit-message"]')).not.toBeNull();
    } finally {
      header.remove();
    }
  });

  it("omits version and selection controls for a clean workspace but retains saved versions", async () => {
    mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 0, dirtyPaths: [], busy: false });
    await act(async () => root.render(<LegacyChangesDrawer />));
    await flushAsyncWork();
    expect(container.textContent).toContain("No pending changes.");
    expect(container.querySelector('[data-testid="source-control-commit-message"]')).toBeNull();
    expect(container.querySelector('[data-testid="source-control-select-all"]')).toBeNull();
    expect(container.querySelector('[data-testid="source-control-history-review"]')).not.toBeNull();
    mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 1, dirtyPaths: [{ path: "src/app.ts", code: "M" }], busy: false });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="source-control-refresh"]')?.click());
    await flushAsyncWork();
    expect(container.querySelector('[data-testid="source-control-commit-message"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="source-control-select-all"]')).not.toBeNull();
  });

  it("retains changes through an outage, disables writes and refreshes after shared recovery", async () => {
    mocks.canWrite = true;
    await act(async () => root.render(<LegacyChangesDrawer />));
    await flushAsyncWork();
    mocks.fetchStatus.mockResolvedValue(null);
    mocks.fetchHistory.mockResolvedValue(null);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="source-control-refresh"]')?.click());
    await flushAsyncWork();
    expect(mocks.availability.reportFailure).toHaveBeenCalled();
    expect(container.textContent).toContain("src/app.ts");
    mocks.availability.issue = { kind: "connection" };
    await act(async () => root.render(<LegacyChangesDrawer />));
    expect(container.querySelector('[data-testid="source-control-stale-notice"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Couldn't refresh changes.");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="source-control-sync"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Discard changes for src/app.ts"]')?.disabled).toBe(true);
    const calls = mocks.fetchStatus.mock.calls.length;
    mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 0, dirtyPaths: [], busy: false });
    mocks.availability.issue = null;
    mocks.availability.recoveryVersion = 1;
    await act(async () => root.render(<LegacyChangesDrawer />));
    await flushAsyncWork();
    expect(mocks.fetchStatus.mock.calls.length).toBe(calls + 1);
    expect(container.textContent).toContain("No pending changes.");
    expect(mocks.syncToRemote).not.toHaveBeenCalled();
  });

  it("does not publish an old space's failed status into the new space or report its outage", async () => {
    let resolveOld!: (value: null) => void;
    const old = new Promise<null>((resolve) => { resolveOld = resolve; });
    mocks.fetchStatus.mockImplementation(({ projectId }) => projectId === "project-1"
      ? old : Promise.resolve({ supported: true, dirtyCount: 0, dirtyPaths: [], busy: false }));
    await act(async () => root.render(<LegacyChangesDrawer />));
    mocks.projectId = "project-2";
    await act(async () => root.render(<LegacyChangesDrawer />));
    await flushAsyncWork();
    expect(container.textContent).toContain("No pending changes.");
    await act(async () => resolveOld(null));
    expect(container.textContent).toContain("No pending changes.");
    expect(mocks.availability.reportFailure).not.toHaveBeenCalled();
  });

  it("leaves the shared strip as the only outage notice for an empty Changes view", async () => {
    mocks.availability.issue = { kind: "connection" };
    await act(async () => root.render(<LegacyChangesDrawer />));
    expect(container.textContent).not.toContain("Changes are unavailable");
    expect(container.textContent).not.toContain("No pending changes.");
    expect(mocks.fetchStatus).not.toHaveBeenCalled();
  });

  it("does not report a clean workspace when status is unavailable", async () => {
    mocks.fetchStatus.mockResolvedValue(null);
    mocks.fetchHistory.mockResolvedValue(null);
    await act(async () => root.render(<LegacyChangesDrawer />));
    await flushAsyncWork();
    expect(container.textContent).toContain("Changes are unavailable");
    expect(container.textContent).not.toContain("No pending changes.");
  });

  it("puts mobile refresh in the navigation header without another heading or close button", async () => {
    const header = document.createElement("div");
    document.body.append(header);
    try {
      await act(async () => root.render(<LegacyChangesDrawer actionsPortalTarget={header} onRequestClose={vi.fn()} />));
      await flushAsyncWork();
      expect(header.querySelector('[data-testid="source-control-refresh"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="source-control-refresh"]')).toBeNull();
      expect(document.querySelector('[data-testid="source-control-close"]')).toBeNull();
      expect(header.textContent).not.toContain("Changes");
    } finally { header.remove(); }
  });

  it("keeps review available but disables every destructive version-control action for a viewer", async () => {
    await act(async () => {
      root.render(<LegacyChangesDrawer />);
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

  describe("title", () => {
    const title = () =>
      Array.from(container.querySelectorAll("p")).find((element) => element.textContent === "Changes") ?? null;

    it("renders as it always has when it did not replace History", async () => {
      await act(async () => {
        root.render(<LegacyChangesDrawer />);
      });
      await flushAsyncWork();
      expect(title()).not.toBeNull();
      expect(title()?.hasAttribute("tabindex")).toBe(false);
      expect(title()?.hasAttribute("id")).toBe(false);
      expect(title()?.hasAttribute("aria-describedby")).toBe(false);
      expect(container.textContent).not.toContain("instead of History");
    });

    it("takes the focus History dropped and says why, until focus moves on", async () => {
      // As in Studio: the drawer mounts first, and the note follows once
      // the swap is known to have dropped focus.
      await act(async () => {
        root.render(<LegacyChangesDrawer />);
      });
      await flushAsyncWork();
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => {
        root.render(<LegacyChangesDrawer arrivalNotice="This space shows Changes instead of History." />);
      });
      await flushAsyncWork();
      const heading = title();
      expect(document.activeElement).toBe(heading);
      const describedBy = heading?.getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(describedBy)?.textContent).toBe("This space shows Changes instead of History.");

      // Once focus moves on, the title is plain text again.
      const refresh = container.querySelector<HTMLButtonElement>('[data-testid="source-control-refresh"]');
      await act(async () => refresh?.focus());
      await flushAsyncWork();
      expect(heading?.hasAttribute("tabindex")).toBe(false);
      expect(heading?.hasAttribute("aria-describedby")).toBe(false);
      expect(container.textContent).not.toContain("instead of History");
    });

    it("keeps the note when only the window loses focus", async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => {
        root.render(<LegacyChangesDrawer arrivalNotice="This space shows Changes instead of History." />);
      });
      await flushAsyncWork();
      const heading = title();
      expect(document.activeElement).toBe(heading);
      // Switching to another app blurs the title but leaves it the active element.
      await act(async () => {
        heading?.dispatchEvent(new FocusEvent("blur"));
      });
      await flushAsyncWork();
      expect(document.activeElement).toBe(heading);
      expect(heading?.getAttribute("tabindex")).toBe("-1");
      expect(container.textContent).toContain("This space shows Changes instead of History.");
    });

    it("leaves focus where the person put it", async () => {
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      outside.focus();
      try {
        await act(async () => {
          root.render(<LegacyChangesDrawer arrivalNotice="This space shows Changes instead of History." />);
        });
        await flushAsyncWork();
        expect(document.activeElement).toBe(outside);
        expect(title()?.hasAttribute("tabindex")).toBe(false);
      } finally {
        outside.remove();
      }
    });
  });
});
