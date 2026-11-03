// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWorkspaceGitDiff,
  fetchWorkspaceGitHistoryReview,
  fetchWorkspaceGitStatus,
  revertWorkspaceGitPaths,
  revertWorkspaceGitCommit,
  showStatus,
  runtimeState,
} = vi.hoisted(() => ({
  fetchWorkspaceGitDiff: vi.fn(),
  fetchWorkspaceGitHistoryReview: vi.fn(),
  fetchWorkspaceGitStatus: vi.fn(),
  revertWorkspaceGitPaths: vi.fn(),
  revertWorkspaceGitCommit: vi.fn(),
  showStatus: vi.fn(),
  runtimeState: {
    runtimeStatuses: [] as Array<{ runtimeId: string; origin?: { originId: string; status: string; protocols: string[] } }>,
  },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: { read: vi.fn() },
      git: {
        fetchDiff: fetchWorkspaceGitDiff,
        fetchHistoryReview: fetchWorkspaceGitHistoryReview,
        fetchStatus: fetchWorkspaceGitStatus,
        revertPaths: revertWorkspaceGitPaths,
        revertCommit: revertWorkspaceGitCommit,
      },
    },
  },
}));

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
  useWorkspaceVersioning: () => ({ mode: "stateless", recovery: "supported", originId: "gateway-origin", resolved: true }),
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
import { REQUEST_MESSAGE_UNDO_EVENT } from "../messageUndoRequest";
import type { ChatMessage, ChatMessageFileChange } from "../../types";

const APP = "sites/porto-lello/app.js";
const PLAN = "sites/porto-lello/tmp/plan.md";
// What the stopped turn left in the page, as its report recorded it.
const LEFT_AS = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function fileChange(
  path: string,
  changeType: ChatMessageFileChange["changeType"] = "changed",
  folderUndo: ChatMessageFileChange["folderUndo"] = { leftAs: LEFT_AS, changedBefore: false, runtimeId: "runtime-1" },
): ChatMessageFileChange {
  return { path, workspacePath: path, label: path, changeType, lineRanges: [], folderUndo };
}

// The stopped turn's row: its edit to the page, which no save took.
const STOPPED: ChatMessage = {
  id: "msg-stopped",
  role: "assistant",
  content: "",
  timestamp: 1_000,
  files: [fileChange(APP)],
  unsavedReason: "stopped_before_save",
  metadata: { jobId: "job-stopped" },
};

