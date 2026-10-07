// @vitest-environment jsdom

/**
 * Keyboard focus in History under real latency: no act(), answers arrive
 * after timers, and React schedules updates as it does in a browser. Every
 * control that unmounts when pressed must leave focus on a fixed target
 * that is still there, with the result in the polite status region.
 */

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
  listAt: vi.fn(),
  saveChanges: vi.fn(),
  openGitReviewTab: vi.fn(),
  openConversationTab: vi.fn(),
  setConversationDraft: vi.fn(),
  createConversation: vi.fn(),
  requestUrlPush: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({ activeProjectId: "project-1", projectCapabilitiesResolved: true, canWriteProject: true }),
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
      files: { readAt: mocks.readAt, listAt: mocks.listAt },
      save: { changes: mocks.saveChanges },
    },
  },
}));

import { resetUnsavedWorkSeenForTests } from "../../../../workspace/unsavedWorkSeen";
import { resetUnsavedWorkStoreForTests } from "../../../../workspace/unsavedWorkStore";
import { HistoryDrawer } from "../HistoryDrawer";

const HEAD = "e".repeat(40);
const NEW_HEAD = "f".repeat(40);
const FIRST = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-1";
const SECOND = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-2";

function later<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function hex(seed: number): string {
  return seed.toString(16).padStart(40, "0");
}

function historyEntry(seed: number) {
  return {
    commit: seed === 0 ? HEAD : hex(seed),
    shortCommit: (seed === 0 ? HEAD : hex(seed)).slice(0, 8),
    committedAt: new Date().toISOString(),
    authorName: "Ada",
    authorEmail: "u@users.noreply.instafy.dev",
    subject: `Update file-${seed}.txt`,
    resolvedBy: null,
  };
}

function page(entries: unknown[], extra: Record<string, unknown> = {}) {
  return { supported: true, entries, hasMore: false, busy: false, error: null, ...extra };
}

function recoveryEntry(ref: string, extra: Record<string, unknown> = {}) {
  return {
    ref,
    rev: "a".repeat(40),
    kind: "unpublished",
    subject: "instafy: kept work",
    date: new Date().toISOString(),
    origin: "11111111-2222-3333-4444-555555555555",
    paths: ["src/a.ts", "src/b.ts"],
    base: "b".repeat(40),
    ...extra,
  };
}

function list(entries: unknown[]) {
  return { status: "ok", entries, originId: "origin-1", originMode: "hosted" };
}

function conflict(paths: string[]) {
  return {
    ok: false,
    stage: "response",
    error: { status: 409, code: "restore_conflict", message: "conflict", routeUnavailable: false, head: NEW_HEAD, paths },
    originId: "origin-1",
    originMode: "hosted",
  };
}

function restored(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    rev: NEW_HEAD,
    baseRev: HEAD,
    committed: true,
    notRestored: [],
    refDeleted: true,
    originId: "origin-1",
    originMode: "hosted",
    ...extra,
  };
}

function versioning(overrides: Partial<ActiveWorkspaceVersioning> = {}): ActiveWorkspaceVersioning {
  return {
    mode: "stateless",
    resolved: true,
    firstPaintMode: "stateless",
    originId: "origin-1",
    originMode: "hosted",
    stateless: true,
    recovery: "supported",
    checkedAt: Date.now(),
    refresh: mocks.probe,
    projectId: "project-1",
    chromeMode: "stateless",
    historyReady: true,
    ...overrides,
  };
}

const desktop = () =>
  versioning({ mode: "desktop", chromeMode: "desktop", firstPaintMode: "desktop", originMode: "desktop", stateless: false });

function q<T extends Element = HTMLElement>(scope: ParentNode | null | undefined, testId: string): T | null {
  return scope?.querySelector<T>(`[data-testid="${testId}"]`) ?? null;
}

