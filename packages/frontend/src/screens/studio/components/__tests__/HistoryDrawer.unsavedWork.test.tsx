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
  listAt: vi.fn(),
  saveChanges: vi.fn(),
  openGitReviewTab: vi.fn(),
  openConversationTab: vi.fn(),
  setConversationDraft: vi.fn(),
  createConversation: vi.fn(),
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
      files: { readAt: mocks.readAt, listAt: mocks.listAt },
      save: { changes: mocks.saveChanges },
    },
  },
}));

import { readUnsavedWorkSeen, unsavedWorkSeenKey } from "../../../../workspace/unsavedWorkSeen";
import {
  getUnsavedWorkSnapshot,
  pendingUnsavedWorkEntries,
  resetUnsavedWorkStoreForTests,
} from "../../../../workspace/unsavedWorkStore";
import { HistoryDrawer } from "../HistoryDrawer";

const HEAD = "e".repeat(40);
const NEW_HEAD = "f".repeat(40);
const RECOVERY = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-1";
const CONFLICT = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-2";
/** Unsaved edits a restore keeps: part of them can never be saved here. */
const KEPT = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-3";

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

function historyPage() {
  return {
    supported: true,
    entries: [
      {
        commit: HEAD,
        shortCommit: HEAD.slice(0, 8),
        committedAt: new Date().toISOString(),
        authorName: "Ada",
        authorEmail: "u@users.noreply.instafy.dev",
        subject: "Update src/a.ts",
        resolvedBy: null,
      },
    ],
    hasMore: false,
    busy: false,
    error: null,
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

function originError(status: number, code: string | undefined, extra: Record<string, unknown> = {}) {
  return { status, code, message: code ?? "error", routeUnavailable: false, ...extra };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
}

function q<T extends Element = HTMLElement>(scope: ParentNode, testId: string): T | null {
  return scope.querySelector<T>(`[data-testid="${testId}"]`);
}

function row(container: HTMLElement, ref: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="unsaved-work-entry"][data-ref="${ref}"]`);
  if (!element) {
    throw new Error(`no row for ${ref}`);
  }
  return element;
}

describe("HistoryDrawer: Unsaved work", () => {
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
    mocks.fetchHistory.mockResolvedValue(historyPage());
    mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] });
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY)]));
    mocks.probe.mockResolvedValue(null);
    resetUnsavedWorkStoreForTests();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(state: ActiveWorkspaceVersioning = versioning()) {
    await act(async () => root.render(<HistoryDrawer versioning={state} onRequestClose={vi.fn()} />));
    await flush();
  }

  async function press(scope: ParentNode, testId: string) {
    await act(async () => q<HTMLButtonElement>(scope, testId)?.click());
    await flush();
  }

  it("is hidden when the server has no recovery route", async () => {
    mocks.fetchRecovery.mockResolvedValue({ status: "unsupported", entries: [], originId: "origin-1", originMode: "desktop" });
    await render();
    expect(mocks.fetchRecovery).toHaveBeenCalledWith({ projectId: "project-1", originId: "origin-1" });
    expect(q(container, "unsaved-work-section")).toBeNull();
    expect(q(container, "unsaved-work-error")).toBeNull();
  });

  it("counts the entries it shows as seen by this viewer", async () => {
    const recovery = recoveryEntry(RECOVERY);
    const kept = recoveryEntry(KEPT, { kind: "unsaved" });
    mocks.fetchRecovery.mockResolvedValue(list([recovery, kept]));
    expect(readUnsavedWorkSeen("project-1", "user-1").size).toBe(0);
    await render();
    const seen = readUnsavedWorkSeen("project-1", "user-1");
    expect(seen.size).toBe(2);
    expect(seen.has(unsavedWorkSeenKey(recovery))).toBe(true);
    expect(seen.has(unsavedWorkSeenKey(kept))).toBe(true);
  });

  it("is hidden while empty", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([]));
    await render();
    expect(q(container, "unsaved-work-section")).toBeNull();
  });

  it("loads again with the header's Refresh", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([]));
    await render();
    expect(q(container, "unsaved-work-section")).toBeNull();
    const before = mocks.fetchRecovery.mock.calls.length;
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY)]));
    await press(container, "source-control-refresh");
    expect(mocks.fetchRecovery.mock.calls.length).toBe(before + 1);
    expect(row(container, RECOVERY)).not.toBeNull();
  });

  it("shows an error row with Retry when the list fails", async () => {
    mocks.fetchRecovery.mockResolvedValueOnce({
      status: "error",
      entries: [],
      error: originError(502, "canonical_unreachable"),
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    expect(q(container, "unsaved-work-error")?.textContent).toContain("Couldn't check for unsaved work.");
    await press(container, "unsaved-work-retry");
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
    expect(q(container, "unsaved-work-section")).not.toBeNull();
  });

  it("titles rows by kind, offers Remove on every row and marks a restored entry", async () => {
    mocks.fetchRecovery.mockResolvedValue(
      list([
        recoveryEntry(RECOVERY),
        recoveryEntry(CONFLICT, { kind: "conflict", paths: ["src/a.ts"] }),
        recoveryEntry(KEPT, { kind: "unsaved", restoredRev: NEW_HEAD }),
      ]),
    );
    await render();
    const entries = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="unsaved-work-entry"]'));
    expect(entries.map((entry) => entry.getAttribute("data-kind"))).toEqual(["unpublished", "conflict", "unsaved"]);
    expect(entries[0]?.textContent).toContain("Agent work that couldn't be saved");
    expect(entries[0]?.textContent).toContain("2 files");
    expect(entries[1]?.textContent).toContain("Agent work that conflicted with newer changes");
    expect(entries[1]?.textContent).toContain("1 file");
    expect(entries[2]?.textContent).toContain("Unsaved edits from a stopped workspace");
    expect(q(entries[2]!, "unsaved-work-restored")?.textContent).toBe("Restored");
    for (const entry of entries) {
      expect(q(entry, "unsaved-work-remove")).not.toBeNull();
    }
  });

  it("opens a read-only review of the kept work", async () => {
    await render();
    await press(row(container, RECOVERY), "unsaved-work-review");
    expect(mocks.openGitReviewTab).toHaveBeenCalledWith({
      kind: "unsavedWork",
      ref: RECOVERY,
      rev: "a".repeat(40),
      base: "b".repeat(40),
      title: "Agent work that couldn't be saved",
      date: expect.any(String),
      entries: [
        { path: "src/a.ts", code: "" },
        { path: "src/b.ts", code: "" },
      ],
      originId: "origin-1",
      initialMode: "all",
    });
  });

  it("restores on top of the newest saved version and drops the entry", async () => {
    mocks.restoreRecovery.mockResolvedValue({
      ok: true,
      rev: NEW_HEAD,
      baseRev: HEAD,
      committed: true,
      notRestored: [".env"],
      refDeleted: true,
      originId: "origin-1",
      originMode: "hosted",
    });
    mocks.fetchRecovery.mockResolvedValueOnce(list([recoveryEntry(RECOVERY)])).mockResolvedValue(list([]));
    await render();
    await press(row(container, RECOVERY), "unsaved-work-restore");
    expect(mocks.restoreRecovery).toHaveBeenCalledWith({
      projectId: "project-1",
      originId: "origin-1",
      ref: RECOVERY,
      rev: "a".repeat(40),
      baseRev: HEAD,
      keep: null,
      leaseConflictRetryDelayMs: 1500,
    });
    expect(q(container, "history-status")?.textContent).toBe(
      "Restored as a new version. Not restored: .env. Secret and ignored files stay out of the space.",
    );
    expect(container.querySelector('[data-testid="unsaved-work-entry"]')).toBeNull();
  });

  it("keeps a restored entry whose ref stays with a Restored badge", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(KEPT, { kind: "unsaved" })]));
    mocks.restoreRecovery.mockResolvedValue({
      ok: true,
      rev: NEW_HEAD,
      baseRev: HEAD,
      committed: true,
      notRestored: [],
      refDeleted: false,
      originId: "origin-1",
      originMode: "hosted",
    });
    // The server does not mark it (no restoredRev yet): the local mark stays until the next list.
    mocks.fetchRecovery.mockResolvedValueOnce(list([recoveryEntry(KEPT, { kind: "unsaved" })]));
    await render();
    mocks.fetchRecovery.mockReturnValue(new Promise(() => undefined));
    await press(row(container, KEPT), "unsaved-work-restore");
    expect(q(container, "history-status")?.textContent).toBe("Restored as a new version.");
    expect(q(row(container, KEPT), "unsaved-work-restored")).not.toBeNull();
  });

  it("leaves an entry pending, with no Restored badge, when a restore that keeps its ref made no version", async () => {
    // main gained TODO.md since; the work only adds todo.md, which the person keeps.
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(KEPT, { kind: "unsaved", paths: ["todo.md"] })]));
    mocks.restoreRecovery
      .mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["todo.md"] }),
        originId: "origin-1",
        originMode: "hosted",
      })
      .mockResolvedValueOnce({
        ok: true,
        rev: NEW_HEAD,
        baseRev: NEW_HEAD,
        committed: false,
        notRestored: ["todo.md"],
        notRestoredReasons: { "todo.md": "kept" },
        refDeleted: false,
        originId: "origin-1",
        originMode: "hosted",
      });
    await render();
    await press(row(container, KEPT), "unsaved-work-restore");
    await press(row(container, KEPT), "unsaved-work-path-keep");
    // Hold the forced reload: only the local patch decides the badge here.
    mocks.fetchRecovery.mockReturnValue(new Promise(() => undefined));
    await press(row(container, KEPT), "unsaved-work-restore-rest");
    expect(mocks.restoreRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ ref: KEPT, keep: ["todo.md"] }));
    expect(q(container, "history-status")?.textContent).toBe("Kept the current version of todo.md.");
    // No restore commit was made, so the server will not mark it either.
    expect(q(row(container, KEPT), "unsaved-work-restored")).toBeNull();
    expect(q(row(container, KEPT), "unsaved-work-restore")).not.toBeNull();
  });

  it("keeps an entry pending, with no Restored badge, when a restore leaves a name main holds in another case", async () => {
    // main gained TODO.md since; the work adds todo.md and other.md. "Use this version" cannot
    // save todo.md beside TODO.md, so the person keeps the current version and restores the rest.
    mocks.fetchRecovery.mockResolvedValue(
      list([recoveryEntry(KEPT, { kind: "unsaved", paths: ["other.md", "todo.md"] })]),
    );
    mocks.restoreRecovery
      .mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["todo.md"] }),
        originId: "origin-1",
        originMode: "hosted",
      })
      .mockResolvedValueOnce({
        ok: true,
        rev: NEW_HEAD,
        baseRev: NEW_HEAD,
        committed: true,
        notRestored: ["todo.md"],
        notRestoredReasons: { "todo.md": "path_alias" },
        refDeleted: false,
        originId: "origin-1",
        originMode: "hosted",
      });
    await render();
    await press(row(container, KEPT), "unsaved-work-restore");
    await press(row(container, KEPT), "unsaved-work-path-keep");
    // Hold the forced reload: only the local patch decides the badge here.
    mocks.fetchRecovery.mockReturnValue(new Promise(() => undefined));
    await press(row(container, KEPT), "unsaved-work-restore-rest");
    expect(mocks.restoreRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ ref: KEPT, keep: ["todo.md"] }));
    expect(q(container, "history-status")?.textContent).toBe(
      "Restored as a new version. todo.md stays in Unsaved work, because the space has another file with that name in a different case.",
    );
    // The work's todo.md is only on the ref: the entry still counts as unsaved work.
    expect(q(row(container, KEPT), "unsaved-work-restored")).toBeNull();
    expect(q(row(container, KEPT), "unsaved-work-restore")).not.toBeNull();
    expect(
      pendingUnsavedWorkEntries(getUnsavedWorkSnapshot("project-1", "origin-1").entries).map((entry) => entry.ref),
    ).toEqual([KEPT]);
  });

  it("does not claim a new version when restoring an already restored entry", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(KEPT, { kind: "unsaved", restoredRev: NEW_HEAD })]));
    mocks.restoreRecovery.mockResolvedValue({
      ok: true,
      rev: NEW_HEAD,
      baseRev: NEW_HEAD,
      committed: false,
      notRestored: [],
      refDeleted: false,
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    const commits: unknown[] = [];
    const onCommit = (event: Event) => commits.push((event as CustomEvent).detail);
    window.addEventListener("instafy:workspace-commit", onCommit);
    try {
      await press(row(container, KEPT), "unsaved-work-restore");
    } finally {
      window.removeEventListener("instafy:workspace-commit", onCommit);
    }
    expect(q(container, "history-status")?.textContent).toBe(
      "Nothing to restore. The saved version already has this work.",
    );
    // main did not move, so nothing announces a new version.
    expect(commits).toEqual([]);
  });

  it("names old chat uploads apart from secret files", async () => {
    mocks.fetchRecovery.mockResolvedValue(
      list([
        recoveryEntry(KEPT, {
          kind: "unsaved",
          paths: ["src/a.ts", ".env", "chat-upload-1.png"],
        }),
      ]),
    );
    mocks.restoreRecovery.mockResolvedValue({
      ok: true,
      rev: NEW_HEAD,
      baseRev: HEAD,
      committed: true,
      notRestored: [".env", "chat-upload-1.png"],
      notRestoredReasons: { ".env": "secret", "chat-upload-1.png": "attachment" },
      refDeleted: false,
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    await press(row(container, KEPT), "unsaved-work-restore");
    expect(q(container, "history-status")?.textContent).toBe(
      "Restored as a new version. Not restored: .env and chat-upload-1.png. Secret and ignored files stay out of the space. Old chat upload files aren't saved to the space.",
    );
  });

  it("asks per file after a restore conflict and restores the rest with a keep list", async () => {
    mocks.restoreRecovery
      .mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["src/a.ts", "src/b.ts", "src/gone.ts"] }),
        originId: "origin-1",
        originMode: "hosted",
      })
      .mockResolvedValueOnce({
        ok: true,
        rev: "c".repeat(40),
        baseRev: "d".repeat(40),
        committed: true,
        notRestored: ["src/b.ts"],
        refDeleted: true,
        originId: "origin-1",
        originMode: "hosted",
      });
    mocks.readAt
      .mockResolvedValueOnce({ ok: true, file: { path: "src/a.ts", contentBase64: btoa("kept\n"), size: 5 } })
      .mockResolvedValueOnce({ ok: false, notFound: true, error: originError(404, "not_found"), originId: "origin-1", originMode: "hosted" });
    // The ref still resolves at the listed rev, and its src/ has no gone.ts: a real delete.
    mocks.listAt.mockResolvedValue({
      ok: true,
      entries: [{ name: "a.ts", path: "src/a.ts", kind: "file" }],
      rev: "a".repeat(40),
      originId: "origin-1",
      originMode: "hosted",
    });
    mocks.saveChanges
      .mockResolvedValueOnce({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/a.ts"] })
      .mockResolvedValueOnce({ ok: true, rev: "d".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/gone.ts"] });

    await render();
    await press(row(container, RECOVERY), "unsaved-work-restore");
    const conflict = q(row(container, RECOVERY), "unsaved-work-conflict");
    expect(conflict?.textContent).toContain("These files changed since this work was kept. Choose a version for each:");
    const paths = Array.from(conflict!.querySelectorAll<HTMLElement>('[data-testid="unsaved-work-path"]'));
    expect(paths.map((item) => item.getAttribute("data-path"))).toEqual(["src/a.ts", "src/b.ts", "src/gone.ts"]);
    const useA = q<HTMLButtonElement>(paths[0]!, "unsaved-work-path-use");
    const describedBy = useA?.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe("src/a.ts");

    // Use this version: read at the ref (into memory) and save on top of the reported head.
    await press(paths[0]!, "unsaved-work-path-use");
    expect(mocks.readAt).toHaveBeenCalledWith({
      projectId: "project-1",
      originId: "origin-1",
      path: "src/a.ts",
      ref: RECOVERY,
      routing: "default",
    });
    const firstSave = mocks.saveChanges.mock.calls[0]?.[0];
    expect(firstSave).toMatchObject({
      projectId: "project-1",
      originId: "origin-1",
      deletes: [],
      baseRev: NEW_HEAD,
      leaseConflictRetryDelayMs: 1500,
    });
    expect(new TextDecoder().decode(firstSave.files[0].bytes)).toBe("kept\n");
    expect(firstSave).not.toHaveProperty("idempotencyKey");

    // Keep current writes nothing.
    await press(paths[1]!, "unsaved-work-path-keep");
    expect(mocks.saveChanges).toHaveBeenCalledTimes(1);

    // The ref deletes this one: it becomes a delete on top of the previous save.
    await press(paths[2]!, "unsaved-work-path-use");
    expect(mocks.listAt).toHaveBeenCalledWith({
      projectId: "project-1",
      originId: "origin-1",
      path: "src",
      ref: RECOVERY,
      routing: "default",
    });
    expect(mocks.saveChanges.mock.calls[1]?.[0]).toMatchObject({ files: [], deletes: ["src/gone.ts"], baseRev: "1".repeat(40) });

    expect(row(container, RECOVERY).querySelectorAll('[data-testid="unsaved-work-path-resolved"]')).toHaveLength(3);
    await press(row(container, RECOVERY), "unsaved-work-restore-rest");
    expect(mocks.restoreRecovery).toHaveBeenLastCalledWith(
      expect.objectContaining({ ref: RECOVERY, keep: ["src/b.ts"], baseRev: "d".repeat(40) }),
    );
    // The path the person kept is named as kept, not as a refused secret.
    expect(q(container, "history-status")?.textContent).toBe(
      "Restored as a new version. Kept the current version of src/b.ts.",
    );
  });

  it("names only the kept files when the entry held nothing else", async () => {
    mocks.restoreRecovery
      .mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["src/a.ts", "src/b.ts"] }),
        originId: "origin-1",
        originMode: "hosted",
      })
      .mockResolvedValueOnce({
        ok: true,
        rev: NEW_HEAD,
        baseRev: NEW_HEAD,
        committed: false,
        notRestored: ["src/a.ts", "src/b.ts"],
        refDeleted: true,
        originId: "origin-1",
        originMode: "hosted",
      });
    await render();
    await press(row(container, RECOVERY), "unsaved-work-restore");
    const paths = Array.from(row(container, RECOVERY).querySelectorAll<HTMLElement>('[data-testid="unsaved-work-path"]'));
    await press(paths[0]!, "unsaved-work-path-keep");
    await press(paths[1]!, "unsaved-work-path-keep");
    await press(row(container, RECOVERY), "unsaved-work-restore-rest");
    expect(mocks.restoreRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ keep: ["src/a.ts", "src/b.ts"] }));
    const status = q(container, "history-status")?.textContent ?? "";
    // The entry held only these two files: there is no rest to speak of.
    expect(status).toBe("Kept the current version of src/a.ts and src/b.ts.");
    expect(status).not.toContain("Secret and ignored");
    expect(status).not.toContain("Restored as a new version");
  });

  it("says the saved version has the rest when the entry held more than the kept files", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY, { paths: ["src/a.ts", "src/b.ts", "src/c.ts"] })]));
    mocks.restoreRecovery
      .mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["src/a.ts"] }),
        originId: "origin-1",
        originMode: "hosted",
      })
      .mockResolvedValueOnce({
        ok: true,
        rev: NEW_HEAD,
        baseRev: NEW_HEAD,
        committed: false,
        notRestored: ["src/a.ts"],
        refDeleted: true,
        originId: "origin-1",
        originMode: "hosted",
      });
    await render();
    await press(row(container, RECOVERY), "unsaved-work-restore");
    await press(row(container, RECOVERY), "unsaved-work-path-keep");
    await press(row(container, RECOVERY), "unsaved-work-restore-rest");
    expect(q(container, "history-status")?.textContent).toBe(
      "Kept the current version of src/a.ts. The saved version already has the rest of this work.",
    );
  });

  it("claims no rest for a conflict entry, whose list names only its conflicted files", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(CONFLICT, { kind: "conflict", paths: [".env"] })]));
    mocks.restoreRecovery.mockResolvedValue({
      ok: true,
      rev: HEAD,
      baseRev: HEAD,
      committed: false,
      notRestored: [".env"],
      refDeleted: true,
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    await press(row(container, CONFLICT), "unsaved-work-restore");
    expect(q(container, "history-status")?.textContent).toBe(
      "Not restored: .env. Secret and ignored files stay out of the space. Nothing else to restore.",
    );
  });

  it("never says the space has work it refused when nothing was restored", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY, { paths: [".env"] })]));
    mocks.restoreRecovery.mockResolvedValue({
      ok: true,
      rev: HEAD,
      baseRev: HEAD,
      committed: false,
      notRestored: [".env"],
      refDeleted: true,
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    await press(row(container, RECOVERY), "unsaved-work-restore");
    const status = q(container, "history-status")?.textContent ?? "";
    // .env was all the entry held: nothing else is claimed.
    expect(status).toBe("Not restored: .env. Secret and ignored files stay out of the space.");
    expect(status).not.toContain("already has");
    expect(status).not.toContain("Nothing to restore");
  });

  describe("a 404 at the ref", () => {
    function conflictOn(paths: string[]) {
      mocks.restoreRecovery.mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths }),
        originId: "origin-1",
        originMode: "hosted",
      });
    }

    function listing(entries: unknown[], rev: string | null = "a".repeat(40)) {
      return { ok: true, entries, rev, originId: "origin-1", originMode: "hosted" };
    }

    it("is not a delete when the ref itself is gone", async () => {
      conflictOn(["src/a.ts"]);
      mocks.readAt.mockResolvedValue({
        ok: false,
        notFound: true,
        error: originError(404, "not_found", { message: "that ref does not exist" }),
        originId: "origin-1",
        originMode: "hosted",
      });
      // Every listing at a missing ref is empty too.
      mocks.listAt.mockResolvedValue(listing([], null));
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      const listsBefore = mocks.fetchRecovery.mock.calls.length;
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.listAt).toHaveBeenCalledWith(expect.objectContaining({ path: "", ref: RECOVERY }));
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe(
        "Couldn't read this file from the unsaved work, so nothing was saved. Refreshing.",
      );
      expect(mocks.fetchRecovery.mock.calls.length).toBe(listsBefore + 1);
    });

    // The gateway's 503 answers to the read at the ref: nothing is saved.
    it.each([
      ["fetch_pending", "The space is still loading. Try again in a moment."],
      ["mirror_reset", "The server is rebuilding its copy of this space. Try again in a moment."],
      ["disk_full", "The space is out of room right now. Try again later."],
    ])("is not a delete when the read answers %s, and says so", async (code, copy) => {
      conflictOn(["src/a.ts"]);
      mocks.readAt.mockResolvedValue({
        ok: false,
        notFound: false,
        error: originError(503, code, { retryAfterMs: 2000 }),
        originId: "origin-1",
        originMode: "hosted",
      });
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.listAt).not.toHaveBeenCalled();
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe(copy);
    });

    it("is not a delete when the read route is missing", async () => {
      conflictOn(["src/a.ts"]);
      mocks.readAt.mockResolvedValue({
        ok: false,
        notFound: true,
        error: originError(404, undefined, { message: "origin path not found", routeUnavailable: true }),
        originId: "origin-1",
        originMode: "hosted",
      });
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.listAt).not.toHaveBeenCalled();
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toContain("Couldn't read this file from the unsaved work.");
    });

    // Listings hide symlinks and submodules just as reads do, so a sibling
    // listing without the name proves nothing for these answers.
    const siblingsOnly = () =>
      mocks.listAt.mockResolvedValue(listing([{ name: "b.ts", path: "src/b.ts", kind: "file" }]));

    it("is not a delete when the ref holds a link or a nested repository there", async () => {
      conflictOn(["src/a.ts"]);
      mocks.readAt.mockResolvedValue({
        ok: false,
        notFound: true,
        error: originError(404, "unsupported_entry"),
        originId: "origin-1",
        originMode: "hosted",
      });
      siblingsOnly();
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe(
        "src/a.ts is a link or a nested repository in this unsaved work, so it can't be saved from here. Ask the agent instead.",
      );
      // The choice stays open.
      expect(q(row(container, RECOVERY), "unsaved-work-path-use")).not.toBeNull();
    });

    it("is not a delete on a 404 that does not say the path is gone", async () => {
      conflictOn(["src/a.ts"]);
      mocks.readAt.mockResolvedValue({
        ok: false,
        notFound: true,
        error: originError(404, undefined, { message: "file not found" }),
        originId: "origin-1",
        originMode: "hosted",
      });
      siblingsOnly();
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe(
        "Couldn't tell whether this unsaved work deletes src/a.ts, so nothing was saved. Ask the agent instead.",
      );
    });

    it("deletes on not_found once a listing shows the ref resolves without the path", async () => {
      conflictOn(["src/a.ts"]);
      mocks.readAt.mockResolvedValue({
        ok: false,
        notFound: true,
        error: originError(404, "not_found"),
        originId: "origin-1",
        originMode: "hosted",
      });
      siblingsOnly();
      mocks.saveChanges.mockResolvedValue({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: [] });
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.listAt).toHaveBeenCalledWith(expect.objectContaining({ path: "src", ref: RECOVERY }));
      expect(mocks.saveChanges.mock.calls[0]?.[0]).toMatchObject({ files: [], deletes: ["src/a.ts"], baseRev: NEW_HEAD });
    });

    it("refreshes instead of writing when the ref itself no longer resolves (rev_not_found)", async () => {
      conflictOn(["src/a.ts"]);
      mocks.readAt.mockResolvedValue({
        ok: false,
        notFound: false,
        error: originError(404, "rev_not_found"),
        originId: "origin-1",
        originMode: "hosted",
      });
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      const listsBefore = mocks.fetchRecovery.mock.calls.length;
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.listAt).not.toHaveBeenCalled();
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe("This entry changed. Refreshing.");
      expect(q(row(container, RECOVERY), "unsaved-work-conflict")).toBeNull();
      expect(mocks.fetchRecovery.mock.calls.length).toBe(listsBefore + 1);
    });

    it("deletes a path whose whole folder the work removed", async () => {
      conflictOn(["src/old/gone.ts"]);
      mocks.readAt.mockResolvedValue({
        ok: false,
        notFound: true,
        error: originError(404, "not_found"),
        originId: "origin-1",
        originMode: "hosted",
      });
      mocks.listAt.mockImplementation(async (params: { path: string }) =>
        params.path === "" ? listing([{ name: "README.md", path: "README.md", kind: "file" }]) : listing([]),
      );
      mocks.saveChanges.mockResolvedValue({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: [] });
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.saveChanges.mock.calls[0]?.[0]).toMatchObject({ files: [], deletes: ["src/old/gone.ts"] });
    });

    it("refreshes instead of writing when the ref moved since the list loaded", async () => {
      conflictOn(["src/a.ts"]);
      mocks.readAt.mockResolvedValue({
        ok: true,
        file: { path: "src/a.ts", contentBase64: btoa("newer\n"), size: 6, rev: "9".repeat(40) },
      });
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe("This entry changed. Refreshing.");
      expect(q(row(container, RECOVERY), "unsaved-work-conflict")).toBeNull();
    });
  });

  // Origins answer `?ref=` with X-Instafy-Rev set to the ref's tip, or with
  // no header: another commit means the ref moved, no header means nothing.
  describe("X-Instafy-Rev at the ref", () => {
    const savedOk = { ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/a.ts"] };

    function conflictOn(paths: string[]) {
      mocks.restoreRecovery.mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths }),
        originId: "origin-1",
        originMode: "hosted",
      });
    }

    function readAnswers(rev: string | null) {
      mocks.readAt.mockResolvedValue({
        ok: true,
        file: { path: "src/a.ts", contentBase64: btoa("kept\n"), size: 5, rev },
      });
    }

    function goneAtRef(listingRev: string | null) {
      mocks.readAt.mockResolvedValue({
        ok: false,
        notFound: true,
        error: originError(404, "not_found"),
        originId: "origin-1",
        originMode: "hosted",
      });
      mocks.listAt.mockResolvedValue({
        ok: true,
        entries: [{ name: "b.ts", path: "src/b.ts", kind: "file" }],
        rev: listingRev,
        originId: "origin-1",
        originMode: "hosted",
      });
    }

    async function useVersion() {
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
    }

    it("writes the file when the read carries no header", async () => {
      conflictOn(["src/a.ts"]);
      readAnswers(null);
      mocks.saveChanges.mockResolvedValue(savedOk);
      await useVersion();
      expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
      expect(mocks.saveChanges.mock.calls[0]?.[0]).toMatchObject({ deletes: [], baseRev: NEW_HEAD });
      expect(q(container, "history-status")?.textContent).toBe("Saved this version of src/a.ts.");
    });

    it("writes the file when the read names the row's commit", async () => {
      conflictOn(["src/a.ts"]);
      readAnswers("a".repeat(40));
      mocks.saveChanges.mockResolvedValue(savedOk);
      await useVersion();
      expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
    });

    it("deletes the path when the listing that proves it gone carries no header", async () => {
      conflictOn(["src/a.ts"]);
      goneAtRef(null);
      mocks.saveChanges.mockResolvedValue(savedOk);
      await useVersion();
      expect(mocks.saveChanges.mock.calls[0]?.[0]).toMatchObject({ files: [], deletes: ["src/a.ts"] });
    });

    it("refreshes instead of deleting when the listing names another commit", async () => {
      conflictOn(["src/a.ts"]);
      goneAtRef("9".repeat(40));
      await useVersion();
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe("This entry changed. Refreshing.");
      expect(q(row(container, RECOVERY), "unsaved-work-conflict")).toBeNull();
    });
  });

  it("offers ask-the-agent per file with the ref to read from", async () => {
    mocks.restoreRecovery.mockResolvedValueOnce({
      ok: false,
      stage: "response",
      error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["src/a.ts"] }),
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    await press(row(container, RECOVERY), "unsaved-work-restore");
    await press(row(container, RECOVERY), "unsaved-work-path-ask");
    expect(mocks.setConversationDraft).toHaveBeenCalledWith(
      "conversation-1",
      `Merge \`src/a.ts\` from \`${RECOVERY}\` into the saved version. Read it with \`instafy git show ${RECOVERY}:src/a.ts\`.`,
    );
    expect(mocks.openConversationTab).toHaveBeenCalledWith("conversation-1");
  });

  describe("choices across closing the drawer", () => {
    function conflictOnThree() {
      mocks.restoreRecovery.mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
        originId: "origin-1",
        originMode: "hosted",
      });
    }

    async function openDrawer(onRequestClose: () => void) {
      await act(async () => root.render(<HistoryDrawer versioning={versioning()} onRequestClose={onRequestClose} />));
      await flush();
    }

    async function chooseThenAsk() {
      // The host unmounts the drawer when it closes, as StudioLayout does.
      const close = vi.fn(() => root.render(null));
      conflictOnThree();
      await openDrawer(close);
      await press(row(container, RECOVERY), "unsaved-work-restore");
      const paths = Array.from(row(container, RECOVERY).querySelectorAll<HTMLElement>('[data-testid="unsaved-work-path"]'));
      await press(paths[0]!, "unsaved-work-path-keep");
      await press(paths[1]!, "unsaved-work-path-ask");
      expect(close).toHaveBeenCalledTimes(1);
      expect(q(container, "source-control-drawer")).toBeNull();
      return close;
    }

    it("keeps the per-file choices when asking the agent closes the drawer", async () => {
      const close = await chooseThenAsk();
      await openDrawer(close);
      const conflict = q(row(container, RECOVERY), "unsaved-work-conflict");
      expect(conflict).not.toBeNull();
      const resolved = Array.from(conflict!.querySelectorAll<HTMLElement>('[data-testid="unsaved-work-path-resolved"]'));
      expect(resolved.map((item) => item.closest('[data-testid="unsaved-work-path"]')?.getAttribute("data-path"))).toEqual([
        "src/a.ts",
      ]);
      expect(resolved[0]?.textContent).toContain("Kept current");
      expect(conflict!.querySelectorAll('[data-testid="unsaved-work-path-use"]')).toHaveLength(2);
      expect(mocks.restoreRecovery).toHaveBeenCalledTimes(1);
    });

    it("drops the choices when the entry now holds other work", async () => {
      const close = await chooseThenAsk();
      mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY, { rev: "9".repeat(40) })]));
      await openDrawer(close);
      expect(q(row(container, RECOVERY), "unsaved-work-conflict")).toBeNull();
    });
  });

  it("offers one way on during a conflict, so a second Restore cannot drop the choices", async () => {
    mocks.restoreRecovery.mockResolvedValueOnce({
      ok: false,
      stage: "response",
      error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["src/a.ts", "src/b.ts"] }),
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    await press(row(container, RECOVERY), "unsaved-work-restore");
    const entry = row(container, RECOVERY);
    expect(q(entry, "unsaved-work-restore")).toBeNull();
    // Review and Remove stay on the row.
    expect(q(entry, "unsaved-work-review")).not.toBeNull();
    expect(q(entry, "unsaved-work-remove")).not.toBeNull();
    const paths = Array.from(entry.querySelectorAll<HTMLElement>('[data-testid="unsaved-work-path"]'));
    await press(paths[0]!, "unsaved-work-path-keep");
    expect(entry.querySelectorAll('[data-testid="unsaved-work-path-resolved"]')).toHaveLength(1);
    expect(q(entry, "unsaved-work-restore")).toBeNull();
    expect(q(entry, "unsaved-work-restore-rest")).toBeNull();
    await press(paths[1]!, "unsaved-work-path-keep");
    expect(entry.querySelectorAll('[data-testid="unsaved-work-path-resolved"]')).toHaveLength(2);
    expect(q(entry, "unsaved-work-restore-rest")).not.toBeNull();
    expect(mocks.restoreRecovery).toHaveBeenCalledTimes(1);
  });

  describe("Cancel on the per-file choices", () => {
    function conflictOn(paths: string[]) {
      mocks.restoreRecovery.mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths }),
        originId: "origin-1",
        originMode: "hosted",
      });
    }

    it("backs out of a restore without removing the entry", async () => {
      mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(KEPT, { kind: "unsaved" })]));
      conflictOn(["src/a.ts", "src/b.ts"]);
      await render();
      await press(row(container, KEPT), "unsaved-work-restore");
      const entry = row(container, KEPT);
      expect(q(entry, "unsaved-work-restore")).toBeNull();
      const cancel = q<HTMLButtonElement>(entry, "unsaved-work-conflict-cancel");
      expect(cancel?.textContent).toBe("Cancel");
      const describedBy = cancel?.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
      expect(describedBy.map((id) => document.getElementById(id)?.textContent).join(" ")).toContain(
        "Unsaved edits from a stopped workspace",
      );

      await act(async () => cancel!.focus());
      await act(async () => cancel!.click());
      await flush();
      expect(q(row(container, KEPT), "unsaved-work-conflict")).toBeNull();
      // Focus goes back to the row's Restore, and the result is announced.
      expect(document.activeElement).toBe(q(row(container, KEPT), "unsaved-work-restore"));
      expect(q(container, "history-status")?.textContent).toBe("Restore cancelled. Nothing was changed.");
      expect(mocks.restoreRecovery).toHaveBeenCalledTimes(1);
      expect(mocks.saveChanges).not.toHaveBeenCalled();

      // Closing and opening History does not bring the choices back.
      await act(async () => root.render(null));
      await render();
      expect(q(row(container, KEPT), "unsaved-work-conflict")).toBeNull();
      expect(q(row(container, KEPT), "unsaved-work-restore")).not.toBeNull();
    });

    it("says that a file already saved stays saved", async () => {
      conflictOn(["src/a.ts", "src/b.ts"]);
      mocks.readAt.mockResolvedValue({ ok: true, file: { path: "src/a.ts", contentBase64: btoa("kept\n"), size: 5 } });
      mocks.saveChanges.mockResolvedValue({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/a.ts"] });
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      const paths = Array.from(row(container, RECOVERY).querySelectorAll<HTMLElement>('[data-testid="unsaved-work-path"]'));
      await press(paths[0]!, "unsaved-work-path-use");
      await press(row(container, RECOVERY), "unsaved-work-conflict-cancel");
      expect(q(row(container, RECOVERY), "unsaved-work-conflict")).toBeNull();
      expect(q(container, "history-status")?.textContent).toBe(
        "Restore cancelled. Files you already saved with Use this version stay saved.",
      );
    });
  });

  it("offers Remove instead of Restore the rest for a conflict entry", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(CONFLICT, { kind: "conflict", paths: ["src/a.ts"] })]));
    mocks.restoreRecovery.mockResolvedValueOnce({
      ok: false,
      stage: "response",
      error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["src/a.ts"] }),
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    await press(row(container, CONFLICT), "unsaved-work-restore");
    await press(row(container, CONFLICT), "unsaved-work-path-keep");
    expect(q(row(container, CONFLICT), "unsaved-work-restore-rest")).toBeNull();
    await press(row(container, CONFLICT), "unsaved-work-finish-remove");
    expect(q(document.body, "unsaved-work-remove-dialog")).not.toBeNull();
  });

  it("refreshes when the entry moved", async () => {
    mocks.restoreRecovery.mockResolvedValueOnce({
      ok: false,
      stage: "response",
      error: originError(409, "recovery_ref_moved"),
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    const before = mocks.fetchRecovery.mock.calls.length;
    await press(row(container, RECOVERY), "unsaved-work-restore");
    expect(q(container, "history-status")?.textContent).toBe("This entry changed. Refreshing.");
    expect(mocks.fetchRecovery.mock.calls.length).toBe(before + 1);
  });

  // The gateway's 503 answers with Retry-After.
  it.each([
    ["writes_busy", "The server is busy saving other changes. Try again in a moment."],
    ["mirror_reset", "The server is rebuilding its copy of this space. Try again in a moment."],
    ["disk_full", "The space is out of room right now. Try again later."],
  ])("names a restore answered %s and keeps the entry", async (code, copy) => {
    mocks.restoreRecovery.mockResolvedValueOnce({
      ok: false,
      stage: "request",
      error: originError(503, code, { retryAfterMs: 2000 }),
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    await press(row(container, RECOVERY), "unsaved-work-restore");
    expect(mocks.restoreRecovery).toHaveBeenCalledTimes(1);
    expect(q(container, "history-status")?.textContent).toBe(copy);
    expect(row(container, RECOVERY)).not.toBeNull();
  });

  it.each([
    ["mirror_reset", "The server is rebuilding its copy of this space. Try again in a moment."],
    ["disk_full", "The space is out of room right now. Try again later."],
  ])("names a removal answered %s and keeps the entry", async (code, copy) => {
    mocks.dismissRecovery.mockResolvedValueOnce({
      ok: false,
      stage: "request",
      error: originError(503, code, { retryAfterMs: 2000 }),
      originId: "origin-1",
      originMode: "hosted",
    });
    await render();
    await press(row(container, RECOVERY), "unsaved-work-remove");
    await press(document.body, "unsaved-work-remove-dialog-confirm");
    expect(mocks.dismissRecovery).toHaveBeenCalledTimes(1);
    expect(q(container, "history-status")?.textContent).toBe(copy);
    expect(row(container, RECOVERY)).not.toBeNull();
  });

  it("retries a moved head once, then reports a busy space", async () => {
    mocks.restoreRecovery
      .mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "head_moved", { head: NEW_HEAD, paths: ["src/a.ts"] }),
        originId: "origin-1",
        originMode: "hosted",
      })
      .mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "head_moved", { head: "9".repeat(40), paths: ["src/a.ts"] }),
        originId: "origin-1",
        originMode: "hosted",
      });
    await render();
    await press(row(container, RECOVERY), "unsaved-work-restore");
    expect(mocks.restoreRecovery).toHaveBeenCalledTimes(2);
    expect(mocks.restoreRecovery.mock.calls[1]?.[0]).toMatchObject({ baseRev: NEW_HEAD });
    expect(q(container, "history-status")?.textContent).toBe(
      "The space is busy saving other changes. Try again in a moment.",
    );
  });

  it("reports Desktop edits a restore would change", async () => {
    mocks.restoreRecovery.mockResolvedValueOnce({
      ok: false,
      stage: "response",
      error: originError(409, "dirty_paths", { paths: ["src/a.ts"] }),
      originId: "origin-1",
      originMode: "desktop",
    });
    await render(
      versioning({ mode: "desktop", chromeMode: "desktop", firstPaintMode: "desktop", originMode: "desktop", stateless: false }),
    );
    await press(row(container, RECOVERY), "unsaved-work-restore");
    expect(q(container, "history-status")?.textContent).toBe(
      "Files on this computer have edits this restore would change: src/a.ts. Save them first.",
    );
  });

  describe("Use this version on Desktop", () => {
    const desktop = () =>
      versioning({ mode: "desktop", chromeMode: "desktop", firstPaintMode: "desktop", originMode: "desktop", stateless: false });
    const FOLDER_BLOB = "c".repeat(40);

    function conflictOn(paths: string[]) {
      mocks.restoreRecovery.mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths }),
        originId: "origin-1",
        originMode: "desktop",
      });
    }

    function folder({
      dirty,
      present = true,
      absentCode,
    }: {
      dirty: string[];
      present?: boolean;
      /** The code on the folder's 404 (none: today's single-tenant body). */
      absentCode?: string;
    }) {
      mocks.readAt.mockImplementation(async (params: { path: string; ref?: string | null }) => {
        if (params.ref) {
          return { ok: true, file: { path: params.path, contentBase64: btoa("kept\n"), size: 5 } };
        }
        if (!present) {
          return { ok: false, notFound: true, error: originError(404, absentCode, { message: "file not found" }), originId: "origin-1", originMode: "desktop" };
        }
        return { ok: true, file: { path: params.path, contentBase64: btoa("local\n"), size: 6, blobOid: FOLDER_BLOB } };
      });
      mocks.fetchStatus.mockImplementation(async (params: { scope?: string | null }) =>
        params.scope === undefined
          ? { supported: true, dirtyCount: dirty.length, dirtyPaths: [], pathGroups: [] }
          : {
              supported: true,
              dirtyCount: dirty.length,
              dirtyPaths: dirty.map((path) => ({ path, code: " M" })),
              pathGroups: [],
              hasMoreFiles: false,
            },
      );
    }

    it("refuses to write over edits the folder holds outside any commit", async () => {
      conflictOn(["src/a.ts"]);
      folder({ dirty: ["src/a.ts"] });
      await render(desktop());
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.fetchStatus).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project-1", originId: "origin-1", routing: "default", scope: "src" }),
      );
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe(
        "Files on this computer have edits this restore would change: src/a.ts. Save them first.",
      );
      expect(q(row(container, RECOVERY), "unsaved-work-path-resolved")).toBeNull();
    });

    it("writes only over the copy it checked", async () => {
      conflictOn(["src/a.ts"]);
      folder({ dirty: ["src/other.ts"] });
      mocks.saveChanges.mockResolvedValue({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/a.ts"] });
      await render(desktop());
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.readAt).toHaveBeenCalledWith({ projectId: "project-1", originId: "origin-1", path: "src/a.ts", routing: "default" });
      expect(mocks.saveChanges).toHaveBeenCalledTimes(1);
      expect(mocks.saveChanges.mock.calls[0]?.[0]).toMatchObject({ expected: { "src/a.ts": FOLDER_BLOB }, baseRev: NEW_HEAD });
    });

    it("expects the file to stay absent on an uncoded 404 from the folder (the origin enforces it)", async () => {
      conflictOn(["src/a.ts"]);
      folder({ dirty: [], present: false });
      mocks.saveChanges.mockResolvedValue({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/a.ts"] });
      await render(desktop());
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.saveChanges.mock.calls[0]?.[0]).toMatchObject({ expected: { "src/a.ts": null } });
    });

    it("expects the file to stay absent on a coded not_found from the folder", async () => {
      conflictOn(["src/a.ts"]);
      folder({ dirty: [], present: false, absentCode: "not_found" });
      mocks.saveChanges.mockResolvedValue({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/a.ts"] });
      await render(desktop());
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.saveChanges.mock.calls[0]?.[0]).toMatchObject({ expected: { "src/a.ts": null } });
    });

    it("never writes over a link or a nested repository in the folder", async () => {
      conflictOn(["src/a.ts"]);
      folder({ dirty: [], present: false, absentCode: "unsupported_entry" });
      await render(desktop());
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe(
        "src/a.ts is a link or a nested repository in the folder on this computer, so this version can't be saved over it from here. Ask the agent instead.",
      );
      expect(q(row(container, RECOVERY), "unsaved-work-path-use")).not.toBeNull();
    });

    it("writes nothing when the folder cannot be checked", async () => {
      conflictOn(["src/a.ts"]);
      folder({ dirty: [] });
      mocks.fetchStatus.mockImplementation(async (params: { scope?: string | null }) =>
        params.scope === undefined ? { supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [] } : null,
      );
      await render(desktop());
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.saveChanges).not.toHaveBeenCalled();
      expect(q(container, "history-status")?.textContent).toBe(
        "Couldn't check this file in the folder on this computer, so nothing was saved. Try again.",
      );
    });
  });

  it("removes for everyone after a confirm, and says when it was already gone", async () => {
    mocks.dismissRecovery.mockResolvedValue({ ok: true, dismissed: false, missing: true, originId: "origin-1", originMode: "hosted" });
    mocks.fetchRecovery.mockResolvedValueOnce(list([recoveryEntry(RECOVERY)])).mockResolvedValue(list([]));
    await render();
    await press(row(container, RECOVERY), "unsaved-work-remove");
    const dialog = q(document.body, "unsaved-work-remove-dialog");
    expect(dialog?.textContent).toContain("Remove this unsaved work?");
    expect(dialog?.textContent).toContain("This removes it for everyone in this space and can't be undone.");
    expect(q(document.body, "unsaved-work-remove-dialog-cancel")?.textContent).toBe("Keep it");
    await press(document.body, "unsaved-work-remove-dialog-confirm");
    expect(mocks.dismissRecovery).toHaveBeenCalledWith({
      projectId: "project-1",
      originId: "origin-1",
      ref: RECOVERY,
      rev: "a".repeat(40),
      leaseConflictRetryDelayMs: 1500,
    });
    expect(q(container, "history-status")?.textContent).toBe("Already removed.");
    expect(container.querySelector('[data-testid="unsaved-work-entry"]')).toBeNull();
  });

  describe("keyboard focus", () => {
    const SECOND = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-3";

    async function pressWithFocus(scope: ParentNode, testId: string) {
      const button = q<HTMLButtonElement>(scope, testId);
      expect(button).not.toBeNull();
      await act(async () => button!.focus());
      expect(document.activeElement).toBe(button);
      await act(async () => button!.click());
      await flush();
    }

    function conflictOn(paths: string[]) {
      mocks.restoreRecovery.mockResolvedValueOnce({
        ok: false,
        stage: "response",
        error: originError(409, "restore_conflict", { head: NEW_HEAD, paths }),
        originId: "origin-1",
        originMode: "hosted",
      });
    }

    const pathItems = () =>
      Array.from(row(container, RECOVERY).querySelectorAll<HTMLElement>('[data-testid="unsaved-work-path"]'));
    const savedVersionsHeading = () =>
      Array.from(container.querySelectorAll("h3")).find((heading) => heading.textContent === "Saved versions");

    it("walks through the files of a conflict and lands on Restore the rest", async () => {
      conflictOn(["src/a.ts", "src/b.ts"]);
      await render();
      await pressWithFocus(row(container, RECOVERY), "unsaved-work-restore");
      // The row's Restore gave way to the per-file choices.
      expect(document.activeElement).toBe(q(pathItems()[0]!, "unsaved-work-path-use"));
      await pressWithFocus(pathItems()[0]!, "unsaved-work-path-keep");
      expect(document.activeElement).toBe(q(pathItems()[1]!, "unsaved-work-path-use"));
      expect(q(container, "history-status")?.textContent).toBe("Kept the current version of src/a.ts.");
      await pressWithFocus(pathItems()[1]!, "unsaved-work-path-keep");
      expect(document.activeElement).toBe(q(row(container, RECOVERY), "unsaved-work-restore-rest"));
    });

    it("moves on to the next file once Use this version saved", async () => {
      conflictOn(["src/a.ts", "src/b.ts"]);
      mocks.readAt.mockResolvedValue({ ok: true, file: { path: "src/a.ts", contentBase64: btoa("kept\n"), size: 5 } });
      mocks.saveChanges.mockResolvedValue({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/a.ts"] });
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await pressWithFocus(pathItems()[0]!, "unsaved-work-path-use");
      expect(document.activeElement).toBe(q(pathItems()[1]!, "unsaved-work-path-use"));
      expect(q(container, "history-status")?.textContent).toBe("Saved this version of src/a.ts.");
    });

    it("moves to the next row after Remove, and to Saved versions after the last row", async () => {
      mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY), recoveryEntry(SECOND)]));
      mocks.dismissRecovery.mockResolvedValue({ ok: true, dismissed: true, missing: false, originId: "origin-1", originMode: "hosted" });
      await render();
      mocks.fetchRecovery.mockReturnValue(new Promise(() => undefined));
      await pressWithFocus(row(container, RECOVERY), "unsaved-work-remove");
      await press(document.body, "unsaved-work-remove-dialog-confirm");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(document.activeElement).toBe(q(row(container, SECOND), "unsaved-work-review"));

      await pressWithFocus(row(container, SECOND), "unsaved-work-remove");
      await press(document.body, "unsaved-work-remove-dialog-confirm");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(q(container, "unsaved-work-section")).toBeNull();
      expect(document.activeElement).toBe(savedVersionsHeading());
    });

    it("moves to the next row when a restore removes this one", async () => {
      mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY), recoveryEntry(SECOND)]));
      mocks.restoreRecovery.mockResolvedValue({
        ok: true,
        rev: NEW_HEAD,
        baseRev: HEAD,
        committed: true,
        notRestored: [],
        refDeleted: true,
        originId: "origin-1",
        originMode: "hosted",
      });
      await render();
      mocks.fetchRecovery.mockReturnValue(new Promise(() => undefined));
      await pressWithFocus(row(container, RECOVERY), "unsaved-work-restore");
      expect(document.activeElement).toBe(q(row(container, SECOND), "unsaved-work-review"));
    });
  });

  describe("for assistive technology", () => {
    const SECOND = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-3";

    function described(element: Element | null): string {
      const ids = element?.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
      return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    }

    it("names the row each action belongs to", async () => {
      mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY), recoveryEntry(SECOND, { paths: ["src/c.ts"] })]));
      await render();
      for (const [ref, count] of [
        [RECOVERY, "2 files"],
        [SECOND, "1 file"],
      ] as const) {
        for (const action of ["unsaved-work-review", "unsaved-work-restore", "unsaved-work-remove"]) {
          const text = described(q(row(container, ref), action));
          expect(text).toContain("Agent work that couldn't be saved");
          expect(text).toContain(count);
        }
      }
    });

    it("keeps per-file descriptions apart when two rows are in conflict", async () => {
      mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY), recoveryEntry(SECOND, { paths: ["src/c.ts"] })]));
      mocks.restoreRecovery
        .mockResolvedValueOnce({
          ok: false,
          stage: "response",
          error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["src/a.ts"] }),
          originId: "origin-1",
          originMode: "hosted",
        })
        .mockResolvedValueOnce({
          ok: false,
          stage: "response",
          error: originError(409, "restore_conflict", { head: NEW_HEAD, paths: ["src/c.ts"] }),
          originId: "origin-1",
          originMode: "hosted",
        });
      await render();
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, SECOND), "unsaved-work-restore");
      expect(described(q(row(container, RECOVERY), "unsaved-work-path-use"))).toBe("src/a.ts");
      expect(described(q(row(container, SECOND), "unsaved-work-path-use"))).toBe("src/c.ts");
      const ids = Array.from(container.querySelectorAll("[id]"), (element) => element.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("names the entry in the Remove dialog", async () => {
      await render();
      await press(row(container, RECOVERY), "unsaved-work-remove");
      expect(q(document.body, "unsaved-work-remove-dialog-detail")?.textContent).toContain(
        "Agent work that couldn't be saved, ",
      );
      expect(q(document.body, "unsaved-work-remove-dialog-detail")?.textContent).toContain("2 files");
    });

    it("announces a repeated message again", async () => {
      mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(RECOVERY), recoveryEntry(SECOND)]));
      mocks.dismissRecovery.mockResolvedValue({ ok: true, dismissed: true, missing: false, originId: "origin-1", originMode: "hosted" });
      await render();
      mocks.fetchRecovery.mockReturnValue(new Promise(() => undefined));
      await press(row(container, RECOVERY), "unsaved-work-remove");
      await press(document.body, "unsaved-work-remove-dialog-confirm");
      const status = q(container, "history-status")!;
      expect(status.textContent).toBe("Removed.");
      const first = status.firstElementChild;
      await press(row(container, SECOND), "unsaved-work-remove");
      await press(document.body, "unsaved-work-remove-dialog-confirm");
      expect(status.textContent).toBe("Removed.");
      // A new node, so the live region speaks again.
      expect(status.firstElementChild).not.toBe(first);
    });
  });

  it("disables Restore and Remove for a viewer but keeps Review", async () => {
    mocks.project = { activeProjectId: "project-1", projectCapabilitiesResolved: true, canWriteProject: false };
    await render();
    const entry = row(container, RECOVERY);
    expect(q<HTMLButtonElement>(entry, "unsaved-work-restore")?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(entry, "unsaved-work-remove")?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(entry, "unsaved-work-review")?.disabled).toBe(false);
  });
});
