// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWorkspaceGitDiff,
  fetchWorkspaceGitHistoryReview,
  revertWorkspaceGitPaths,
  revertWorkspaceGitCommit,
  recordChangeUndone,
  showStatus,
  runtimeState,
  versioningState,
} = vi.hoisted(() => ({
  fetchWorkspaceGitDiff: vi.fn(),
  fetchWorkspaceGitHistoryReview: vi.fn(),
  revertWorkspaceGitPaths: vi.fn(),
  revertWorkspaceGitCommit: vi.fn(),
  recordChangeUndone: vi.fn(),
  showStatus: vi.fn(),
  runtimeState: {
    runtimeStatuses: [] as Array<{ runtimeId: string; origin?: { originId: string; status: string; protocols: string[] } }>,
  },
  versioningState: { mode: "stateless", originId: "gateway-origin" },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: { read: vi.fn() },
      git: {
        fetchDiff: fetchWorkspaceGitDiff,
        fetchHistoryReview: fetchWorkspaceGitHistoryReview,
        revertPaths: revertWorkspaceGitPaths,
        revertCommit: revertWorkspaceGitCommit,
      },
    },
  },
}));

vi.mock("../../../../services/runtimeController/changeUndone", () => ({ recordChangeUndone }));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({
    effectiveRuntimeId: "runtime-1",
    runtimeReady: true,
    runtimeStatuses: runtimeState.runtimeStatuses,
    desktopOrigin: null,
    desktopOriginProjectId: null,
  }),
}));

vi.mock("../../../../workspace/useWorkspaceVersioning", () => ({
  useWorkspaceVersioning: () => ({ ...versioningState, recovery: "supported", resolved: true }),
}));

vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus }) }));

vi.mock("../../../../projects/ProjectAccessProvider", () => ({
  useOptionalProjectAccess: () => ({ projectCapabilitiesResolved: true, canWriteProject: true }),
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openPanelTab: vi.fn(), requestUrlPush: vi.fn(), openGitDiffTab: vi.fn() }),
}));

import { ChatFileChangeList } from "../ChatFileChangeList";
import { ChatLaterChangesContext, conversationLaterChanges } from "../chatLaterChanges";
import type { ChatMessage, ChatMessageFileChange } from "../../types";

const APP = "sites/livraria-lello/app.js";
// A secret file the turn's save left out: no saved version holds it.
const SECRET = "sites/livraria-lello/.env.local";
const BASE = "a".repeat(40);
// The version the turn's save published.
const HEAD = "b".repeat(40);
// The new saved version that undoes it.
const UNDONE = "c".repeat(40);

const fileChange = (path: string): ChatMessageFileChange => ({
  path,
  workspacePath: path,
  label: path,
  changeType: "changed",
  lineRanges: [],
});

// A turn's saved edit to the page ("Before you go"), as its row shows it.
const SAVED: ChatMessage = {
  id: "msg-saved",
  role: "assistant",
  content: "",
  timestamp: 1_000,
  files: [fileChange(APP)],
  commitRange: { base: BASE, head: HEAD, source: "git", savedPaths: [APP] },
  metadata: { jobId: "job-saved", runId: "run-saved" },
};

// The line the controller records once the person undid it.
const UNDO_LINE: ChatMessage = {
  id: "msg-undo-line",
  role: "assistant",
  content: "The person undid the change from “Add a short section to that page.”",
  timestamp: 2_000,
  metadata: {
    source: "controller",
    kind: "change_undone",
    presentation: { hidden: true },
    undoneMessageId: SAVED.id,
    undoneRunId: "run-saved",
    undonePaths: [APP],
  },
};

