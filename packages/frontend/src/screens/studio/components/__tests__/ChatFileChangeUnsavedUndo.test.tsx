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

function fileChange(path: string, changeType: ChatMessageFileChange["changeType"] = "changed"): ChatMessageFileChange {
  return { path, workspacePath: path, label: path, changeType, lineRanges: [] };
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
    // The machine the space's turns run on serves the folder.
    runtimeState.runtimeStatuses = [
      { runtimeId: "runtime-1", origin: { originId: "runtime-origin", status: "online", protocols: ["http"] } },
    ];
    // The folder still holds the stopped turn's edit.
    fetchWorkspaceGitStatus.mockResolvedValue({
      supported: true,
      dirtyCount: 1,
      dirtyPaths: [{ path: APP, code: " M", embeddedRepoRoot: null }],
      pathGroups: [],
      hasMoreFiles: false,
      busy: false,
      error: null,
    });
    revertWorkspaceGitPaths.mockResolvedValue({
      ok: true,
      reverted: [APP],
      removed: [],
      kept: { ref: "refs/instafy/local-recovery/20261102T131809Z-undone-0123456789ab", rev: "c".repeat(40) },
    });
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

  async function renderCard(chat: ChatMessage[] = [STOPPED]) {
    await act(async () => {
      root.render(
        <ChatLaterChangesContext.Provider value={conversationLaterChanges(chat)}>
          <ChatFileChangeList
            files={STOPPED.files ?? []}
            projectId="p1"
            unsavedReason="stopped_before_save"
            messageId={STOPPED.id}
            messageTimestamp={STOPPED.timestamp}
          />
        </ChatLaterChangesContext.Provider>,
      );
    });
    await settle();
  }

  const undoChip = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert"]');
  const dialog = () => document.querySelector<HTMLElement>('[data-testid="chat-file-change-revert-dialog"]');

  async function openUndo() {
    await act(async () => undoChip()?.click());
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
    // It read the folder the turn ran in, on that machine's own origin.
    expect(fetchWorkspaceGitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", originId: "runtime-origin", scope: "sites/porto-lello" }),
    );

    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]');
    await act(async () => confirm?.click());
    await settle();

    expect(revertWorkspaceGitPaths).toHaveBeenCalledTimes(1);
    expect(revertWorkspaceGitPaths).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        paths: [APP],
        originId: "runtime-origin",
        runtimeId: "runtime-1",
        routing: "default",
        keep: true,
      }),
    );
    // No message: nothing reaches the composer, so no turn runs.
    expect(undoRequests).toHaveLength(0);
    expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith(
      "Those changes are undone. They're kept under History, in Unsaved work.",
      "success",
      4000,
      undefined,
    );
    // The card says the file is back, with nothing left to save or undo.
    expect(container.textContent).not.toContain("Not saved");
    expect(undoChip()).toBeNull();
    expect(dialog()).toBeNull();
  });

  it("puts nothing back when a later turn of the chat changed the file since", async () => {
    const later: ChatMessage = {
      id: "msg-later",
      role: "assistant",
      content: "Added a map link.",
      timestamp: 2_000,
      files: [fileChange(APP)],
      metadata: { jobId: "job-later" },
    };
    await renderCard([STOPPED, later]);
    await openUndo();
    expect(dialog()?.getAttribute("data-state")).toBe("changed_later");
    expect(dialog()?.textContent).toContain(
      `A later turn changed ${APP}, so Undo here would take that back too. Nothing was undone.`,
    );
    expect(document.querySelector('[data-testid="chat-file-change-revert-confirm"]')).toBeNull();
    // The way left is to ask the agent: a message, which the person chooses.
    expect(document.querySelector('[data-testid="chat-file-change-revert-ask-agent"]')).not.toBeNull();
    expect(fetchWorkspaceGitStatus).not.toHaveBeenCalled();
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
    expect(undoRequests).toHaveLength(0);
  });

  it("puts nothing back when the files no longer hold the change", async () => {
    // A later save took the edit in (another chat's turn), or it was undone.
    fetchWorkspaceGitStatus.mockResolvedValue({
      supported: true,
      dirtyCount: 0,
      dirtyPaths: [],
      pathGroups: [],
      hasMoreFiles: false,
      busy: false,
      error: null,
    });
    await renderCard();
    await openUndo();
    expect(dialog()?.getAttribute("data-state")).toBe("not_in_files");
    expect(dialog()?.textContent).toContain("The files don't hold this change any more, so there's nothing to undo here.");
    expect(document.querySelector('[data-testid="chat-file-change-revert-confirm"]')).toBeNull();
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
  });

  it("reaches nothing while no machine of the space serves the folder", async () => {
    runtimeState.runtimeStatuses = [];
    await renderCard();
    await openUndo();
    expect(dialog()?.getAttribute("data-state")).toBe("machine_off");
    expect(dialog()?.textContent).toContain("The space's machine isn't running");
    expect(fetchWorkspaceGitStatus).not.toHaveBeenCalled();
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
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
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]')?.click());
    await settle();
    expect(showStatus).toHaveBeenCalledWith("The agent is saving right now. Try again in a moment.", "warning", 6500, undefined);
    expect(container.textContent).toContain("Not saved");
    expect(undoChip()).not.toBeNull();
  });
});
