// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveWorkspaceVersioning } from "../../../../workspace/useActiveWorkspaceVersioning";

const mocks = vi.hoisted(() => ({
  fetchHistory: vi.fn(),
  fetchStatus: vi.fn(),
  revertCommit: vi.fn(),
  syncToRemote: vi.fn(),
  fetchRecovery: vi.fn(),
  restoreRecovery: vi.fn(),
  dismissRecovery: vi.fn(),
  readAt: vi.fn(),
  saveChanges: vi.fn(),
  openGitReviewTab: vi.fn(),
  openConversationTab: vi.fn(),
  setConversationDraft: vi.fn(),
  createConversation: vi.fn(() => ({ localId: "conversation-new" })),
  requestUrlPush: vi.fn(),
  probe: vi.fn(),
  project: { activeProjectId: "project-1", projectCapabilitiesResolved: true, canWriteProject: true },
}));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => mocks.project,
}));
vi.mock("../../../../providers/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    activeConversationId: "conversation-1",
    createConversation: mocks.createConversation,
    setConversationDraft: mocks.setConversationDraft,
  }),
}));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    openConversationTab: mocks.openConversationTab,
    openGitReviewTab: mocks.openGitReviewTab,
    requestUrlPush: mocks.requestUrlPush,
  }),
}));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      git: {
        fetchHistory: mocks.fetchHistory,
        fetchStatus: mocks.fetchStatus,
        revertCommit: mocks.revertCommit,
        syncToRemote: mocks.syncToRemote,
        fetchRecovery: mocks.fetchRecovery,
        restoreRecovery: mocks.restoreRecovery,
        dismissRecovery: mocks.dismissRecovery,
      },
      files: { readAt: mocks.readAt },
      save: { changes: mocks.saveChanges },
    },
  },
}));

import { resetUnsavedWorkStoreForTests } from "../../../../workspace/unsavedWorkStore";
import {
  HISTORY_BUSY_RETRIES,
  HISTORY_BUSY_RETRY_MS,
  HISTORY_COMMIT_DEBOUNCE_MS,
  HISTORY_FOCUS_REFRESH_MS,
  HistoryDrawer,
} from "../HistoryDrawer";

function hex(seed: number): string {
  return seed.toString(16).padStart(40, "0");
}

function historyEntry(seed: number, extra: Record<string, unknown> = {}) {
  return {
    commit: hex(seed),
    shortCommit: hex(seed).slice(0, 8),
    committedAt: new Date().toISOString(),
    authorName: "Ada",
    authorEmail: "u-1@users.noreply.instafy.dev",
    subject: `Update file-${seed}.txt`,
    resolvedBy: null,
    firstParent: hex(seed + 1000),
    ...extra,
  };
}

function page(entries: unknown[], extra: Record<string, unknown> = {}) {
  return { supported: true, entries, branch: "main", headRef: "main", hasMore: false, busy: false, error: null, ...extra };
}

function versioning(overrides: Partial<ActiveWorkspaceVersioning> = {}): ActiveWorkspaceVersioning {
  return {
    mode: "stateless",
    resolved: true,
    firstPaintMode: "stateless",
    originId: "origin-1",
    originMode: "hosted",
    stateless: true,
    recovery: "unknown",
    checkedAt: Date.now(),
    refresh: mocks.probe,
    projectId: "project-1",
    chromeMode: "stateless",
    historyReady: true,
    ...overrides,
  };
}

const desktop = (): ActiveWorkspaceVersioning =>
  versioning({ mode: "desktop", chromeMode: "desktop", firstPaintMode: "desktop", originMode: "desktop", stateless: false });

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
}