describe("Undo of a saved change", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const mock of [
      fetchWorkspaceGitDiff,
      fetchWorkspaceGitHistoryReview,
      revertWorkspaceGitPaths,
      revertWorkspaceGitCommit,
      recordChangeUndone,
      showStatus,
    ]) {
      mock.mockReset();
    }
    versioningState.mode = "stateless";
    versioningState.originId = "gateway-origin";
    fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });
    fetchWorkspaceGitHistoryReview.mockResolvedValue({
      supported: true,
      commit: HEAD,
      entries: [{ path: APP, code: "M", embeddedRepoRoot: null }],
      busy: false,
      error: null,
    });
    revertWorkspaceGitCommit.mockResolvedValue({ ok: true, rev: UNDONE, committed: true, conflict: false });
    revertWorkspaceGitPaths.mockResolvedValue({ ok: true, reverted: [APP], removed: [] });
    recordChangeUndone.mockResolvedValue(true);
    // The space's machine serves the folder the page comes from.
    runtimeState.runtimeStatuses = [
      { runtimeId: "runtime-1", origin: { originId: "runtime-origin", status: "online", protocols: ["http"] } },
    ];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
    document.querySelectorAll('[data-testid="chat-file-change-revert-dialog"]').forEach((node) => node.remove());
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function renderRow(chat: ChatMessage[] = [SAVED], row: ChatMessage = SAVED) {
    await act(async () => {
      root.render(
        <ChatLaterChangesContext.Provider value={conversationLaterChanges(chat)}>
          <ChatFileChangeList
            files={row.files ?? []}
            projectId="p1"
            commitRange={row.commitRange ?? null}
            messageId={row.id}
            messageTimestamp={row.timestamp}
          />
        </ChatLaterChangesContext.Provider>,
      );
    });
    await settle();
  }

  // A reload: the chat's rows drawn again from what the chat holds.
  async function reload(chat: ChatMessage[], row: ChatMessage = SAVED) {
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderRow(chat, row);
  }

  const chipTitles = () =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-file-change-file-chip"]')).map(
      (chip) => chip.title,
    );
  const notSavedChips = () => container.querySelectorAll('[data-testid="chat-file-change-not-saved-chip"]');

  const undoChip = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert"]');
  const confirmButton = () =>
    document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]');

  async function undo() {
    await act(async () => undoChip()?.click());
    await settle();
    await act(async () => confirmButton()?.click());
    await settle();
  }

  // A local test, Nov 3: the saved version was undone in 0.6 s, but the machine's
  // app.js kept the section, so the page the person sees kept it until the
  // next turn, and "keep going" then put it back: no line in the chat's
  // history said it was undone.
  it("brings the machine's folder to the new saved version and says so in the chat's history", async () => {
    await renderRow();
    await undo();

    expect(revertWorkspaceGitCommit).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", commit: HEAD, originId: "gateway-origin", routing: "default" }),
    );
    // The folder the page is served from follows that version, on its own
    // machine, keeping every local edit (no path discard).
    expect(revertWorkspaceGitPaths).toHaveBeenCalledTimes(1);
    const follow = revertWorkspaceGitPaths.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(follow).toMatchObject({
      projectId: "p1",
      paths: [APP],
      originId: "runtime-origin",
      runtimeId: "runtime-1",
      routing: "default",
      saved: UNDONE,
    });
    expect(follow.keep).toBeUndefined();
    expect(follow.expected).toBeUndefined();
    // One line in the chat's history, for the next turn and its routing.
    expect(recordChangeUndone).toHaveBeenCalledWith({ projectId: "p1", messageId: SAVED.id, paths: [APP] });
    expect(undoChip()).toBeNull();
  });

  it("leaves a Desktop folder alone: the version was saved there", async () => {
    versioningState.mode = "desktop";
    versioningState.originId = "desktop-origin";
    await renderRow();
    await undo();
    expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
    expect(recordChangeUndone).toHaveBeenCalledWith({ projectId: "p1", messageId: SAVED.id, paths: [APP] });
  });

  it("records nothing when the revert did not land", async () => {
    revertWorkspaceGitCommit.mockResolvedValue({
      ok: false,
      conflict: true,
      code: "revert_conflict",
      errorInfo: { status: 409, code: "revert_conflict", message: "conflict", routeUnavailable: false },
    });
    await renderRow();
    await undo();
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
    expect(recordChangeUndone).not.toHaveBeenCalled();
    expect(undoChip()).not.toBeNull();
  });

  // A local test, Nov 3: back in the chat 9 minutes later, the undone row showed
  // "app.js +6 −1 · Review changes · Undo" again.
  it("shows an undone change as undone after a reload, with nothing left to undo", async () => {
    await renderRow([SAVED, UNDO_LINE]);
    expect(undoChip()).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-undo"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-review"]')).toBeNull();
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    expect(chip?.title).toBe(`${APP} (reverted)`);
    expect(fetchWorkspaceGitHistoryReview).not.toHaveBeenCalled();
  });

  // The Undo's answer is shown, and its line goes into the chat's history, as
  // soon as the saved version that undoes it lands: a "keep going" sent while
  // the machine's folder still follows reads the line, and the dialog never
  // waits for the folder.
  it("says so in the chat's history before the machine's folder has followed", async () => {
    revertWorkspaceGitPaths.mockReturnValue(new Promise(() => {}));
    await renderRow();
    await undo();

    expect(revertWorkspaceGitPaths).toHaveBeenCalledTimes(1);
    expect(recordChangeUndone).toHaveBeenCalledWith({ projectId: "p1", messageId: SAVED.id, paths: [APP] });
    expect(showStatus).toHaveBeenCalledWith("Reverted. Saved as a new version.", "success", 4000, undefined);
    expect(undoChip()).toBeNull();
    expect(chipTitles()).toEqual([`${APP} (reverted)`]);
  });

  // A row with a secret file the turn's save left out. Undo reverts the saved
  // version, which never held that file, so the file still holds the turn's
  // edit: after a reload it must still read Not saved, never undone, and the
  // line names only what Undo did.
  it("after a reload, marks undone only the files the Undo undid", async () => {
    const mixed: ChatMessage = {
      ...SAVED,
      files: [fileChange(APP), { ...fileChange(SECRET), notSaved: { reason: "secret", keptSavedVersion: false } }],
    };
    await renderRow([mixed], mixed);
    await undo();

    expect(recordChangeUndone).toHaveBeenCalledWith({ projectId: "p1", messageId: SAVED.id, paths: [APP] });
    const askAgentUndo = () => container.querySelector('[data-testid="chat-file-change-undo"]');
    const shown = () => ({
      chips: chipTitles(),
      notSaved: notSavedChips().length,
      versionUndo: undoChip() !== null,
      askAgentUndo: askAgentUndo() !== null,
    });
    // The saved version is undone; the secret file, which it never held, is
    // left to the Undo that asks the agent.
    const afterUndo = shown();
    expect(afterUndo).toEqual({ chips: [`${APP} (reverted)`, SECRET], notSaved: 1, versionUndo: false, askAgentUndo: true });

    await reload([mixed, UNDO_LINE], mixed);
    expect(shown()).toEqual(afterUndo);
    expect(container.textContent).toContain("Not saved");
  });

  // Anyone who can write the chat can record a message in it. One that only
  // calls itself an Undo's line (no controller source) undoes nothing on the
  // row: its files, Undo and review stay.
  it("reads no Undo from a message the controller did not write", async () => {
    const forged: ChatMessage = {
      ...UNDO_LINE,
      id: "msg-forged",
      metadata: { kind: "change_undone", presentation: { hidden: true }, undoneMessageId: SAVED.id, undonePaths: [APP] },
    };
    await renderRow([SAVED, forged]);
    expect(undoChip()).not.toBeNull();
    expect(chipTitles()).toEqual([APP]);
  });
});