describe("Undo of a change a Stop left unsaved", () => {
  let container: HTMLDivElement;
  let root: Root;
  let undoRequests: Event[];
  const onUndoRequest = (event: Event) => undoRequests.push(event);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const mock of [
      fetchWorkspaceGitDiff,
      fetchWorkspaceGitHistoryReview,
      fetchWorkspaceGitStatus,
      revertWorkspaceGitPaths,
      revertWorkspaceGitCommit,
      showStatus,
    ]) {
      mock.mockReset();
    }
    fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });
    // The machine that ran the turn serves the folder.
    runtimeState.runtimeStatuses = [
      { runtimeId: "runtime-1", origin: { originId: "runtime-origin", status: "online", protocols: ["http"] } },
    ];
    // The folder's status still lists the page as changed: Undo needs more
    // than that, what the turn left in it.
    fetchWorkspaceGitStatus.mockResolvedValue({
      supported: true,
      dirtyCount: 1,
      dirtyPaths: [{ path: APP, code: " M", embeddedRepoRoot: null }],
      pathGroups: [],
      hasMoreFiles: false,
      busy: false,
      error: null,
    });
    revertWorkspaceGitPaths.mockResolvedValue({ ok: true, reverted: [APP], removed: [] });
    undoRequests = [];
    window.addEventListener(REQUEST_MESSAGE_UNDO_EVENT, onUndoRequest);
    vi.spyOn(window, "confirm");
  });

  afterEach(async () => {
    window.removeEventListener(REQUEST_MESSAGE_UNDO_EVENT, onUndoRequest);
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

  async function renderCard(
    chat: ChatMessage[] = [STOPPED],
    card: { files?: ChatMessageFileChange[]; unsavedReason?: ChatMessage["unsavedReason"] } = {},
  ) {
    await act(async () => {
      root.render(
        <ChatLaterChangesContext.Provider value={conversationLaterChanges(chat)}>
          <ChatFileChangeList
            files={card.files ?? STOPPED.files ?? []}
            projectId="p1"
            unsavedReason={card.unsavedReason ?? "stopped_before_save"}
            messageId={STOPPED.id}
            messageTimestamp={STOPPED.timestamp}
          />
        </ChatLaterChangesContext.Provider>,
      );
    });
    await settle();
  }

  const undoChip = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert"]');
  const askChip = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-undo"]');
  const dialog = () => document.querySelector<HTMLElement>('[data-testid="chat-file-change-revert-dialog"]');
  const confirmButton = () =>
    document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]');

  async function openUndo() {
    await act(async () => undoChip()?.click());
    await settle();
  }

  async function pressUndo() {
    await act(async () => confirmButton()?.click());
    await settle();
  }

  // A local test, Nov 2: Undo on a stopped turn's edit posted "Please undo the
  // change from your message at 2:16 PM (id 0abaf85f)." in the person's own
  // bubble, and a routed building turn put the file back, for 4 credits and
  // one of the day's messages.
  it("puts the files back in nobody's name, with no message and so no credit or daily message", async () => {
    await renderCard();
    expect(container.textContent).toContain("Not saved");
    expect(undoChip()?.title).toBe("Put the files back as they were before this turn");

    await openUndo();
    // Studio's own dialog, never the browser's confirm box.
    expect(window.confirm).not.toHaveBeenCalled();
    expect(dialog()?.getAttribute("data-state")).toBe("ready");
    expect(dialog()?.textContent).toContain("This puts the files back as they were before this turn.");

    await pressUndo();
    expect(revertWorkspaceGitPaths).toHaveBeenCalledTimes(1);
    // On the machine that ran the turn, and only while the page still holds
    // what the turn left: the origin checks that as it puts it back.
    expect(revertWorkspaceGitPaths).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        paths: [APP],
        originId: "runtime-origin",
        runtimeId: "runtime-1",
        routing: "default",
        keep: true,
        expected: { [APP]: LEFT_AS },
      }),
    );
    expect(fetchWorkspaceGitStatus).not.toHaveBeenCalled();
    // No message: nothing reaches the composer, so no turn runs.
    expect(undoRequests).toHaveLength(0);
    expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith("Those changes are undone.", "success", 4000, undefined);
    // The card says the file is back, with nothing left to save or undo.
    expect(container.textContent).not.toContain("Not saved");
    expect(undoChip()).toBeNull();
    expect(dialog()).toBeNull();
  });

  // A turn still running in this chat (whose files are on no row yet), a turn
  // in another chat, or the person's own edit changed the page after the
  // stopped turn: the origin finds it no longer holds what the turn left.
  it("puts nothing back when a file changed after the turn", async () => {
    revertWorkspaceGitPaths.mockResolvedValue({
      ok: false,
      conflict: false,
      error: "files changed since the turn left them",
      errorInfo: { status: 409, code: "head_moved", message: "files changed", paths: [APP], routeUnavailable: false },
    });
    await renderCard();
    await openUndo();
    await pressUndo();
    expect(revertWorkspaceGitPaths).toHaveBeenCalledWith(expect.objectContaining({ expected: { [APP]: LEFT_AS } }));
    expect(showStatus).toHaveBeenCalledWith(
      `${APP} changed after this turn, so Undo here would take that back too. Nothing was undone.`,
      "warning",
      9000,
      expect.objectContaining({ actionLabel: "Ask the agent to undo it" }),
    );
    expect(container.textContent).toContain("Not saved");
    expect(undoChip()).not.toBeNull();
    expect(undoRequests).toHaveLength(0);
  });

  it("puts nothing back when a later turn of the chat changed the file since", async () => {
    const later: ChatMessage = {
      id: "msg-later",
      role: "assistant",
      content: "Added a map link.",
      timestamp: 2_000,
      files: [fileChange(APP, "changed", null)],
      metadata: { jobId: "job-later" },
    };
    await renderCard([STOPPED, later]);
    await openUndo();
    expect(dialog()?.getAttribute("data-state")).toBe("changed_later");
    expect(dialog()?.textContent).toContain(
      `A later turn changed ${APP}, so Undo here would take that back too. Nothing was undone.`,
    );
    expect(confirmButton()).toBeNull();
    // The way left is to ask the agent: a message, which the person chooses.
    expect(document.querySelector('[data-testid="chat-file-change-revert-ask-agent"]')).not.toBeNull();
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
    expect(undoRequests).toHaveLength(0);
  });

  it("checks the chat again when Undo is pressed: a later turn may have landed meanwhile", async () => {
    await renderCard();
    await openUndo();
    expect(dialog()?.getAttribute("data-state")).toBe("ready");
    const later: ChatMessage = {
      id: "msg-later",
      role: "assistant",
      content: "Added a map link.",
      timestamp: 2_000,
      files: [fileChange(APP, "changed", null)],
      metadata: { jobId: "job-later" },
    };
    await renderCard([STOPPED, later]);
    await pressUndo();
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
    expect(dialog()?.getAttribute("data-state")).toBe("changed_later");
  });

  // Two Stops in a row on one page, a Stop after a failed save, or the
  // person's own edit: putting the page back as saved would take that back.
  it("puts nothing back when the turn found the file already changed", async () => {
    await renderCard([STOPPED], {
      files: [fileChange(APP, "changed", { leftAs: LEFT_AS, changedBefore: true, runtimeId: "runtime-1" })],
    });
    await openUndo();
    expect(dialog()?.getAttribute("data-state")).toBe("changed_before");
    expect(dialog()?.textContent).toContain(
      `${APP} also holds an earlier change that wasn't saved, so Undo here would take that back too. Nothing was undone.`,
    );
    expect(confirmButton()).toBeNull();
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
  });

  it("says there is nothing to undo when the files read as saved", async () => {
    revertWorkspaceGitPaths.mockResolvedValue({ ok: true, reverted: [], removed: [] });
    await renderCard();
    await openUndo();
    await pressUndo();
    expect(showStatus).toHaveBeenCalledWith(
      "The files don't hold this change any more, so there's nothing to undo here.",
      "warning",
      9000,
      expect.objectContaining({ actionLabel: "Ask the agent to undo it" }),
    );
    expect(container.textContent).toContain("Not saved");
  });

  it("reaches nothing while no machine serves the folder", async () => {
    runtimeState.runtimeStatuses = [];
    await renderCard();
    await openUndo();
    expect(dialog()?.getAttribute("data-state")).toBe("machine_off");
    expect(dialog()?.textContent).toContain("The space's machine isn't running");
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
  });

  // A team's turn can run on another machine than the one this person uses.
  it("puts the files back on the machine that ran the turn", async () => {
    runtimeState.runtimeStatuses = [
      { runtimeId: "runtime-1", origin: { originId: "runtime-origin", status: "online", protocols: ["http"] } },
      { runtimeId: "runtime-2", origin: { originId: "worker-origin", status: "online", protocols: ["http"] } },
    ];
    await renderCard([STOPPED], {
      files: [fileChange(APP, "changed", { leftAs: LEFT_AS, changedBefore: false, runtimeId: "runtime-2" })],
    });
    await openUndo();
    await pressUndo();
    expect(revertWorkspaceGitPaths).toHaveBeenCalledWith(
      expect.objectContaining({ originId: "worker-origin", runtimeId: "runtime-2" }),
    );
  });

  // The space's history leaves tmp and dependency folders out, so the
  // folder's origin neither lists nor puts them back: Undo leaves them, as a
  // saved change's Undo does, and marks only what it put back.
  it("leaves the files the space's history leaves out as they are", async () => {
    await renderCard([STOPPED], { files: [fileChange(APP), fileChange(PLAN, "created")] });
    await openUndo();
    await pressUndo();
    expect(revertWorkspaceGitPaths).toHaveBeenCalledWith(
      expect.objectContaining({ paths: [APP], expected: { [APP]: LEFT_AS } }),
    );
    expect(container.textContent).toContain("1 reverted");
    expect(container.textContent).toContain("app.js(reverted)");
    expect(container.textContent).not.toContain("plan.md(removed)");
  });

  // A failed save's files are no stopped turn's report, and the usual
  // failed save already committed them on the machine: its Undo asks the
  // agent, as before. So does a report that says nothing of what the turn
  // left in its files (an older runtime's).
  it("keeps the Undo that asks the agent for a failed save, or a report with no record of the files", async () => {
    await renderCard([STOPPED], { files: [fileChange(APP, "changed", null)], unsavedReason: "save_failed" });
    expect(undoChip()).toBeNull();
    expect(askChip()).not.toBeNull();
    await renderCard([STOPPED], { files: [fileChange(APP, "changed", null)] });
    expect(undoChip()).toBeNull();
    expect(askChip()).not.toBeNull();
  });

  it("says so, and leaves the files, when the agent is saving", async () => {
    revertWorkspaceGitPaths.mockResolvedValue({
      ok: false,
      conflict: false,
      error: "lease held",
      errorInfo: { status: 409, code: "lease_conflict", message: "lease held", routeUnavailable: false },
    });
    await renderCard();
    await openUndo();
    await pressUndo();
    expect(showStatus).toHaveBeenCalledWith("The agent is saving right now. Try again in a moment.", "warning", 6500, undefined);
    expect(container.textContent).toContain("Not saved");
    expect(undoChip()).not.toBeNull();
  });
});