function q<T extends Element = HTMLElement>(container: ParentNode, testId: string): T | null {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

describe("HistoryDrawer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.values(mocks).forEach((mock) => {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    });
    mocks.project = { activeProjectId: "project-1", projectCapabilitiesResolved: true, canWriteProject: true };
    mocks.createConversation.mockReturnValue({ localId: "conversation-new" });
    mocks.fetchHistory.mockResolvedValue(page([historyEntry(1)]));
    mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] });
    mocks.fetchRecovery.mockResolvedValue({ status: "unsupported", entries: [], originId: "origin-1", originMode: "hosted" });
    mocks.probe.mockResolvedValue(null);
    resetUnsavedWorkStoreForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(
    state: ActiveWorkspaceVersioning = versioning(),
    onRequestClose = vi.fn(),
    extra: { probeFailed?: boolean; arrivalNotice?: string | null } = {},
  ) {
    await act(async () =>
      root.render(<HistoryDrawer versioning={state} onRequestClose={onRequestClose} {...extra} />),
    );
    await flush();
  }

  async function expandFirst() {
    await act(async () => q<HTMLButtonElement>(container, "source-control-history-toggle")?.click());
  }

  async function confirmRevert() {
    await expandFirst();
    await act(async () => q<HTMLButtonElement>(container, "source-control-history-revert")?.click());
    const confirm = q<HTMLButtonElement>(document.body, "history-revert-dialog-confirm");
    expect(confirm).not.toBeNull();
    await act(async () => confirm?.click());
    await flush();
  }

  it("makes no request while the mode is only a guess", async () => {
    await render(versioning({ resolved: false, historyReady: false }));
    expect(container.textContent).toContain("Loading history");
    expect(q(container, "source-control-drawer")?.getAttribute("data-mode")).toBe("history");
    expect(mocks.fetchHistory).not.toHaveBeenCalled();
    expect(mocks.fetchStatus).not.toHaveBeenCalled();
  });

  it("keeps Refresh usable while the mode is unknown", async () => {
    await render(versioning({ resolved: false, historyReady: false }));
    expect(container.textContent).toContain("Loading history");
    const refresh = q<HTMLButtonElement>(container, "source-control-refresh");
    expect(refresh?.disabled).toBe(false);
    let answer!: (value: unknown) => void;
    mocks.probe.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await act(async () => refresh?.focus());
    await act(async () => refresh?.click());
    await flush();
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(mocks.fetchHistory).not.toHaveBeenCalled();
    // Pending, not natively disabled: keyboard focus stays on it.
    expect(refresh?.disabled).toBe(false);
    expect(refresh?.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(refresh);
    await act(async () => answer(null));
    await flush();
    expect(document.activeElement).toBe(refresh);
    expect(q(container, "history-status")?.textContent).toBe("Couldn't check this space's saved versions.");
    expect(q(container, "history-probe-retry")).not.toBeNull();
  });

  it("says when the mode probe got no answer and keeps focus on Retry while it asks again", async () => {
    const onRequestClose = vi.fn();
    await render(versioning({ resolved: false, historyReady: false }), onRequestClose, { probeFailed: true });
    // The message is in the polite status region; Retry sits where the list goes.
    const status = q(container, "history-status");
    expect(status?.textContent).toBe("Couldn't check this space's saved versions.");
    expect(q(container, "history-probe-error")).not.toBeNull();
    expect(container.textContent).not.toContain("Loading history");
    const retry = q<HTMLButtonElement>(container, "history-probe-retry");
    let answer!: (value: unknown) => void;
    mocks.probe.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await act(async () => retry?.focus());
    await act(async () => retry?.click());
    await flush();
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    // While it asks again, Retry stays (pending) and keeps keyboard focus.
    expect(q(container, "history-probe-retry")).toBe(retry);
    expect(retry?.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(retry);
    const firstMessage = status?.firstElementChild;
    await act(async () => answer(null));
    await flush();
    expect(document.activeElement).toBe(retry);
    // Announced again: a new node with the same message.
    expect(status?.textContent).toBe("Couldn't check this space's saved versions.");
    expect(status?.firstElementChild).not.toBe(firstMessage);
    expect(mocks.fetchHistory).not.toHaveBeenCalled();

    // An answer before the list is ready: Retry goes away, focus waits on
    // the drawer's title and the status says what happens next.
    mocks.probe.mockResolvedValueOnce({ mode: "stateless" });
    await act(async () => retry?.click());
    await flush();
    expect(q(container, "history-probe-retry")).toBeNull();
    const title = container.querySelector("h2");
    expect(title?.textContent).toBe("History");
    expect(document.activeElement).toBe(title);
    expect(status?.textContent).toBe("Loading saved versions…");

    // The list shows: Saved versions takes focus over from the title.
    await act(async () =>
      root.render(<HistoryDrawer versioning={versioning()} onRequestClose={onRequestClose} probeFailed />),
    );
    await flush();
    const heading = Array.from(container.querySelectorAll("h3")).find((item) => item.textContent === "Saved versions");
    expect(document.activeElement).toBe(heading);
    expect(q(container, "history-status")?.textContent).toBe("");
  });

  it("leaves focus on Refresh when its probe answers before the list is ready", async () => {
    await render(versioning({ resolved: false, historyReady: false }), vi.fn(), { probeFailed: true });
    const refresh = q<HTMLButtonElement>(container, "source-control-refresh");
    mocks.probe.mockResolvedValueOnce({ mode: "stateless" });
    await act(async () => refresh?.focus());
    await act(async () => refresh?.click());
    await flush();
    expect(q(container, "history-probe-retry")).toBeNull();
    expect(document.activeElement).toBe(refresh);
    // The failure is no longer true: the status says what happens next.
    expect(q(container, "history-status")?.textContent).toBe("Loading saved versions…");
  });

  it("describes Retry with the failure it retries, also after a repeated failure", async () => {
    await render(versioning({ resolved: false, historyReady: false }), vi.fn(), { probeFailed: true });
    const retry = q<HTMLButtonElement>(container, "history-probe-retry");
    const description = () => {
      const ids = retry?.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
      return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    };
    expect(description()).toBe("Couldn't check this space's saved versions.");
    // A second failure posts a new message node: Retry still points at it.
    mocks.probe.mockResolvedValueOnce(null);
    await act(async () => retry?.focus());
    await act(async () => retry?.click());
    await flush();
    expect(q(container, "history-probe-retry")).toBe(retry);
    expect(description()).toBe("Couldn't check this space's saved versions.");
  });

  it("takes the focus Changes dropped on its title and says why", async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    await render(versioning(), vi.fn(), { arrivalNotice: "This space shows History instead of Changes." });
    const title = container.querySelector("h2");
    expect(title?.textContent).toBe("History");
    expect(document.activeElement).toBe(title);
    expect(q(container, "history-status")?.textContent).toBe("This space shows History instead of Changes.");
  });

  it("keeps focus on Refresh while it reloads an empty list", async () => {
    mocks.fetchHistory.mockResolvedValueOnce(null);
    await render();
    expect(q(container, "history-error")?.textContent).toBe("Couldn't load saved versions. Try Refresh.");
    let answer!: (value: unknown) => void;
    mocks.fetchHistory.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const refresh = q<HTMLButtonElement>(container, "source-control-refresh");
    await act(async () => refresh?.focus());
    await act(async () => refresh?.click());
    await flush();
    expect(refresh?.disabled).toBe(false);
    expect(document.activeElement).toBe(refresh);
    await act(async () => answer(page([historyEntry(1)])));
    await flush();
    expect(document.activeElement).toBe(refresh);
    expect(refresh?.getAttribute("aria-disabled")).toBeNull();
  });

  it("loads one page from the pinned default origin and never polls", async () => {
    vi.useFakeTimers();
    await render();
    expect(mocks.fetchHistory).toHaveBeenCalledTimes(1);
    expect(mocks.fetchHistory).toHaveBeenCalledWith({
      projectId: "project-1",
      originId: "origin-1",
      routing: "default",
      limit: 20,
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flush();
    expect(mocks.fetchHistory).toHaveBeenCalledTimes(1);
    // Stateless spaces have no Desktop line and make no status call.
    expect(mocks.fetchStatus).not.toHaveBeenCalled();
    expect(q(container, "desktop-changes-line")).toBeNull();
  });

  it("reloads after a workspace commit once the burst settles, and on focus after a minute", async () => {
    vi.useFakeTimers();
    await render();
    for (let i = 0; i < 3; i += 1) {
      window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: "project-1" } }));
    }
    window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: "other" } }));
    await act(async () => {
      vi.advanceTimersByTime(HISTORY_COMMIT_DEBOUNCE_MS);
    });
    await flush();
    expect(mocks.fetchHistory).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(mocks.fetchHistory).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(HISTORY_FOCUS_REFRESH_MS);
    });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(mocks.fetchHistory).toHaveBeenCalledTimes(3);
  });

  it("pages with skip, keeps focus on the first new row and stops when a page adds nothing", async () => {
    const first = Array.from({ length: 20 }, (_, index) => historyEntry(index + 1));
    mocks.fetchHistory.mockResolvedValueOnce(page(first, { hasMore: true }));
    await render();
    const more = q<HTMLButtonElement>(container, "history-show-more");
    expect(more).not.toBeNull();

    mocks.fetchHistory.mockResolvedValueOnce(page([historyEntry(21), historyEntry(22)], { hasMore: true }));
    await act(async () => more?.click());
    await flush();
    expect(mocks.fetchHistory).toHaveBeenLastCalledWith({
      projectId: "project-1",
      originId: "origin-1",
      routing: "default",
      limit: 20,
      skip: 20,
    });
    const rows = container.querySelectorAll('[data-testid="source-control-history-entry"]');
    expect(rows).toHaveLength(22);
    expect(document.activeElement?.textContent).toContain("Update file-21.txt");

    // A server that ignores skip answers the same page: the button goes away.
    mocks.fetchHistory.mockResolvedValueOnce(page(first, { hasMore: true }));
    await act(async () => q<HTMLButtonElement>(container, "history-show-more")?.click());
    await flush();
    expect(container.querySelectorAll('[data-testid="source-control-history-entry"]')).toHaveLength(22);
    expect(q(container, "history-show-more")).toBeNull();
  });

  describe("a busy origin", () => {
    const busyPage = () => page([], { busy: true });

    it("is not an empty history: it says it is checking and asks again", async () => {
      vi.useFakeTimers();
      mocks.fetchHistory.mockResolvedValueOnce(busyPage()).mockResolvedValue(page([historyEntry(1)]));
      await render(desktop());
      expect(q(container, "history-empty")).toBeNull();
      expect(q(container, "history-busy")?.textContent).toBe("Checking saved versions…");
      expect(mocks.fetchHistory).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(HISTORY_BUSY_RETRY_MS);
      });
      await flush();
      expect(mocks.fetchHistory).toHaveBeenCalledTimes(2);
      expect(container.querySelectorAll('[data-testid="source-control-history-entry"]')).toHaveLength(1);
      expect(q(container, "history-busy")).toBeNull();
    });

    it("stops after a few tries and points at Refresh", async () => {
      vi.useFakeTimers();
      mocks.fetchHistory.mockResolvedValue(busyPage());
      await render(desktop());
      for (let i = 0; i < HISTORY_BUSY_RETRIES; i += 1) {
        await act(async () => {
          vi.advanceTimersByTime(HISTORY_BUSY_RETRY_MS);
        });
        await flush();
      }
      expect(mocks.fetchHistory).toHaveBeenCalledTimes(HISTORY_BUSY_RETRIES + 1);
      expect(q(container, "history-error")?.textContent).toBe("The space is busy saving changes. Try Refresh in a moment.");
      expect(q(container, "history-empty")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await flush();
      expect(mocks.fetchHistory).toHaveBeenCalledTimes(HISTORY_BUSY_RETRIES + 1);
      expect(q<HTMLButtonElement>(container, "source-control-refresh")?.disabled).toBe(false);
    });

    it("stops asking once the drawer closes while the first load is out", async () => {
      vi.useFakeTimers();
      let answer!: (value: unknown) => void;
      mocks.fetchHistory.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      mocks.fetchHistory.mockResolvedValue(busyPage());
      await render(desktop());
      expect(mocks.fetchHistory).toHaveBeenCalledTimes(1);
      // The host unmounts the drawer on close; the load then answers busy.
      await act(async () => root.render(null));
      await act(async () => answer(busyPage()));
      await flush();
      await act(async () => {
        vi.advanceTimersByTime(HISTORY_BUSY_RETRY_MS * (HISTORY_BUSY_RETRIES + 2));
      });
      await flush();
      expect(mocks.fetchHistory).toHaveBeenCalledTimes(1);
    });

    it("keeps Show more when a later page answers busy", async () => {
      const first = Array.from({ length: 20 }, (_, index) => historyEntry(index + 1));
      mocks.fetchHistory.mockResolvedValueOnce(page(first, { hasMore: true }));
      await render();
      mocks.fetchHistory.mockResolvedValueOnce(busyPage());
      await act(async () => q<HTMLButtonElement>(container, "history-show-more")?.click());
      await flush();
      expect(q(container, "history-show-more")).not.toBeNull();
      expect(container.querySelectorAll('[data-testid="source-control-history-entry"]')).toHaveLength(20);
      expect(q(container, "history-status")?.textContent).toBe(
        "The space is busy saving changes. Try Show more again in a moment.",
      );
    });
  });

  describe("keyboard focus", () => {
    const savedVersionsHeading = () =>
      Array.from(container.querySelectorAll("h3")).find((heading) => heading.textContent === "Saved versions");

    it("lands on Saved versions when Show more goes away", async () => {
      const first = Array.from({ length: 20 }, (_, index) => historyEntry(index + 1));
      mocks.fetchHistory.mockResolvedValueOnce(page(first, { hasMore: true }));
      await render();
      mocks.fetchHistory.mockResolvedValueOnce(page(first, { hasMore: true }));
      const more = q<HTMLButtonElement>(container, "history-show-more");
      await act(async () => more?.focus());
      await act(async () => more?.click());
      await flush();
      expect(q(container, "history-show-more")).toBeNull();
      expect(document.activeElement).toBe(savedVersionsHeading());
    });

    it("lands on Saved versions when Save as version empties the Desktop line", async () => {
      mocks.fetchStatus
        .mockResolvedValueOnce({ supported: true, dirtyCount: 2, dirtyPaths: [], pathGroups: [] })
        .mockResolvedValue({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] });
      mocks.syncToRemote.mockResolvedValue({ ok: true, rev: hex(77), committed: true, report: null });
      await render(desktop());
      const save = q<HTMLButtonElement>(container, "desktop-save-as-version");
      await act(async () => save?.focus());
      await act(async () => save?.click());
      await flush();
      expect(q(container, "desktop-changes-line")).toBeNull();
      expect(document.activeElement).toBe(savedVersionsHeading());
    });
  });

  it("shows no Show more for a short page (a Desktop origin capped at 12)", async () => {
    mocks.fetchHistory.mockResolvedValueOnce(page(Array.from({ length: 12 }, (_, index) => historyEntry(index + 1))));
    await render(desktop());
    expect(q(container, "history-show-more")).toBeNull();
  });

  it("names people, marks Instafy with a badge and never draws uppercase pills", async () => {
    mocks.fetchHistory.mockResolvedValueOnce(
      page([
        historyEntry(1, { authorName: "Ada", authorEmail: "u-1@users.noreply.instafy.dev" }),
        historyEntry(2, { authorName: "Instafy", authorEmail: "origin@instafy.dev", subject: "instafy: refresh skills" }),
        historyEntry(3, { authorName: "", authorEmail: "me@example.com", resolvedBy: "agent" }),
        historyEntry(4, { authorName: "Bob", authorEmail: "origin@instafy.dev", actor: "user" }),
      ]),
    );
    await render();
    const rows = Array.from(container.querySelectorAll('[data-testid="source-control-history-entry"]'));
    expect(rows[0]?.querySelector('[data-testid="history-author"]')?.textContent).toBe("Ada");
    expect(rows[1]?.querySelector('[data-testid="history-author-instafy"]')?.textContent).toBe("Instafy");
    expect(rows[1]?.textContent).toContain("refresh skills");
    expect(rows[1]?.textContent).not.toContain("instafy:");
    expect(rows[2]?.querySelector('[data-testid="history-author"]')?.textContent).toBe("me@example.com");
    expect(rows[2]?.querySelector('[data-testid="source-control-history-resolved-badge"]')?.textContent).toBe(
      "Assistant-resolved",
    );
    expect(rows[3]?.querySelector('[data-testid="history-author"]')?.textContent).toBe("Bob");
    expect(container.querySelector('[class*="uppercase"]')).toBeNull();
  });

  it("opens a saved version review pinned to the origin", async () => {
    await render();
    await act(async () => q<HTMLButtonElement>(container, "source-control-history-review")?.click());
    expect(mocks.openGitReviewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "savedVersion",
        commit: hex(1),
        title: "Update file-1.txt",
        routing: "default",
        originId: "origin-1",
      }),
    );
  });

  it("reverts through a dialog with the first parent as base", async () => {
    mocks.revertCommit.mockResolvedValue({ ok: true, rev: hex(99), committed: true });
    const commits: unknown[] = [];
    const onCommit = (event: Event) => commits.push((event as CustomEvent).detail);
    window.addEventListener("instafy:workspace-commit", onCommit);
    await render();
    await expandFirst();
    await act(async () => q<HTMLButtonElement>(container, "source-control-history-revert")?.click());
    const dialog = q(document.body, "history-revert-dialog");
    expect(dialog?.textContent).toContain("Revert this version?");
    // The dialog names the version it reverts.
    expect(q(document.body, "history-revert-dialog-detail")?.textContent).toBe(`Update file-1.txt (${hex(1).slice(0, 8)})`);
    expect(dialog?.textContent).toContain("A new version that undoes it is saved on top. Nothing is removed from history.");
    // React Aria moves focus into the dialog after it mounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("history-revert-dialog-cancel");
    await act(async () => q<HTMLButtonElement>(document.body, "history-revert-dialog-confirm")?.click());
    await flush();
    window.removeEventListener("instafy:workspace-commit", onCommit);

    expect(mocks.revertCommit).toHaveBeenCalledWith({
      projectId: "project-1",
      commit: hex(1),
      base: hex(1001),
      originId: "origin-1",
      routing: "default",
      leaseConflictRetryDelayMs: 1500,
    });
    expect(q(container, "history-status")?.textContent).toBe("Reverted. Saved as a new version.");
    expect(commits).toEqual([{ projectId: "project-1", kind: "workspace.commit", data: { rev: hex(99) } }]);
  });

  it("cancelling the dialog sends nothing", async () => {
    await render();
    await expandFirst();
    await act(async () => q<HTMLButtonElement>(container, "source-control-history-revert")?.click());
    await act(async () => q<HTMLButtonElement>(document.body, "history-revert-dialog-cancel")?.click());
    await flush();
    expect(mocks.revertCommit).not.toHaveBeenCalled();
    expect(q(document.body, "history-revert-dialog")).toBeNull();
  });

  it("says which files a Desktop revert left on this computer", async () => {
    mocks.revertCommit.mockResolvedValue({
      ok: true,
      rev: hex(99),
      report: {
        gitSyncStatus: "partial",
        conflictedPaths: ["a.ts"],
        rejectedPaths: [{ path: ".env", reason: "secret", keptSavedVersion: false }],
      },
    });
    await render(desktop());
    await confirmRevert();
    const status = q(container, "history-status");
    expect(status?.textContent).toBe(
      "Reverted. Saved as a new version. 1 file wasn't saved because it changed in the space: a.ts. " +
        "Your version is still in the folder on this computer. " +
        ".env stays on this computer: secret files aren't saved to the space.",
    );
    expect(status?.querySelector("span")?.className).toContain("text-secondary-800");
  });

  it("omits base when the history has no first parent and reports a no-op revert", async () => {
    mocks.fetchHistory.mockResolvedValueOnce(page([historyEntry(1, { firstParent: undefined })]));
    mocks.revertCommit.mockResolvedValue({ ok: true, rev: hex(1), committed: false });
    await render(desktop());
    await confirmRevert();
    expect(mocks.revertCommit).toHaveBeenCalledWith(expect.objectContaining({ base: null }));
    expect(q(container, "history-status")?.textContent).toBe("Nothing to revert. Those changes are already undone.");
  });

  it.each([
    [
      "revert_conflict",
      { ok: false, code: "revert_conflict", paths: ["a.txt"], errorInfo: { status: 409, code: "revert_conflict", message: "conflict", routeUnavailable: false } },
      "Later changes touch the same lines, so this can't be reverted automatically.",
      true,
    ],
    [
      "a merge without base",
      { ok: false, errorInfo: { status: 400, message: "merge commit needs a base", routeUnavailable: false } },
      "This version combines several saves and can't be reverted here yet. Ask the agent to undo it.",
      true,
    ],
    [
      "no route yet",
      { ok: false, routeUnavailable: true, errorInfo: { status: 404, message: "origin path not found", routeUnavailable: true } },
      "Reverting isn't available on this server yet. Ask the agent to undo it instead.",
      false,
    ],
    [
      "dirty Desktop files",
      { ok: false, code: "dirty_paths", paths: ["a.txt", "b.txt"], errorInfo: { status: 409, code: "dirty_paths", message: "dirty", routeUnavailable: false } },
      "Files on this computer have edits this revert would change: a.txt and b.txt. Save them first.",
      false,
    ],
    [
      "the agent holding the lease",
      { ok: false, code: "lease_conflict", errorInfo: { status: 409, code: "lease_conflict", message: "project currently leased by another session", routeUnavailable: false } },
      "The agent is saving right now. Try again in a moment.",
      false,
    ],
    [
      "a busy main",
      { ok: false, code: "main_busy", errorInfo: { status: 409, code: "main_busy", message: "busy", routeUnavailable: false } },
      "The space is busy saving other changes. Try again in a moment.",
      false,
    ],
  ])("maps %s to its copy", async (_label, result, copy, offersAgent) => {
    mocks.revertCommit.mockResolvedValue(result);
    await render();
    await confirmRevert();
    const status = q(container, "history-status");
    expect(status?.textContent).toContain(copy);
    expect(status?.textContent).not.toContain("\u2014");
    const ask = q<HTMLButtonElement>(container, "history-revert-ask-agent");
    expect(ask !== null).toBe(offersAgent);
    if (ask) {
      await act(async () => ask.click());
      expect(mocks.setConversationDraft).toHaveBeenCalledWith(
        "conversation-1",
        `Undo the version "Update file-1.txt" (${hex(1).slice(0, 8)}) without losing later changes.`,
      );
      expect(mocks.openConversationTab).toHaveBeenCalledWith("conversation-1");
    }
  });

  it("keeps results in view: the status region is outside the scrolling list", async () => {
    mocks.fetchHistory.mockResolvedValueOnce(page(Array.from({ length: 20 }, (_, index) => historyEntry(index + 1)), { hasMore: true }));
    mocks.revertCommit.mockResolvedValue({
      ok: false,
      code: "revert_conflict",
      paths: ["a.txt"],
      errorInfo: { status: 409, code: "revert_conflict", message: "conflict", routeUnavailable: false },
    });
    await render();
    const toggles = container.querySelectorAll<HTMLButtonElement>('[data-testid="source-control-history-toggle"]');
    await act(async () => toggles[19]?.click());
    await act(async () => q<HTMLButtonElement>(container, "source-control-history-revert")?.click());
    await act(async () => q<HTMLButtonElement>(document.body, "history-revert-dialog-confirm")?.click());
    await flush();
    const status = q(container, "history-status");
    const scroller = q(container, "history-scroll");
    expect(status?.textContent).toContain("Later changes touch the same lines");
    expect(scroller?.contains(status)).toBe(false);
    expect(scroller?.contains(q(container, "history-revert-ask-agent"))).toBe(false);
    // Between the header and the list, in the drawer's own column.
    expect(status?.parentElement).toBe(q(container, "source-control-drawer"));
    expect(status?.compareDocumentPosition(scroller!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("disables Revert and Save as version for a viewer but keeps Review", async () => {
    mocks.project = { activeProjectId: "project-1", projectCapabilitiesResolved: true, canWriteProject: false };
    mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 2, dirtyPaths: [], pathGroups: [] });
    await render(desktop());
    await expandFirst();
    expect(q<HTMLButtonElement>(container, "source-control-history-revert")?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(container, "desktop-save-as-version")?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(container, "source-control-history-review-inline")?.disabled).toBe(false);
    expect(mocks.revertCommit).not.toHaveBeenCalled();
    expect(mocks.syncToRemote).not.toHaveBeenCalled();
  });

  describe("Desktop line", () => {
    it("counts files changed outside Studio and hides at zero", async () => {
      mocks.fetchStatus.mockResolvedValueOnce({ supported: true, dirtyCount: 3, dirtyPaths: [], pathGroups: [] });
      await render(desktop());
      expect(mocks.fetchStatus).toHaveBeenCalledWith({
        projectId: "project-1",
        originId: "origin-1",
        routing: "default",
        limit: 1,
      });
      expect(q(container, "desktop-changes-line")?.textContent).toContain("3 files changed outside Studio");

      mocks.fetchStatus.mockResolvedValueOnce({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] });
      await act(async () => q<HTMLButtonElement>(container, "source-control-refresh")?.click());
      await flush();
      expect(q(container, "desktop-changes-line")).toBeNull();
    });

    it("saves as a version and reports what stayed on this computer", async () => {
      mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 5, dirtyPaths: [], pathGroups: [] });
      mocks.syncToRemote.mockResolvedValue({
        ok: true,
        rev: hex(77),
        committed: true,
        report: {
          conflictedPaths: ["a.txt", "b.txt"],
          rejectedPaths: [{ path: ".env", reason: "secret", keptSavedVersion: false }],
        },
      });
      await render(desktop());
      await act(async () => q<HTMLButtonElement>(container, "desktop-save-as-version")?.click());
      await flush();
      expect(mocks.syncToRemote).toHaveBeenCalledWith({
        projectId: "project-1",
        originId: "origin-1",
        routing: "default",
        message: "Save changes from this computer",
        leaseConflictRetryDelayMs: 1500,
      });
      const text = q(container, "history-status")?.textContent ?? "";
      expect(text).toContain("Saved 2 files as a version.");
      expect(text).toContain(
        "2 files weren't saved because they changed in the space: a.txt and b.txt. Your versions are still in the folder on this computer.",
      );
      expect(text).toContain(".env stays on this computer: secret files aren't saved to the space.");
      // The count is checked again after the action.
      expect(mocks.fetchStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("checks the folder again after a not_saved refusal, which can leave it clean", async () => {
      // not_saved commits the files on this computer, then the push fails.
      mocks.fetchStatus
        .mockResolvedValueOnce({ supported: true, dirtyCount: 2, dirtyPaths: [], pathGroups: [] })
        .mockResolvedValue({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] });
      mocks.syncToRemote.mockResolvedValue({
        ok: false,
        errorInfo: {
          status: 409,
          code: "not_saved",
          message: "not saved",
          routeUnavailable: false,
          report: { failure: "the push was rejected" },
        },
      });
      await render(desktop());
      expect(q(container, "desktop-changes-line")?.textContent).toContain("2 files changed outside Studio");
      await act(async () => q<HTMLButtonElement>(container, "desktop-save-as-version")?.click());
      await flush();
      expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
      expect(q(container, "desktop-changes-line")).toBeNull();
      expect(q(container, "history-status")?.textContent).toBe(
        "Not saved: the push was rejected. The work is kept under History, in Unsaved work.",
      );
    });

    it("keeps the count current after any other refusal", async () => {
      mocks.fetchStatus
        .mockResolvedValueOnce({ supported: true, dirtyCount: 2, dirtyPaths: [], pathGroups: [] })
        .mockResolvedValue({ supported: true, dirtyCount: 3, dirtyPaths: [], pathGroups: [] });
      mocks.syncToRemote.mockResolvedValue({
        ok: false,
        errorInfo: { status: 409, code: "lease_conflict", message: "leased", routeUnavailable: false },
      });
      await render(desktop());
      await act(async () => q<HTMLButtonElement>(container, "desktop-save-as-version")?.click());
      await flush();
      expect(q(container, "desktop-changes-line")?.textContent).toContain("3 files changed outside Studio");
      expect(q(container, "history-status")?.textContent).toBe("The agent is saving right now. Try again in a moment.");
    });

    it("reports a Desktop not_saved refusal", async () => {
      mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 1, dirtyPaths: [], pathGroups: [] });
      mocks.syncToRemote.mockResolvedValue({
        ok: false,
        errorInfo: {
          status: 409,
          code: "not_saved",
          message: "not saved",
          routeUnavailable: false,
          report: { failure: "the push was rejected" },
        },
      });
      await render(desktop());
      await act(async () => q<HTMLButtonElement>(container, "desktop-save-as-version")?.click());
      await flush();
      expect(q(container, "history-status")?.textContent).toBe(
        "Not saved: the push was rejected. The work is kept under History, in Unsaved work.",
      );
    });

    it("shows a retry row when the folder cannot be checked", async () => {
      mocks.fetchStatus.mockResolvedValueOnce(null);
      await render(desktop());
      expect(q(container, "desktop-changes-error")?.textContent).toContain("Couldn't check the folder on this computer.");
      mocks.fetchStatus.mockResolvedValueOnce({ supported: true, dirtyCount: 1, dirtyPaths: [], pathGroups: [] });
      await act(async () => q<HTMLButtonElement>(container, "desktop-changes-retry")?.click());
      await flush();
      expect(q(container, "desktop-changes-line")?.textContent).toContain("1 file changed outside Studio");
    });
  });
});