/** Poll like a person waiting: real timers, no act(). */
async function until(check: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("HistoryDrawer: keyboard focus under latency", () => {
  let container: HTMLDivElement;
  let root: Root;

  const status = () => q(container, "history-status")?.textContent ?? "";
  const heading = () =>
    Array.from(container.querySelectorAll("h3")).find((element) => element.textContent === "Saved versions") ?? null;
  const row = (ref: string) =>
    container.querySelector<HTMLElement>(`[data-testid="unsaved-work-entry"][data-ref="${ref}"]`);
  const pathItems = (ref: string) =>
    Array.from(row(ref)?.querySelectorAll<HTMLElement>('[data-testid="unsaved-work-path"]') ?? []);

  /** Focus the control, then press it as the keyboard does (Enter fires click). */
  async function pressFocused(element: HTMLElement | null, label: string) {
    expect(element, label).not.toBeNull();
    element!.focus();
    expect(document.activeElement, label).toBe(element);
    element!.click();
  }

  async function open(state: ActiveWorkspaceVersioning = versioning()) {
    root.render(<HistoryDrawer versioning={state} onRequestClose={vi.fn()} />);
    await until(() => heading() !== null, "the drawer");
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchHistory.mockImplementation(() => later(page([historyEntry(0)]), 5));
    mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] });
    mocks.fetchRecovery.mockResolvedValue({ status: "unsupported", entries: [], originId: "origin-1", originMode: "hosted" });
    mocks.probe.mockResolvedValue(null);
    resetUnsavedWorkStoreForTests();
    resetUnsavedWorkSeenForTests();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  describe("Desktop line", () => {
    it("Save as version lands on Saved versions when the line empties, whichever check answers last", async () => {
      // The drawer's own re-check and the save's check race: 20 ms and 80 ms.
      const delays = [20, 80, 20];
      mocks.fetchStatus
        .mockResolvedValueOnce({ supported: true, dirtyCount: 2, dirtyPaths: [], pathGroups: [] })
        .mockImplementation(() =>
          later({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] }, delays.shift() ?? 20),
        );
      mocks.syncToRemote.mockImplementation(() => later({ ok: true, rev: hex(77), committed: true, report: null }, 20));
      await open(desktop());
      await until(() => q(container, "desktop-changes-line") !== null, "the line");

      await pressFocused(q(container, "desktop-save-as-version"), "Save as version");
      await until(() => q(container, "desktop-changes-line") === null, "the line to hide");
      await settle();
      expect(document.activeElement).toBe(heading());
      expect(status()).toBe("Saved 2 files as a version.");
    });

    it("Retry lands on Save as version, which names the count", async () => {
      mocks.fetchStatus
        .mockResolvedValueOnce(null)
        .mockImplementation(() => later({ supported: true, dirtyCount: 2, dirtyPaths: [], pathGroups: [] }, 20));
      await open(desktop());
      await until(() => q(container, "desktop-changes-retry") !== null, "the error row");

      await pressFocused(q(container, "desktop-changes-retry"), "Retry");
      await until(() => q(container, "desktop-changes-line") !== null, "the line");
      await settle();
      const save = q(container, "desktop-save-as-version");
      expect(document.activeElement).toBe(save);
      const describedBy = save?.getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(describedBy)?.textContent).toBe("2 files changed outside Studio");
    });

    it("Retry lands on Saved versions and says so when the folder is clean", async () => {
      mocks.fetchStatus
        .mockResolvedValueOnce(null)
        .mockImplementation(() => later({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] }, 20));
      await open(desktop());
      await until(() => q(container, "desktop-changes-retry") !== null, "the error row");

      await pressFocused(q(container, "desktop-changes-retry"), "Retry");
      await until(() => q(container, "desktop-changes-error") === null, "the error row to go");
      await settle();
      expect(document.activeElement).toBe(heading());
      expect(status()).toBe("No files changed outside Studio.");
    });
  });

  describe("Unsaved work", () => {
    beforeEach(() => {
      mocks.fetchRecovery.mockImplementation(() => later(list([recoveryEntry(FIRST), recoveryEntry(SECOND)]), 10));
    });

    async function openWithRows() {
      await open();
      await until(() => row(FIRST) !== null && row(SECOND) !== null, "both rows");
    }

    it("Restore that conflicts lands on the first file and says why", async () => {
      mocks.restoreRecovery.mockImplementation(() => later(conflict(["src/a.ts", "src/b.ts"]), 20));
      await openWithRows();
      await pressFocused(q(row(FIRST), "unsaved-work-restore"), "Restore");
      await until(() => pathItems(FIRST).length === 2, "the per-file choices");
      await settle();
      expect(document.activeElement).toBe(q(pathItems(FIRST)[0], "unsaved-work-path-use"));
      expect(status()).toBe("Not restored yet: 2 files changed since this work was kept.");
    });

    it("Keep current lands on the next file, then Restore the rest, then the next row", async () => {
      mocks.restoreRecovery
        .mockImplementationOnce(() => later(conflict(["src/a.ts", "src/b.ts"]), 20))
        .mockImplementationOnce(() => later(restored({ committed: false, notRestored: ["src/a.ts", "src/b.ts"] }), 30));
      await openWithRows();
      await pressFocused(q(row(FIRST), "unsaved-work-restore"), "Restore");
      await until(() => pathItems(FIRST).length === 2, "the per-file choices");
      await settle(30);

      await pressFocused(q(pathItems(FIRST)[0], "unsaved-work-path-keep"), "Keep current");
      await until(() => q(pathItems(FIRST)[0], "unsaved-work-path-resolved") !== null, "the first choice");
      await settle();
      expect(document.activeElement).toBe(q(pathItems(FIRST)[1], "unsaved-work-path-use"));
      expect(status()).toBe("Kept the current version of src/a.ts.");

      await pressFocused(q(pathItems(FIRST)[1], "unsaved-work-path-keep"), "Keep current");
      await until(() => q(row(FIRST), "unsaved-work-restore-rest") !== null, "Restore the rest");
      await settle();
      expect(document.activeElement).toBe(q(row(FIRST), "unsaved-work-restore-rest"));
      expect(status()).toBe("Kept the current version of src/b.ts.");

      mocks.fetchRecovery.mockImplementation(() => later(list([recoveryEntry(SECOND)]), 40));
      await pressFocused(q(row(FIRST), "unsaved-work-restore-rest"), "Restore the rest");
      await until(() => row(FIRST) === null, "the row to go");
      await settle();
      expect(document.activeElement).toBe(q(row(SECOND), "unsaved-work-review"));
      // The entry held only these two files: there is no rest to speak of.
      expect(status()).toBe("Kept the current version of src/a.ts and src/b.ts.");
    });

    it("Cancel on the per-file choices lands on the row's Restore", async () => {
      mocks.restoreRecovery.mockImplementation(() => later(conflict(["src/a.ts", "src/b.ts"]), 20));
      await openWithRows();
      await pressFocused(q(row(FIRST), "unsaved-work-restore"), "Restore");
      await until(() => pathItems(FIRST).length === 2, "the per-file choices");
      await settle(30);

      await pressFocused(q(row(FIRST), "unsaved-work-conflict-cancel"), "Cancel");
      await until(() => q(row(FIRST), "unsaved-work-conflict") === null, "the choices to close");
      await settle();
      expect(document.activeElement).toBe(q(row(FIRST), "unsaved-work-restore"));
      expect(status()).toBe("Restore cancelled. Nothing was changed.");
    });

    it("Use this version lands on the next file once the save answers", async () => {
      mocks.restoreRecovery.mockImplementation(() => later(conflict(["src/a.ts", "src/b.ts"]), 20));
      mocks.readAt.mockImplementation(() =>
        later({ ok: true, file: { path: "src/a.ts", contentBase64: btoa("kept\n"), size: 5 } }, 20),
      );
      mocks.saveChanges.mockImplementation(() =>
        later({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/a.ts"] }, 30),
      );
      await openWithRows();
      await pressFocused(q(row(FIRST), "unsaved-work-restore"), "Restore");
      await until(() => pathItems(FIRST).length === 2, "the per-file choices");
      await settle(30);

      await pressFocused(q(pathItems(FIRST)[0], "unsaved-work-path-use"), "Use this version");
      await until(() => q(pathItems(FIRST)[0], "unsaved-work-path-resolved") !== null, "the saved file");
      await settle();
      expect(document.activeElement).toBe(q(pathItems(FIRST)[1], "unsaved-work-path-use"));
      expect(status()).toBe("Saved this version of src/a.ts.");
    });

    it("Remove lands on the next row, and on Saved versions after the last one", async () => {
      mocks.dismissRecovery.mockImplementation(() =>
        later({ ok: true, dismissed: true, missing: false, originId: "origin-1", originMode: "hosted" }, 20),
      );
      await openWithRows();
      mocks.fetchRecovery.mockImplementation(() => later(list([recoveryEntry(SECOND)]), 40));
      await pressFocused(q(row(FIRST), "unsaved-work-remove"), "Remove");
      await until(() => q(document.body, "unsaved-work-remove-dialog-confirm") !== null, "the dialog");
      q<HTMLButtonElement>(document.body, "unsaved-work-remove-dialog-confirm")!.click();
      await until(() => row(FIRST) === null, "the row to go");
      await settle();
      expect(document.activeElement).toBe(q(row(SECOND), "unsaved-work-review"));
      expect(status()).toBe("Removed.");

      mocks.fetchRecovery.mockImplementation(() => later(list([]), 40));
      await pressFocused(q(row(SECOND), "unsaved-work-remove"), "Remove");
      await until(() => q(document.body, "unsaved-work-remove-dialog-confirm") !== null, "the dialog");
      q<HTMLButtonElement>(document.body, "unsaved-work-remove-dialog-confirm")!.click();
      await until(() => q(container, "unsaved-work-section") === null, "the section to go");
      await settle();
      expect(document.activeElement).toBe(heading());
      expect(status()).toBe("Removed.");
    });

    it("Restore that removes the row lands on the next row", async () => {
      mocks.restoreRecovery.mockImplementation(() => later(restored(), 20));
      await openWithRows();
      mocks.fetchRecovery.mockImplementation(() => later(list([recoveryEntry(SECOND)]), 40));
      await pressFocused(q(row(FIRST), "unsaved-work-restore"), "Restore");
      await until(() => row(FIRST) === null, "the row to go");
      await settle();
      expect(document.activeElement).toBe(q(row(SECOND), "unsaved-work-review"));
      expect(status()).toBe("Restored as a new version.");
    });

    it("Retry on the list error lands on the first row", async () => {
      mocks.fetchRecovery
        .mockImplementationOnce(() =>
          later(
            {
              status: "error",
              entries: [],
              error: { status: 502, code: "canonical_unreachable", message: "down", routeUnavailable: false },
              originId: "origin-1",
              originMode: "hosted",
            },
            5,
          ),
        )
        .mockImplementation(() => later(list([recoveryEntry(FIRST)]), 30));
      await open();
      await until(() => q(container, "unsaved-work-retry") !== null, "the error row");
      await pressFocused(q(container, "unsaved-work-retry"), "Retry");
      await until(() => row(FIRST) !== null, "the row");
      await settle();
      expect(document.activeElement).toBe(q(row(FIRST), "unsaved-work-review"));
    });

    it("Retry on the list error lands on Saved versions and says so when nothing is kept", async () => {
      mocks.fetchRecovery
        .mockImplementationOnce(() =>
          later(
            {
              status: "error",
              entries: [],
              error: { status: 502, code: "canonical_unreachable", message: "down", routeUnavailable: false },
              originId: "origin-1",
              originMode: "hosted",
            },
            5,
          ),
        )
        .mockImplementation(() => later(list([]), 30));
      await open();
      await until(() => q(container, "unsaved-work-retry") !== null, "the error row");
      await pressFocused(q(container, "unsaved-work-retry"), "Retry");
      await until(() => q(container, "unsaved-work-error") === null, "the error row to go");
      await settle();
      expect(document.activeElement).toBe(heading());
      expect(status()).toBe("No unsaved work.");
    });
  });

  describe("mode probe", () => {
    it("Retry lands on the drawer's title while the list gets ready, then on Saved versions", async () => {
      mocks.probe.mockImplementation(() => later({ mode: "stateless" }, 20));
      const onRequestClose = vi.fn();
      root.render(
        <HistoryDrawer
          versioning={versioning({ resolved: false, historyReady: false })}
          onRequestClose={onRequestClose}
          probeFailed
        />,
      );
      await until(() => q(container, "history-probe-retry") !== null, "Retry");

      await pressFocused(q(container, "history-probe-retry"), "Retry");
      await until(() => q(container, "history-probe-retry") === null, "Retry to go");
      await settle(30);
      const title = container.querySelector("h2");
      expect(title?.textContent).toBe("History");
      expect(document.activeElement).toBe(title);
      expect(status()).toBe("Loading saved versions…");

      root.render(<HistoryDrawer versioning={versioning()} onRequestClose={onRequestClose} probeFailed />);
      await until(() => heading() !== null, "Saved versions");
      await settle();
      expect(document.activeElement).toBe(heading());
      expect(status()).toBe("");
    });
  });

  describe("Show more", () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => historyEntry(index + 1));

    it("lands on the first new row and says how many loaded", async () => {
      mocks.fetchHistory
        .mockImplementationOnce(() => later(page(firstPage, { hasMore: true }), 5))
        .mockImplementationOnce(() => later(page([historyEntry(21), historyEntry(22)], { hasMore: false }), 30));
      await open();
      await until(() => q(container, "history-show-more") !== null, "Show more");
      await pressFocused(q(container, "history-show-more"), "Show more");
      await until(() => q(container, "history-show-more") === null, "Show more to go");
      await settle();
      expect(document.activeElement?.textContent).toContain("Update file-21.txt");
      expect(status()).toBe("Loaded 2 more saved versions.");
    });

    it("lands on Saved versions and says so when nothing older came", async () => {
      mocks.fetchHistory
        .mockImplementationOnce(() => later(page(firstPage, { hasMore: true }), 5))
        .mockImplementationOnce(() => later(page(firstPage, { hasMore: true }), 30));
      await open();
      await until(() => q(container, "history-show-more") !== null, "Show more");
      await pressFocused(q(container, "history-show-more"), "Show more");
      await until(() => q(container, "history-show-more") === null, "Show more to go");
      await settle();
      expect(document.activeElement).toBe(heading());
      expect(status()).toBe("No more saved versions.");
    });
  });
});
