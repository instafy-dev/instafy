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

import { resetUnsavedWorkStoreForTests } from "../../../../workspace/unsavedWorkStore";
import { HistoryDrawer } from "../HistoryDrawer";

const HEAD = "e".repeat(40);
const NEW_HEAD = "f".repeat(40);
const RECOVERY = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-1";
const CONFLICT = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-2";
const SALVAGE = "refs/instafy/salvage/gateway/legacy-1";

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
    dismissible: true,
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

  it("is hidden while empty", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([]));
    await render();
    expect(q(container, "unsaved-work-section")).toBeNull();
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

  it("titles rows by kind, hides Remove for salvage and marks restored salvage", async () => {
    mocks.fetchRecovery.mockResolvedValue(
      list([
        recoveryEntry(RECOVERY),
        recoveryEntry(CONFLICT, { kind: "conflict", paths: ["src/a.ts"] }),
        recoveryEntry(SALVAGE, { kind: "salvage", dismissible: false, restoredRev: NEW_HEAD }),
      ]),
    );
    await render();
    const entries = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="unsaved-work-entry"]'));
    expect(entries.map((entry) => entry.getAttribute("data-kind"))).toEqual(["unpublished", "conflict", "salvage"]);
    expect(entries[0]?.textContent).toContain("Agent work that couldn't be saved");
    expect(entries[0]?.textContent).toContain("2 files");
    expect(entries[1]?.textContent).toContain("Agent work that conflicted with newer changes");
    expect(entries[1]?.textContent).toContain("1 file");
    expect(entries[2]?.textContent).toContain("Archived from the old file server");
    expect(q(entries[2]!, "unsaved-work-remove")).toBeNull();
    expect(q(entries[2]!, "unsaved-work-restored")?.textContent).toBe("Restored");
    expect(q(entries[0]!, "unsaved-work-remove")).not.toBeNull();
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

  it("keeps a restored salvage entry with a Restored badge", async () => {
    mocks.fetchRecovery.mockResolvedValue(list([recoveryEntry(SALVAGE, { kind: "salvage", dismissible: false })]));
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
    mocks.fetchRecovery.mockResolvedValueOnce(list([recoveryEntry(SALVAGE, { kind: "salvage", dismissible: false })]));
    await render();
    mocks.fetchRecovery.mockReturnValue(new Promise(() => undefined));
    await press(row(container, SALVAGE), "unsaved-work-restore");
    expect(q(container, "history-status")?.textContent).toBe("Restored as a new version.");
    expect(q(row(container, SALVAGE), "unsaved-work-restored")).not.toBeNull();
  });

  it("does not claim a new version when restoring an already restored salvage entry", async () => {
    mocks.fetchRecovery.mockResolvedValue(
      list([recoveryEntry(SALVAGE, { kind: "salvage", dismissible: false, restoredRev: NEW_HEAD })]),
    );
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
    await press(row(container, SALVAGE), "unsaved-work-restore");
    expect(q(container, "history-status")?.textContent).toBe(
      "Nothing to restore. The saved version already has this work.",
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

  it("says nothing was restored when every conflicted file was kept and nothing else is left", async () => {
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
    expect(status).toBe("Nothing else to restore. Kept the current version of src/a.ts, src/b.ts.");
    expect(status).not.toContain("Secret and ignored");
    expect(status).not.toContain("Restored as a new version");
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

    function folder({ dirty, present = true }: { dirty: string[]; present?: boolean }) {
      mocks.readAt.mockImplementation(async (params: { path: string; ref?: string | null }) => {
        if (params.ref) {
          return { ok: true, file: { path: params.path, contentBase64: btoa("kept\n"), size: 5 } };
        }
        if (!present) {
          return { ok: false, notFound: true, error: originError(404, undefined, { message: "file not found" }), originId: "origin-1", originMode: "desktop" };
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

    it("expects the file to stay absent when the folder does not have it", async () => {
      conflictOn(["src/a.ts"]);
      folder({ dirty: [], present: false });
      mocks.saveChanges.mockResolvedValue({ ok: true, rev: "1".repeat(40), committed: true, conflicted: [], rejected: [], saved: ["src/a.ts"] });
      await render(desktop());
      await press(row(container, RECOVERY), "unsaved-work-restore");
      await press(row(container, RECOVERY), "unsaved-work-path-use");
      expect(mocks.saveChanges.mock.calls[0]?.[0]).toMatchObject({ expected: { "src/a.ts": null } });
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

  it("disables Restore and Remove for a viewer but keeps Review", async () => {
    mocks.project = { activeProjectId: "project-1", projectCapabilitiesResolved: true, canWriteProject: false };
    await render();
    const entry = row(container, RECOVERY);
    expect(q<HTMLButtonElement>(entry, "unsaved-work-restore")?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(entry, "unsaved-work-remove")?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(entry, "unsaved-work-review")?.disabled).toBe(false);
  });
});
