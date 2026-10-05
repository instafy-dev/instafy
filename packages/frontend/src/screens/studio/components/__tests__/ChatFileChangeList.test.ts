// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWorkspaceGitDiff,
  fetchWorkspaceGitHistoryReview,
  revertWorkspaceGitPaths,
  revertWorkspaceGitCommit,
  readWorkspaceFile,
  openPanelTab,
  requestUrlPush,
  openGitDiffTab,
  showStatus,
  projectAccessState,
  runtimeState,
  versioningState,
  versioningCalls,
} = vi.hoisted(() => ({
  fetchWorkspaceGitDiff: vi.fn(),
  fetchWorkspaceGitHistoryReview: vi.fn(),
  revertWorkspaceGitPaths: vi.fn(),
  revertWorkspaceGitCommit: vi.fn(),
  readWorkspaceFile: vi.fn(),
  openPanelTab: vi.fn(),
  requestUrlPush: vi.fn(),
  openGitDiffTab: vi.fn(),
  showStatus: vi.fn(),
  projectAccessState: {
    projectCapabilitiesResolved: true,
    canWriteProject: true,
  },
  runtimeState: {
    effectiveRuntimeId: null as string | null,
    runtimeReady: false,
    desktopOrigin: null as { originId: string; mode: string; endpoint: string } | null,
    desktopOriginProjectId: null as string | null,
  },
  versioningState: {
    mode: "legacy" as "legacy" | "stateless" | "desktop",
    recovery: "unknown" as "unknown" | "supported" | "unsupported",
    originId: null as string | null,
  },
  versioningCalls: [] as Array<{ projectId: string | null; origin: { originId: string } | null }>,
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: {
        read: readWorkspaceFile,
      },
      git: {
        fetchDiff: fetchWorkspaceGitDiff,
        fetchHistoryReview: fetchWorkspaceGitHistoryReview,
        revertPaths: revertWorkspaceGitPaths,
        revertCommit: revertWorkspaceGitCommit,
      },
    },
  },
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({
    effectiveRuntimeId: runtimeState.effectiveRuntimeId,
    runtimeReady: runtimeState.runtimeReady,
    desktopOrigin: runtimeState.desktopOrigin,
    desktopOriginProjectId: runtimeState.desktopOriginProjectId,
  }),
}));

vi.mock("../../../../workspace/useWorkspaceVersioning", () => ({
  useWorkspaceVersioning: (args: { projectId: string | null; origin: { originId: string } | null }) => {
    versioningCalls.push({ projectId: args.projectId, origin: args.origin });
    return { ...versioningState, resolved: versioningState.mode !== "legacy" };
  },
}));

vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({
    showStatus,
  }),
}));

vi.mock("../../../../projects/ProjectAccessProvider", () => ({
  useOptionalProjectAccess: () => projectAccessState,
}));

vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    openPanelTab,
    requestUrlPush,
    openGitDiffTab,
  }),
}));

import { ChatFileChangeList, REVERT_WAIT_TIMEOUT_MS, resolveUniqueChatFileChanges } from "../ChatFileChangeList";
import { REQUEST_MESSAGE_UNDO_EVENT, type MessageUndoRequestDetail } from "../messageUndoRequest";
import type { ChatMessageFileChange } from "../../types";

function fileChange(path: string, workspacePath = path): ChatMessageFileChange {
  return {
    path,
    workspacePath,
    label: path,
    changeType: "changed",
    lineRanges: [],
  };
}

describe("resolveUniqueChatFileChanges", () => {
  it("deduplicates repeated workspace paths before rendering file change rows", () => {
    const files = [
      fileChange("README.md"),
      fileChange("./README.md", "README.md"),
      fileChange("docs/current-state.md"),
    ];

    const resolved = resolveUniqueChatFileChanges(files);

    expect(resolved.map((entry) => entry.workspacePath)).toEqual(["README.md", "docs/current-state.md"]);
  });
});

describe("ChatFileChangeList", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchWorkspaceGitDiff.mockReset();
    fetchWorkspaceGitHistoryReview.mockReset();
    revertWorkspaceGitPaths.mockReset();
    revertWorkspaceGitCommit.mockReset();
    readWorkspaceFile.mockReset();
    openPanelTab.mockReset();
    requestUrlPush.mockReset();
    openGitDiffTab.mockReset();
    showStatus.mockReset();
    projectAccessState.projectCapabilitiesResolved = true;
    projectAccessState.canWriteProject = true;
    runtimeState.effectiveRuntimeId = null;
    runtimeState.runtimeReady = false;
    runtimeState.desktopOrigin = null;
    runtimeState.desktopOriginProjectId = null;
    versioningCalls.length = 0;
    versioningState.mode = "legacy";
    versioningState.recovery = "unknown";
    versioningState.originId = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("asks how its own project keeps versions, never with another project's origin", async () => {
    const desk = { originId: "desk-origin", mode: "desktop", endpoint: "http://desk" };
    // Right after a project switch the store still holds the previous
    // project's Desktop origin.
    runtimeState.desktopOrigin = desk;
    runtimeState.desktopOriginProjectId = "desk-project";
    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files: [fileChange("a.md")], projectId: "cloud-project" }));
    });
    expect(versioningCalls.at(-1)).toEqual({ projectId: "cloud-project", origin: null });

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files: [fileChange("a.md")], projectId: "desk-project" }));
    });
    expect(versioningCalls.at(-1)).toEqual({ projectId: "desk-project", origin: desk });
  });

  it("toggles a per-file detail card from its chip", async () => {
    const files = [fileChange("src/one.ts"), fileChange("src/two.ts"), fileChange("src/three.ts")].map(
      (entry) => ({ ...entry, changeType: "created" as const }),
    );

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: null }));
    });

    // Small change-sets start with the file chips visible.
    expect(container.textContent).toContain("Created 3 files");
    const chips = container.querySelectorAll<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    expect(chips).toHaveLength(3);
    expect(chips[0]?.textContent).toBe("one.ts");
    expect(chips[0]?.title).toBe("src/one.ts");
    expect(container.querySelector('[data-testid="chat-file-change-row"]')).toBeNull();

    // A chip opens only its own detail card.
    await act(async () => {
      chips[0]?.click();
    });
    expect(container.querySelectorAll('[data-testid="chat-file-change-row"]')).toHaveLength(1);
    expect(chips[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Diff unavailable.");

    // Clicking the chip again closes the card.
    await act(async () => {
      chips[0]?.click();
    });
    expect(chips[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="chat-file-change-row"]')).toBeNull();
  });

  it("synthesizes a created file's diff from contents when the origin returns an empty diff", async () => {
    // A freshly created file can return an empty diff before it is committed/synced.
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });
    readWorkspaceFile.mockResolvedValue({ isText: true, contentText: "hello notes\n" });

    const files = [{ ...fileChange("notes.txt"), changeType: "created" as const }];

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: "p1" }));
    });
    // Flush the async diff-loading effect (fetch empty -> read file -> synthesize).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    await act(async () => {
      chip?.click();
    });

    expect(readWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("hello notes");
    expect(container.textContent).not.toContain("No diff available.");
  });

  it("renders a created file's real diff without synthesizing when the origin returns one", async () => {
    // With commit-range pinning, a created file usually returns a proper new-file
    // diff from the origin. Synthesis (which reads the file) must fire only on an
    // empty diff, so the origin's own diff wins and no wasteful read happens.
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({
      supported: true,
      diff: "diff --git a/hello.txt b/hello.txt\nnew file mode 100644\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1,2 @@\n+from the origin\n+not synthesized",
      truncated: false,
    });
    readWorkspaceFile.mockResolvedValue({ isText: true, contentText: "should not be read\n" });

    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const files = [{ ...fileChange("hello.txt"), changeType: "created" as const }];

    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, { files, projectId: "p1", commitRange: { base, head } }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    await act(async () => {
      chip?.click();
    });

    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain("from the origin");
    expect(container.textContent).not.toContain("should not be read");
    expect(container.textContent).not.toContain("No diff available.");
  });

  it("pins diff fetches to the run's commit range so edits render incrementally", async () => {
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({
      supported: true,
      diff: "diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new",
      truncated: false,
    });

    const base = "a".repeat(40);
    const head = "b".repeat(40);

    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [fileChange("notes.txt")],
          projectId: "p1",
          commitRange: { base, head },
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchWorkspaceGitDiff).toHaveBeenCalledWith(
      expect.objectContaining({ path: "notes.txt", base, commit: head }),
    );

    // The chip carries the +/− counts; the open card must not repeat them.
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    expect(chip?.textContent).toContain("lines added");
    await act(async () => {
      chip?.click();
    });
    const row = container.querySelector('[data-testid="chat-file-change-row"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).not.toContain("lines added");
  });

  it("does not synthesize for a changed file with an empty diff", async () => {
    // Synthesis only applies to creates (all-added is accurate); a modified file
    // with no diff would be inaccurate as all-added, so it stays "No diff available".
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });
    readWorkspaceFile.mockResolvedValue({ isText: true, contentText: "irrelevant\n" });

    const files = [{ ...fileChange("about.html"), changeType: "changed" as const }];

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: "p1" }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    await act(async () => {
      chip?.click();
    });

    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No diff available.");
  });

  it("tucks the file chips behind the summary chip for large change-sets", async () => {
    const files = [
      fileChange("src/one.ts"),
      fileChange("src/two.ts"),
      fileChange("src/three.ts"),
      fileChange("src/four.ts"),
      fileChange("src/five.ts"),
    ];

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: null }));
    });

    // More than 4 files: chips start hidden behind the summary toggle.
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-toggle-files"]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll('[data-testid="chat-file-change-file-chip"]')).toHaveLength(0);

    await act(async () => {
      toggle?.click();
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const chips = container.querySelectorAll<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    expect(chips).toHaveLength(5);

    // Open a card, tuck the rail away, then restore it: the card comes back.
    await act(async () => {
      chips[1]?.click();
    });
    expect(container.querySelectorAll('[data-testid="chat-file-change-row"]')).toHaveLength(1);

    await act(async () => {
      toggle?.click();
    });
    expect(container.querySelectorAll('[data-testid="chat-file-change-file-chip"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="chat-file-change-row"]')).toBeNull();

    await act(async () => {
      toggle?.click();
    });
    expect(container.querySelectorAll('[data-testid="chat-file-change-row"]')).toHaveLength(1);
  });

  it("disambiguates duplicate basenames in the chip rail", async () => {
    const files = [fileChange("src/app/index.ts"), fileChange("src/lib/index.ts")];

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: null }));
    });

    const chips = container.querySelectorAll<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    expect(Array.from(chips).map((chip) => chip.textContent)).toEqual(["app/index.ts", "lib/index.ts"]);
  });

  it("renders a single-file change without the summary toggle chip", async () => {
    const files = [fileChange("src/app/router.ts")];

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: null }));
    });

    expect(container.querySelector('[data-testid="chat-file-change-toggle-files"]')).toBeNull();
    const chips = container.querySelectorAll<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe("router.ts");
    expect(container.querySelector('[data-testid="chat-file-change-review"]')).not.toBeNull();
  });

  it("removes destructive undo actions when access changes to read-only", async () => {
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({
      supported: true,
      diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
      truncated: false,
    });
    const files = [fileChange("src/app.ts")];

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: "p1" }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="chat-file-change-undo"]')).not.toBeNull();

    projectAccessState.canWriteProject = false;
    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: "p1" }));
    });

    expect(container.querySelector('[data-testid="chat-file-change-undo"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-review"]')).not.toBeNull();
    expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
  });

  it("turns Undo into a conversational request when the message identity is known", async () => {
    // Conversational undo (#165): the chip asks the agent to undo the change
    // instead of silently reverting files.
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });
    const receivedDetails: MessageUndoRequestDetail[] = [];
    const listener = (event: Event) => {
      receivedDetails.push((event as CustomEvent<MessageUndoRequestDetail>).detail);
    };
    window.addEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);

    try {
      await act(async () => {
        root.render(
          createElement(ChatFileChangeList, {
            files: [fileChange("src/app.ts")],
            projectId: "p1",
            messageId: "msg-42",
            messageTimestamp: 1_756_600_000_000,
          }),
        );
      });

      const undoButton = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-undo"]');
      expect(undoButton).not.toBeNull();
      // The label stays "Undo"; the tooltip explains the conversational act.
      expect(undoButton?.textContent).toBe("Undo");
      expect(undoButton?.title).toBe("Ask the agent to undo this change");

      await act(async () => {
        undoButton?.click();
      });

      expect(receivedDetails).toHaveLength(1);
      expect(receivedDetails[0]).toMatchObject({
        messageId: "msg-42",
        messageTimestamp: 1_756_600_000_000,
      });
      // The conversational path never touches the file-revert API.
      expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();

      // The chip disables itself after the click, so a rapid second click
      // cannot dispatch a duplicate request.
      expect(undoButton?.disabled).toBe(true);
      await act(async () => {
        undoButton?.click();
      });
      expect(receivedDetails).toHaveLength(1);
    } finally {
      window.removeEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);
    }
  });

  it("re-enables the Undo chip immediately when the request was not sent", async () => {
    // Review finding 7a: without a result signal the chip stayed disabled for
    // the full cooldown after a submit that never sent anything, so the click
    // looked like it had landed. The listener reports the refusal back.
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });
    const listener = (event: Event) => {
      (event as CustomEvent<MessageUndoRequestDetail>).detail.onSettled?.(false);
    };
    window.addEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);

    try {
      await act(async () => {
        root.render(
          createElement(ChatFileChangeList, {
            files: [fileChange("src/app.ts")],
            projectId: "p1",
            messageId: "msg-42",
          }),
        );
      });

      const undoButton = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-undo"]');
      await act(async () => {
        undoButton?.click();
      });

      // Still clickable, without waiting out the 2.5s double-click cooldown.
      expect(undoButton?.disabled).toBe(false);
      expect(undoButton?.textContent).toBe("Undo");
    } finally {
      window.removeEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);
    }
  });

  it("keeps the legacy file revert when no message identity is available", async () => {
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });
    revertWorkspaceGitPaths.mockResolvedValue({ ok: true, removed: [] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const dispatched: Event[] = [];
    const listener = (event: Event) => dispatched.push(event);
    window.addEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);

    try {
      await act(async () => {
        root.render(createElement(ChatFileChangeList, { files: [fileChange("src/app.ts")], projectId: "p1" }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const undoButton = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-undo"]');
      await act(async () => {
        undoButton?.click();
      });

      expect(revertWorkspaceGitPaths).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p1", paths: ["src/app.ts"] }),
      );
      expect(dispatched).toHaveLength(0);
    } finally {
      window.removeEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);
      confirmSpy.mockRestore();
    }
  });

  it("keeps the direct per-file revert in the detail card alongside conversational undo", async () => {
    // The file-revert capability must remain reachable (clearly labeled) even
    // when the chip-row Undo has become a conversational affordance.
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });

    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [fileChange("src/app.ts")],
          projectId: "p1",
          messageId: "msg-42",
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    await act(async () => {
      chip?.click();
    });

    const revertButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Revert file changes to src/app.ts"]',
    );
    expect(revertButton).not.toBeNull();
  });

  it("says Not saved next to the file chips when the run's save failed", async () => {
    // The runtime records a failed save as gitSyncStatus "failed" on the
    // origin/apply artifact; the rail must not look like a normal change.
    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [fileChange("bookkeeping/profile.json")],
          projectId: "p1",
          unsavedReason: "save_failed",
          messageId: "msg-1",
        }),
      );
    });

    const state = container.querySelector<HTMLElement>('[data-testid="chat-file-change-unsaved"]');
    expect(state).not.toBeNull();
    // Visible label is the short state; the glyph is decorative.
    expect(state?.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(state?.querySelector("span:not(.sr-only)")?.textContent).toBe("Not saved");

    // It sits in the chip row, after the file chip and before the actions.
    const row = state?.parentElement;
    const rowChildren = Array.from(row?.querySelectorAll("[data-testid]") ?? []).map((node) =>
      node.getAttribute("data-testid"),
    );
    expect(rowChildren.indexOf("chat-file-change-file-chip")).toBeLessThan(
      rowChildren.indexOf("chat-file-change-unsaved"),
    );
    expect(rowChildren.indexOf("chat-file-change-unsaved")).toBeLessThan(
      rowChildren.indexOf("chat-file-change-review"),
    );

    // The plain-words explanation reaches pointer users (tooltip) and
    // assistive tech (described-by on the Review action). It no longer
    // points at a manual Save version, which never sees the agent's work.
    const explanation =
      "These changes weren't saved to the space yet. The agent saves them at its next turn, and anything left over is kept as unsaved work.";
    expect(state?.getAttribute("title")).toBe(explanation);
    const review = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-review"]');
    const describedBy = review?.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)?.textContent).toBe(explanation);
    expect(container.textContent).not.toMatch(/\u2014/);
  });

  it("opens the reason under the row when Not saved is tapped, for touch and keyboard users", async () => {
    // A title tooltip never shows on a phone and cannot be focused, so the
    // state is a native button that reveals the same words in place.
    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [fileChange("bookkeeping/profile.json")],
          projectId: "p1",
          unsavedReason: "save_failed",
          messageId: "msg-1",
        }),
      );
    });

    const state = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-unsaved"]');
    const note = container.querySelector<HTMLElement>('[data-testid="chat-file-change-unsaved-note"]');
    expect(state?.tagName).toBe("BUTTON");
    expect(state?.type).toBe("button");
    expect(state?.getAttribute("aria-controls")).toBe(note?.id);
    expect(state?.getAttribute("aria-expanded")).toBe("false");
    // Collapsed, the note stays in the tree for described-by but off screen.
    expect(note?.classList.contains("sr-only")).toBe(true);

    await act(async () => {
      state?.click();
    });
    expect(state?.getAttribute("aria-expanded")).toBe("true");
    expect(note?.classList.contains("sr-only")).toBe(false);
    expect(note?.textContent).toBe(state?.getAttribute("title"));
    // It sits under the chip row, not inside it.
    expect(note?.parentElement?.getAttribute("data-testid")).toBe("chat-file-change-summary");

    await act(async () => {
      state?.click();
    });
    expect(state?.getAttribute("aria-expanded")).toBe("false");
    expect(note?.classList.contains("sr-only")).toBe(true);
  });

  it("describes a turn whose save did not run in the past tense, without naming a cause", async () => {
    // Older turns got here from a user's own auto-save preference, newer ones
    // only from a runtime-wide setting. The note blames neither, and promises
    // no later save.
    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [fileChange("notes.md")],
          projectId: "p1",
          unsavedReason: "auto_save_off",
        }),
      );
    });

    const state = container.querySelector<HTMLElement>('[data-testid="chat-file-change-unsaved"]');
    expect(state?.textContent).toContain("Not saved");
    // A space that keeps versions the old way keeps today's sentence.
    expect(state?.getAttribute("title")).toBe(
      "Auto-save was off when this turn ran. Until you save a version, these changes are only on this space's machine and could be lost when it restarts.",
    );
    expect(state?.getAttribute("title")).not.toMatch(/next turn|runtime/i);

    // Where every save is a version there is no Save version to point at.
    versioningState.mode = "stateless";
    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [fileChange("notes.md")],
          projectId: "p1",
          unsavedReason: "auto_save_off",
        }),
      );
    });
    expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')?.getAttribute("title")).toBe(
      "Saving was off when this turn ran, so these changes weren't saved to the space.",
    );
  });

  it("points at History when the space lists Unsaved work there", async () => {
    versioningState.mode = "stateless";
    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [fileChange("notes.md")],
          projectId: "p1",
          unsavedReason: "save_failed",
        }),
      );
    });

    expect(
      container.querySelector('[data-testid="chat-file-change-unsaved"]')?.getAttribute("title"),
    ).toBe(
      "These changes weren't saved to the space yet. The agent saves them at its next turn, and anything left over is kept under History, in Unsaved work.",
    );
  });

  it("does not point a Desktop space at History until its origin lists unsaved work", async () => {
    versioningState.mode = "desktop";
    versioningState.recovery = "unsupported";
    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [{ ...fileChange("notes.md"), notSaved: { reason: "conflicted" as const, keptSavedVersion: true } }],
          projectId: "p1",
        }),
      );
    });
    const chip = container.querySelector<HTMLElement>('[data-testid="chat-file-change-not-saved-chip"]');
    expect(chip?.getAttribute("title")).toBe(
      "Changed in the space while the agent worked. The agent's version is kept as unsaved work.",
    );

    versioningState.recovery = "supported";
    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [{ ...fileChange("notes.md"), notSaved: { reason: "conflicted" as const, keptSavedVersion: true } }],
          projectId: "p1",
        }),
      );
    });
    expect(
      container.querySelector('[data-testid="chat-file-change-not-saved-chip"]')?.getAttribute("title"),
    ).toBe("Changed in the space while the agent worked. The agent's version is kept under History, in Unsaved work.");
  });

  it("marks each file a partial save left out, next to its own chip", async () => {
    const files = [
      fileChange("src/app.ts"),
      { ...fileChange(".env"), notSaved: { reason: "secret" as const, keptSavedVersion: false } },
      { ...fileChange("media/clip.mp4"), notSaved: { reason: "too_large" as const, keptSavedVersion: true } },
    ];

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: "p1", messageId: "msg-1" }));
    });

    // The whole change is not marked: most of it was saved.
    expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-toggle-files"]')?.textContent).toContain(
      "Edited 3 files · 2 not saved",
    );

    const rowOrder = Array.from(container.querySelectorAll("[data-testid]")).map((node) =>
      node.getAttribute("data-testid") === "chat-file-change-file-chip"
        ? `file:${node.textContent}`
        : node.getAttribute("data-testid"),
    );
    expect(rowOrder.slice(0, 7)).toEqual([
      "chat-file-change-summary",
      "chat-file-change-toggle-files",
      "file:app.ts",
      "file:.env",
      "chat-file-change-not-saved-chip",
      "file:clip.mp4",
      "chat-file-change-not-saved-chip",
    ]);

    const chips = container.querySelectorAll<HTMLButtonElement>('[data-testid="chat-file-change-not-saved-chip"]');
    expect(chips[0]?.querySelector("span:not(.sr-only)")?.textContent).toBe("Not saved");
    expect(chips[0]?.textContent).toContain(".env");
    expect(chips[0]?.title).toBe("Secret files aren't saved to the space. Use Secrets for these values.");
    expect(chips[1]?.title).toBe(
      "This file is larger than 20 MB, so it isn't saved to the space. The saved version is unchanged.",
    );

    // A tap opens that file's reason under the row, and only that one.
    const notes = container.querySelectorAll<HTMLElement>('[data-testid="chat-file-change-not-saved-note"]');
    expect(notes).toHaveLength(2);
    expect(chips[0]?.getAttribute("aria-controls")).toBe(notes[0]?.id);
    expect(chips[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(notes[0]?.classList.contains("sr-only")).toBe(true);
    await act(async () => {
      chips[0]?.click();
    });
    expect(chips[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(notes[0]?.classList.contains("sr-only")).toBe(false);
    expect(notes[0]?.textContent).toBe(".env: Secret files aren't saved to the space. Use Secrets for these values.");
    expect(notes[1]?.classList.contains("sr-only")).toBe(true);
    expect(notes[0]?.parentElement?.getAttribute("data-testid")).toBe("chat-file-change-summary");
    expect(container.textContent).not.toMatch(/\u2014/);
  });

  it("wraps a file's Not saved state together with its chip, never onto the next line alone", async () => {
    // At phone width a state that wrapped by itself would start the next
    // line and read as the next file's.
    const files = [
      fileChange("src/app.ts"),
      { ...fileChange("package.json"), notSaved: { reason: "conflicted" as const, keptSavedVersion: true } },
      fileChange("README.md"),
    ];
    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: null }));
    });

    const state = container.querySelector<HTMLElement>('[data-testid="chat-file-change-not-saved-chip"]');
    const group = state?.parentElement;
    expect(group?.tagName).toBe("SPAN");
    expect(group?.className.split(" ")).toEqual(expect.arrayContaining(["inline-flex", "min-w-0", "max-w-full"]));
    expect(group?.className).not.toContain("wrap");
    const chip = state?.previousElementSibling as HTMLElement | null;
    expect(chip?.getAttribute("data-testid")).toBe("chat-file-change-file-chip");
    expect(chip?.title).toBe("package.json");
    // The chip may shrink and truncate inside the group instead of
    // overflowing the rail.
    expect(chip?.className.split(" ")).toContain("min-w-0");
    expect(group?.children).toHaveLength(2);

    // Files without a save state are not wrapped.
    const plain = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="chat-file-change-file-chip"]'),
    ).find((node) => node.title === "README.md");
    expect(plain?.parentElement?.className).toBe("contents");
  });

  it("words every reason a save can leave a file out for", async () => {
    const reasons = [
      ["excluded", "Build output, dependency and cache folders aren't saved to the space."],
      ["ignored", "This file matches .gitignore, so it isn't saved to the space."],
      ["attachment", "Old chat upload files aren't saved to the space."],
      ["policy", "This space's file rules refused the file."],
      ["unsupported", "Links and special files can't be saved."],
      ["unknown", "The space didn't save this file."],
    ] as const;
    const files = reasons.map(([reason], index) => ({
      ...fileChange(`dir/file-${index}.txt`),
      notSaved: { reason, keptSavedVersion: false },
    }));
    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files: files.slice(0, 4), projectId: null }));
    });
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-file-change-not-saved-chip"]')).map(
        (chip) => chip.title,
      ),
    ).toEqual(reasons.slice(0, 4).map(([, text]) => text));

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files: files.slice(4), projectId: null }));
    });
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-file-change-not-saved-chip"]')).map(
        (chip) => chip.title,
      ),
    ).toEqual(reasons.slice(4).map(([, text]) => text));
  });

  it("shows no save state when the save worked or was never attempted", async () => {
    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, {
          files: [fileChange("notes.md")],
          projectId: "p1",
          unsavedReason: null,
        }),
      );
    });

    expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')).toBeNull();
    expect(container.textContent).not.toContain("Not saved");
    const review = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-review"]');
    expect(review?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps Not saved visible when a large change-set is tucked behind the summary chip", async () => {
    const files = ["a", "b", "c", "d", "e"].map((name) => fileChange(`src/${name}.ts`));

    await act(async () => {
      root.render(
        createElement(ChatFileChangeList, { files, projectId: null, unsavedReason: "save_failed" }),
      );
    });

    expect(container.querySelector('[data-testid="chat-file-change-file-chip"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')?.textContent).toContain(
      "Not saved",
    );
  });

  it("drops Not saved once every file has been reverted", async () => {
    runtimeState.runtimeReady = true;
    runtimeState.effectiveRuntimeId = "runtime-1";
    fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });
    revertWorkspaceGitPaths.mockResolvedValue({ ok: true, removed: [] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    try {
      await act(async () => {
        root.render(
          createElement(ChatFileChangeList, {
            files: [fileChange("src/app.ts")],
            projectId: "p1",
            unsavedReason: "save_failed",
          }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')).not.toBeNull();

      const undoButton = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-undo"]');
      await act(async () => {
        undoButton?.click();
      });

      expect(revertWorkspaceGitPaths).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="chat-file-change-unsaved"]')).toBeNull();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("middle-truncates long chip labels so the extension stays visible", async () => {
    const files = [fileChange("src/components/ExtremelyLongComponentNameForInternationalizationSupport.tsx")];

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: null }));
    });

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]');
    const label = chip?.textContent ?? "";
    expect(label).toContain("…");
    expect(label.endsWith(".tsx")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(28);
  });

  it("never carries the chat message prose measure cap (#207)", async () => {
    // The file-change list wants the full bubble width, unlike prose
    // paragraphs and list items, which are capped to a ~70ch measure inside
    // ChatMessageContent. Nothing here should ever pick up that cap.
    const files = [fileChange("src/one.ts"), fileChange("src/two.ts")].map((entry) => ({
      ...entry,
      changeType: "changed" as const,
    }));

    await act(async () => {
      root.render(createElement(ChatFileChangeList, { files, projectId: null }));
    });

    const summary = container.querySelector('[data-testid="chat-file-change-summary"]');
    expect(summary).not.toBeNull();
    expect(container.querySelector(".max-w-\\[70ch\\]")).toBeNull();
    expect(container.innerHTML).not.toContain("max-w-[70ch]");
  });

  describe("in a space where every save is a version", () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const gitRange = { base, head, source: "git" as const };

    // The files the saved version (the range's head) itself touched.
    function versionTouches(...paths: string[]) {
      fetchWorkspaceGitHistoryReview.mockResolvedValue({
        supported: true,
        commit: head,
        entries: paths.map((path) => ({ path, code: "M", embeddedRepoRoot: null })),
        busy: false,
        error: null,
      });
    }

    beforeEach(() => {
      versioningState.mode = "stateless";
      versioningState.originId = "gateway-origin";
      runtimeState.runtimeReady = true;
      runtimeState.effectiveRuntimeId = "runtime-1";
      fetchWorkspaceGitDiff.mockResolvedValue({ supported: true, diff: "", truncated: false });
      versionTouches("src/app.ts");
    });

    afterEach(() => {
      document.querySelectorAll('[data-testid="chat-file-change-revert-dialog"]').forEach((node) => node.remove());
    });

    async function renderCard(props: Record<string, unknown>) {
      await act(async () => {
        root.render(createElement(ChatFileChangeList, { projectId: "p1", ...props } as never));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    function revertChip() {
      return container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert"]');
    }

    function dialog() {
      return document.querySelector<HTMLElement>('[data-testid="chat-file-change-revert-dialog"]');
    }

    async function openRevertDialog() {
      await act(async () => {
        revertChip()?.click();
      });
      // The dialog checks the saved version's files first.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    async function confirmRevert() {
      await openRevertDialog();
      const confirm = document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]');
      expect(confirm).not.toBeNull();
      expect(confirm?.disabled).toBe(false);
      await act(async () => {
        confirm?.click();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    it("offers Undo first and Revert this change second, and no path discard", async () => {
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange, messageId: "msg-7" });

      const actions = Array.from(container.querySelectorAll("[data-testid]"))
        .map((node) => node.getAttribute("data-testid"))
        .filter((id) => id === "chat-file-change-undo" || id === "chat-file-change-revert");
      expect(actions).toEqual(["chat-file-change-undo", "chat-file-change-revert"]);
      expect(container.querySelector('[data-testid="chat-file-change-undo"]')?.getAttribute("title")).toBe(
        "Ask the agent to undo this change",
      );
      expect(revertChip()?.textContent).toBe("Revert this change");
      expect(revertChip()?.title).toBe("Save a new version that undoes this change");

      // The detail card has no per-file discard in this mode.
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-file-chip"]')?.click();
      });
      expect(container.querySelector('[aria-label="Revert file changes to src/app.ts"]')).toBeNull();
      expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
    });

    it("makes Revert this change the only action without a message identity", async () => {
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });

      expect(container.querySelector('[data-testid="chat-file-change-undo"]')).toBeNull();
      expect(revertChip()).not.toBeNull();
    });

    it("offers no Revert for a range that is not the canonical pair", async () => {
      await renderCard({
        files: [fileChange("src/app.ts")],
        commitRange: { base, head, source: "apply" as const },
        messageId: "msg-7",
      });
      expect(revertChip()).toBeNull();
      expect(container.querySelector('[data-testid="chat-file-change-undo"]')).not.toBeNull();

      // Older ranges without a source, and no range at all, get no Revert either.
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: { base, head } });
      expect(revertChip()).toBeNull();
      expect(container.querySelector('[data-testid="chat-file-change-undo"]')).toBeNull();
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: null });
      expect(revertChip()).toBeNull();
    });

    it("keeps today's actions while the space keeps versions the old way", async () => {
      versioningState.mode = "legacy";
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });

      expect(revertChip()).toBeNull();
      expect(container.querySelector('[data-testid="chat-file-change-undo"]')).not.toBeNull();
    });

    it("hides Revert for read-only viewers", async () => {
      projectAccessState.canWriteProject = false;
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange, messageId: "msg-7" });
      expect(revertChip()).toBeNull();
      expect(container.querySelector('[data-testid="chat-file-change-undo"]')).toBeNull();
    });

    it("checks the saved version's files, then saves a new version that undoes it", async () => {
      versionTouches("src/app.ts", "src/new.ts");
      let reviewed: (value: unknown) => void = () => {};
      const review = new Promise((resolve) => {
        reviewed = resolve;
      });
      fetchWorkspaceGitHistoryReview.mockReturnValueOnce(review);
      revertWorkspaceGitCommit.mockResolvedValue({ ok: true, rev: "c".repeat(40), committed: true });
      const commits: Event[] = [];
      const onCommit = (event: Event) => commits.push(event);
      window.addEventListener("instafy:workspace-commit", onCommit);
      try {
        await renderCard({
          files: [fileChange("src/app.ts"), { ...fileChange("src/new.ts"), changeType: "created" as const }],
          commitRange: gitRange,
          messageId: "msg-7",
        });

        await act(async () => {
          revertChip()?.click();
        });
        expect(dialog()?.textContent).toContain("Revert this change?");
        // Revert waits until the version's files are known.
        expect(dialog()?.getAttribute("data-state")).toBe("checking");
        expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe("Checking what this change includes\u2026");
        const confirm = () =>
          document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]');
        expect(confirm()?.disabled).toBe(true);
        expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledWith({
          projectId: "p1",
          commit: head,
          originId: "gateway-origin",
          routing: "default",
        });

        await act(async () => {
          reviewed({
            supported: true,
            commit: head,
            entries: [
              { path: "src/app.ts", code: "M", embeddedRepoRoot: null },
              { path: "src/new.ts", code: "A", embeddedRepoRoot: null },
            ],
            busy: false,
            error: null,
          });
        });
        expect(dialog()?.getAttribute("data-state")).toBe("ready");
        expect(dialog()?.textContent).toContain(
          "A new version that undoes it is saved on top. Nothing is removed from history.",
        );
        expect(confirm()?.disabled).toBe(false);
        // The safe choice has focus.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(document.activeElement?.textContent).toBe("Cancel");
        expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();

        await act(async () => {
          confirm()?.click();
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        // Only the head commit is named: the origin reverts that version's
        // own change, never a wider base..head range.
        expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);
        expect(revertWorkspaceGitCommit).toHaveBeenCalledWith({
          projectId: "p1",
          commit: head,
          originId: "gateway-origin",
          routing: "default",
          leaseConflictRetryDelayMs: 1500,
        });
        expect(showStatus).toHaveBeenCalledWith("Reverted. Saved as a new version.", "success", 4000, undefined);
        expect(commits).toHaveLength(1);
        expect(container.textContent).toContain("Reverted 2 files");
        expect(revertChip()).toBeNull();
        expect(revertWorkspaceGitPaths).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("instafy:workspace-commit", onCommit);
      }
    });

    it("names other work the saved version carries and offers the agent instead of Revert", async () => {
      // An earlier turn's save could not publish; this turn's save published
      // it together with this change, in one version.
      versionTouches("src/app.ts", "notes/earlier.md", "docs/plan.md");
      const requests: MessageUndoRequestDetail[] = [];
      const listener = (event: Event) => requests.push((event as CustomEvent<MessageUndoRequestDetail>).detail);
      window.addEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);
      try {
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange, messageId: "msg-7" });
        await openRevertDialog();

        expect(dialog()?.getAttribute("data-state")).toBe("other_work");
        expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
          "This change was saved together with other work, so reverting it here would also undo notes/earlier.md and docs/plan.md. Ask the agent to undo just this change.",
        );
        expect(document.querySelector('[data-testid="chat-file-change-revert-confirm"]')).toBeNull();

        await act(async () => {
          document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-ask-agent"]')?.click();
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.messageId).toBe("msg-7");
        expect(dialog()).toBeNull();
        expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);
      }
    });

    it("counts files the turn saved without listing them as its own, and names them", async () => {
      // An install rewrote the lockfile: the turn's save selected it, but the
      // card lists only the file the agent reported.
      versionTouches("src/app.ts", "package-lock.json");
      await renderCard({
        files: [fileChange("src/app.ts")],
        commitRange: { ...gitRange, savedPaths: ["src/app.ts", "package-lock.json"] },
      });
      await openRevertDialog();

      expect(dialog()?.getAttribute("data-state")).toBe("ready");
      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        "A new version that undoes it is saved on top. Nothing is removed from history. It also undoes this turn's changes to package-lock.json.",
      );
      expect(
        document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]')?.disabled,
      ).toBe(false);
    });

    it("offers the agent instead of Revert for a version published by merging", async () => {
      // The space moved while the agent worked, so its save published a
      // merge. A Desktop origin's review of a clean merge lists no files,
      // and a revert of it would need a base that also undoes every local
      // commit the merge brought in.
      versioningState.mode = "desktop";
      versioningState.originId = "desktop-origin";
      versionTouches();
      const requests: MessageUndoRequestDetail[] = [];
      const listener = (event: Event) => requests.push((event as CustomEvent<MessageUndoRequestDetail>).detail);
      window.addEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);
      try {
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange, messageId: "msg-7" });
        await openRevertDialog();

        expect(dialog()?.getAttribute("data-state")).toBe("combined");
        expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
          "This change was saved in a version that combines several saves, so it can't be reverted here. Ask the agent to undo just this change.",
        );
        expect(document.querySelector('[data-testid="chat-file-change-revert-confirm"]')).toBeNull();

        await act(async () => {
          document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-ask-agent"]')?.click();
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.messageId).toBe("msg-7");
        expect(dialog()).toBeNull();
        expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);
      }

      // Without a message to undo there is nothing to press but Cancel.
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();
      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        "This change was saved in a version that combines several saves, so it can't be reverted here.",
      );
      expect(document.querySelector('[data-testid="chat-file-change-revert-confirm"]')).toBeNull();
      expect(document.querySelector('[data-testid="chat-file-change-revert-ask-agent"]')).toBeNull();
    });

    it("offers no Revert for a version with other work even without a message to undo", async () => {
      versionTouches("src/app.ts", "notes/earlier.md");
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();

      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        "This change was saved together with other work, so reverting it here would also undo notes/earlier.md.",
      );
      expect(document.querySelector('[data-testid="chat-file-change-revert-confirm"]')).toBeNull();
      expect(document.querySelector('[data-testid="chat-file-change-revert-ask-agent"]')).toBeNull();
    });

    it("says when the check failed and lets the user check again", async () => {
      fetchWorkspaceGitHistoryReview.mockResolvedValueOnce(null);
      revertWorkspaceGitCommit.mockResolvedValue({ ok: true, rev: "c".repeat(40), committed: true });
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();

      expect(dialog()?.getAttribute("data-state")).toBe("failed");
      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        "Couldn't check what this change includes. Try again.",
      );
      expect(document.querySelector('[data-testid="chat-file-change-revert-confirm"]')).toBeNull();

      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-retry-check"]')?.click();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(2);
      expect(dialog()?.getAttribute("data-state")).toBe("ready");
      expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
    });

    it("moves focus to Cancel, never onto Revert, when Try again finds the change revertable", async () => {
      // The origin was busy saving the first time, then answers.
      fetchWorkspaceGitHistoryReview.mockResolvedValueOnce(null);
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();

      const retry = document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-retry-check"]');
      expect(retry).not.toBeNull();
      await act(async () => {
        retry?.focus();
      });
      expect(document.activeElement).toBe(retry);
      await act(async () => {
        retry?.click();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(dialog()?.getAttribute("data-state")).toBe("ready");
      const confirm = document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]');
      // Revert is its own button, not the Try again button relabelled.
      expect(confirm).not.toBe(retry);
      expect(document.activeElement).not.toBe(confirm);
      expect(document.activeElement?.textContent).toBe("Cancel");
      expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
    });

    // The gateway's copy of the space is cold: it fetches first and answers
    // 503 fetch_pending with Retry-After.
    function reviewStillLoading(retryAfterMs: number) {
      return {
        supported: true,
        commit: head,
        entries: [],
        busy: false,
        error: "Unable to load saved version changes right now. Try Refresh.",
        errorInfo: { status: 503, code: "fetch_pending", message: "fetch pending", retryAfterMs, routeUnavailable: false },
      };
    }

    // Polls instead of sleeping a fixed time, so a busy test machine cannot
    // make a short Retry-After look like a missing retry.
    async function waitForDialogState(state: string) {
      const started = Date.now();
      while (dialog()?.getAttribute("data-state") !== state && Date.now() - started < 2000) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }

    it("checks again once while the space is still loading, then offers Revert", async () => {
      // Long enough that the dialog is still checking when first looked at,
      // even on a busy test machine.
      fetchWorkspaceGitHistoryReview.mockResolvedValueOnce(reviewStillLoading(300));
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();

      // Still checking while it waits for the gateway.
      expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(1);
      expect(dialog()?.getAttribute("data-state")).toBe("checking");
      await waitForDialogState("ready");

      expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(2);
      expect(fetchWorkspaceGitHistoryReview.mock.calls[1]?.[0]).toEqual(fetchWorkspaceGitHistoryReview.mock.calls[0]?.[0]);
      expect(dialog()?.getAttribute("data-state")).toBe("ready");
      expect(
        document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]')?.disabled,
      ).toBe(false);
    });

    it("says the space is still loading when the second check finds it loading too", async () => {
      fetchWorkspaceGitHistoryReview.mockResolvedValue(reviewStillLoading(5));
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();
      await waitForDialogState("failed");

      expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(2);
      expect(dialog()?.getAttribute("data-state")).toBe("failed");
      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        "The space is still loading. Try again in a moment.",
      );
      expect(document.querySelector('[data-testid="chat-file-change-revert-retry-check"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="chat-file-change-revert-confirm"]')).toBeNull();
      expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
    });

    it("does not retry a check that failed for another reason", async () => {
      fetchWorkspaceGitHistoryReview.mockResolvedValueOnce({
        ...reviewStillLoading(5),
        errorInfo: { status: 502, message: "upstream", routeUnavailable: false },
      });
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(1);
      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        "Couldn't check what this change includes. Try again.",
      );
    });

    // The gateway's copy of the space was damaged: it makes it again and
    // answers 503 mirror_reset with Retry-After.
    function reviewAnswered(code: string, retryAfterMs: number) {
      return {
        ...reviewStillLoading(retryAfterMs),
        errorInfo: { status: 503, code, message: "try again in a moment", retryAfterMs, routeUnavailable: false },
      };
    }

    it("checks again once while the gateway makes its copy again, then offers Revert", async () => {
      fetchWorkspaceGitHistoryReview.mockResolvedValueOnce(reviewAnswered("mirror_reset", 5));
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();
      await waitForDialogState("ready");

      expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(2);
      expect(dialog()?.getAttribute("data-state")).toBe("ready");
    });

    it("names a copy still being made again after the second check", async () => {
      fetchWorkspaceGitHistoryReview.mockResolvedValue(reviewAnswered("mirror_reset", 5));
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();
      await waitForDialogState("failed");

      expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(2);
      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        "The server is rebuilding its copy of this space. Try again in a moment.",
      );
      expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
    });

    it("never checks again on its own when the space is out of room", async () => {
      fetchWorkspaceGitHistoryReview.mockResolvedValue(reviewAnswered("disk_full", 5));
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await openRevertDialog();
      await waitForDialogState("failed");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(1);
      expect(dialog()?.querySelector('[role="status"]')?.textContent).toBe(
        "The space is out of room right now. Try again later.",
      );
      // The person can still ask again.
      expect(document.querySelector('[data-testid="chat-file-change-revert-retry-check"]')).not.toBeNull();
      expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
    });

    it("marks only the files the reverted version touched", async () => {
      // The head version holds src/util.ts only; src/app.ts reached the
      // saved history in another version this revert does not touch.
      versionTouches("src/util.ts");
      revertWorkspaceGitCommit.mockResolvedValue({ ok: true, rev: "c".repeat(40), committed: true });
      await renderCard({
        files: [fileChange("src/app.ts"), fileChange("src/util.ts")],
        commitRange: gitRange,
      });
      await confirmRevert();

      expect(container.querySelector('[data-testid="chat-file-change-toggle-files"]')?.textContent).toContain(
        "Edited 2 files · 1 reverted",
      );
      const chipTitles = Array.from(
        container.querySelectorAll<HTMLElement>('[data-testid="chat-file-change-file-chip"]'),
      ).map((chip) => chip.title);
      expect(chipTitles).toEqual(["src/app.ts", "src/util.ts (reverted)"]);
    });

    it("marks a moved file's old path reverted too, though the review lists the new path only", async () => {
      // The runtime records the move as a deletion and a creation; the
      // origin's review detects the rename and lists only the new path.
      versioningState.mode = "desktop";
      versioningState.originId = "desktop-origin";
      fetchWorkspaceGitHistoryReview.mockResolvedValue({
        supported: true,
        commit: head,
        entries: [{ path: "src/components/Button.tsx", code: "R", embeddedRepoRoot: null }],
        busy: false,
        error: null,
      });
      revertWorkspaceGitCommit.mockResolvedValue({ ok: true, rev: "c".repeat(40), committed: true });
      const files = [
        { ...fileChange("src/Button.tsx"), changeType: "deleted" as const },
        { ...fileChange("src/components/Button.tsx"), changeType: "created" as const },
      ];
      await renderCard({
        files,
        commitRange: { ...gitRange, savedPaths: ["src/Button.tsx", "src/components/Button.tsx"] },
      });
      await confirmRevert();

      const chipTitles = () =>
        Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-file-change-file-chip"]')).map(
          (chip) => chip.title,
        );
      expect(container.querySelector('[data-testid="chat-file-change-toggle-files"]')?.textContent).toContain(
        "Reverted 2 files",
      );
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-toggle-files"]')?.click();
      });
      expect(chipTitles()).toEqual(["src/Button.tsx (reverted)", "src/components/Button.tsx (reverted)"]);

      // Without the turn's own save naming the old path, nothing says the
      // version touched it, so it keeps its state.
      revertWorkspaceGitCommit.mockClear();
      root.unmount();
      root = createRoot(container);
      await renderCard({ files, commitRange: gitRange });
      await confirmRevert();
      expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);
      expect(chipTitles()).toEqual(["src/Button.tsx", "src/components/Button.tsx (reverted)"]);
    });

    it("does nothing when the confirmation is cancelled", async () => {
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await act(async () => {
        revertChip()?.click();
      });
      const cancel = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-file-change-revert-dialog"] button'),
      ).find((button) => button.textContent === "Cancel");
      await act(async () => {
        cancel?.click();
      });
      expect(document.querySelector('[data-testid="chat-file-change-revert-dialog"]')).toBeNull();
      expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
    });

    it("closes the dialog and returns focus to the card when the change stops being revertable", async () => {
      const props = { files: [fileChange("src/app.ts")], commitRange: gitRange, messageId: "msg-7" };
      await renderCard(props);
      revertChip()?.focus();
      await openRevertDialog();
      expect(dialog()?.getAttribute("data-state")).toBe("ready");

      // A re-probe answers that the space keeps versions the old way.
      versioningState.mode = "legacy";
      await renderCard(props);

      expect(dialog()).toBeNull();
      expect(revertChip()).toBeNull();
      expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(document.body);
      expect(container.contains(document.activeElement)).toBe(true);

      // The same when write access is re-resolving.
      versioningState.mode = "stateless";
      await renderCard(props);
      await openRevertDialog();
      expect(dialog()?.getAttribute("data-state")).toBe("ready");
      projectAccessState.projectCapabilitiesResolved = false;
      await renderCard(props);
      expect(dialog()).toBeNull();
      expect(revertWorkspaceGitCommit).not.toHaveBeenCalled();
      expect(container.contains(document.activeElement)).toBe(true);
    });

    it("offers to ask the agent when later changes conflict", async () => {
      revertWorkspaceGitCommit.mockResolvedValue({
        ok: false,
        conflict: true,
        code: "revert_conflict",
        paths: ["src/app.ts"],
        errorInfo: { status: 409, code: "revert_conflict", message: "conflict", routeUnavailable: false },
      });
      const requests: MessageUndoRequestDetail[] = [];
      const listener = (event: Event) => requests.push((event as CustomEvent<MessageUndoRequestDetail>).detail);
      window.addEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);
      try {
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange, messageId: "msg-7" });
        await confirmRevert();

        expect(showStatus).toHaveBeenCalledTimes(1);
        const [message, intent, , options] = showStatus.mock.calls[0] ?? [];
        expect(message).toBe("Later changes touch the same lines, so this can't be reverted automatically.");
        expect(intent).toBe("warning");
        expect(options?.actionLabel).toBe("Ask the agent to undo it");
        // The files stay as they were.
        expect(revertChip()).not.toBeNull();

        await act(async () => {
          options?.onAction?.();
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.messageId).toBe("msg-7");
      } finally {
        window.removeEventListener(REQUEST_MESSAGE_UNDO_EVENT, listener);
      }
    });

    it("offers no agent action without a message to undo", async () => {
      revertWorkspaceGitCommit.mockResolvedValue({
        ok: false,
        conflict: true,
        code: "revert_conflict",
        errorInfo: { status: 409, code: "revert_conflict", message: "conflict", routeUnavailable: false },
      });
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await confirmRevert();
      expect(showStatus).toHaveBeenCalledWith(
        "Later changes touch the same lines, so this can't be reverted automatically.",
        "warning",
        6500,
        undefined,
      );
    });

    function stillLoading(retryAfterMs: number) {
      return {
        ok: false,
        conflict: false,
        code: "fetch_pending",
        errorInfo: { status: 503, code: "fetch_pending", message: "fetch pending", retryAfterMs, routeUnavailable: false },
      };
    }

    async function waitFor(ms: number) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    }

    it("retries once while the space is still loading, then reverts", async () => {
      revertWorkspaceGitCommit
        .mockResolvedValueOnce(stillLoading(5))
        .mockResolvedValueOnce({ ok: true, rev: "c".repeat(40), committed: true });
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await confirmRevert();
      await waitFor(30);

      expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(2);
      expect(revertWorkspaceGitCommit.mock.calls[1]?.[0]).toEqual(revertWorkspaceGitCommit.mock.calls[0]?.[0]);
      expect(showStatus).toHaveBeenCalledTimes(1);
      expect(showStatus).toHaveBeenCalledWith("Reverted. Saved as a new version.", "success", 4000, undefined);
    });

    function answeredLater(code: string, retryAfterMs: number) {
      return {
        ok: false,
        conflict: false,
        code,
        errorInfo: { status: 503, code, message: "try again in a moment", retryAfterMs, routeUnavailable: false },
      };
    }

    it.each(["writes_busy", "mirror_reset"])("retries %s once, then reverts", async (code) => {
      revertWorkspaceGitCommit
        .mockResolvedValueOnce(answeredLater(code, 5))
        .mockResolvedValueOnce({ ok: true, rev: "c".repeat(40), committed: true });
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await confirmRevert();
      await waitFor(30);

      expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(2);
      expect(revertWorkspaceGitCommit.mock.calls[1]?.[0]).toEqual(revertWorkspaceGitCommit.mock.calls[0]?.[0]);
      expect(showStatus).toHaveBeenCalledTimes(1);
      expect(showStatus).toHaveBeenCalledWith("Reverted. Saved as a new version.", "success", 4000, undefined);
    });

    it.each([
      ["writes_busy", "The server is busy saving other changes. Try again in a moment."],
      ["mirror_reset", "The server is rebuilding its copy of this space. Try again in a moment."],
    ])("names %s when the retry meets it again", async (code, message) => {
      revertWorkspaceGitCommit.mockResolvedValue(answeredLater(code, 5));
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await confirmRevert();
      await waitFor(30);

      expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(2);
      expect(showStatus).toHaveBeenCalledTimes(1);
      expect(showStatus).toHaveBeenCalledWith(message, "warning", 6500, undefined);
      expect(revertChip()).not.toBeNull();
    });

    it("never retries a revert when the space is out of room", async () => {
      revertWorkspaceGitCommit.mockResolvedValue(answeredLater("disk_full", 5));
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await confirmRevert();
      await waitFor(30);

      expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);
      expect(showStatus).toHaveBeenCalledTimes(1);
      expect(showStatus).toHaveBeenCalledWith(
        "The space is out of room right now. Try again later.",
        "error",
        expect.any(Number),
        undefined,
      );
      expect(revertChip()).not.toBeNull();
    });

    it("says the space is still loading when the retry finds it loading too", async () => {
      revertWorkspaceGitCommit.mockResolvedValue(stillLoading(5));
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await confirmRevert();
      await waitFor(30);

      expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(2);
      expect(showStatus).toHaveBeenCalledTimes(1);
      expect(showStatus).toHaveBeenCalledWith(
        "The space is still loading. Try again in a moment.",
        "warning",
        6500,
        undefined,
      );
      expect(revertChip()).not.toBeNull();
    });

    it("marks only files that reached the saved history as reverted", async () => {
      // Even if the version listed them, a file the turn's save left out and
      // a file in a never-saved folder are not undone by a version revert.
      versionTouches("src/app.ts", ".env", "tmp/out.log");
      revertWorkspaceGitCommit.mockResolvedValue({ ok: true, rev: "c".repeat(40), committed: true });
      await renderCard({
        files: [
          fileChange("src/app.ts"),
          { ...fileChange(".env"), notSaved: { reason: "secret" as const, keptSavedVersion: false } },
          { ...fileChange("tmp/out.log"), changeType: "created" as const },
        ],
        commitRange: gitRange,
      });
      expect(container.querySelector('[data-testid="chat-file-change-toggle-files"]')?.textContent).toContain(
        "Edited 3 files · 1 not saved",
      );

      await confirmRevert();

      // The saved file is undone; the secret the save left out and the
      // never-saved tmp/ file are untouched, and .env still says Not saved.
      expect(container.querySelector('[data-testid="chat-file-change-toggle-files"]')?.textContent).toContain(
        "Edited 3 files · 1 reverted · 1 not saved",
      );
      const chipTitles = Array.from(
        container.querySelectorAll<HTMLElement>('[data-testid="chat-file-change-file-chip"]'),
      ).map((chip) => chip.title);
      expect(chipTitles).toEqual(["src/app.ts (reverted)", ".env", "tmp/out.log"]);
      const notSaved = container.querySelectorAll<HTMLElement>('[data-testid="chat-file-change-not-saved-chip"]');
      expect(notSaved).toHaveLength(1);
      expect(notSaved[0]?.textContent).toContain(".env");
      // Review stays for what is left; a second revert could not reach it.
      expect(container.querySelector('[data-testid="chat-file-change-review"]')).not.toBeNull();
      expect(revertChip()).toBeNull();
    });

    describe("keyboard focus after a revert", () => {
      function confirmButton() {
        return document.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-revert-confirm"]');
      }

      async function pressRevertAndConfirm() {
        revertChip()?.focus();
        await act(async () => {
          revertChip()?.click();
        });
        await waitFor(50);
        await act(async () => {
          confirmButton()?.click();
        });
      }

      it("keeps the dialog open and busy while the request runs, then focuses the card", async () => {
        let settle: (value: unknown) => void = () => {};
        revertWorkspaceGitCommit.mockReturnValue(
          new Promise((resolve) => {
            settle = resolve;
          }),
        );
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
        await pressRevertAndConfirm();

        // Focus stays inside the open dialog instead of falling to the page.
        const dialog = document.querySelector('[data-testid="chat-file-change-revert-dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.contains(document.activeElement)).toBe(true);
        expect(confirmButton()?.getAttribute("aria-disabled")).toBe("true");

        await act(async () => {
          settle({ ok: true, rev: "c".repeat(40), committed: true });
        });
        await waitFor(0);

        // The only file is reverted, so the action row is gone: focus lands
        // on the file chip, never on the body.
        expect(document.querySelector('[data-testid="chat-file-change-revert-dialog"]')).toBeNull();
        expect(revertChip()).toBeNull();
        expect(document.activeElement?.getAttribute("data-testid")).toBe("chat-file-change-file-chip");
      });

      it("returns focus to Revert this change when the revert fails", async () => {
        revertWorkspaceGitCommit.mockResolvedValue({
          ok: false,
          conflict: true,
          code: "revert_conflict",
          errorInfo: { status: 409, code: "revert_conflict", message: "conflict", routeUnavailable: false },
        });
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
        await pressRevertAndConfirm();
        await waitFor(0);

        expect(document.querySelector('[data-testid="chat-file-change-revert-dialog"]')).toBeNull();
        expect(document.activeElement).toBe(revertChip());
        expect(revertChip()?.disabled).toBe(false);
      });

      function dialogButton(label: string) {
        return Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-file-change-revert-dialog"] button'),
        ).find((button) => button.textContent === label);
      }

      it("lets the user close the dialog while the revert runs, without cancelling it", async () => {
        let settle: (value: unknown) => void = () => {};
        revertWorkspaceGitCommit.mockReturnValue(
          new Promise((resolve) => {
            settle = resolve;
          }),
        );
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
        await pressRevertAndConfirm();

        // The dialog says what closing it does, and Cancel becomes Close.
        expect(document.querySelector('[data-testid="chat-file-change-revert-scope"]')?.textContent).toBe(
          "Reverting… Closing this doesn't stop it. You'll see the result when it's done.",
        );
        expect(dialogButton("Cancel")).toBeUndefined();
        const close = dialogButton("Close");
        expect(close?.disabled).toBe(false);
        await act(async () => {
          close?.click();
        });

        expect(document.querySelector('[data-testid="chat-file-change-revert-dialog"]')).toBeNull();
        // The chip carries the running revert and keeps focus; pressing it
        // opens nothing and sends nothing.
        expect(revertChip()?.textContent).toBe("Reverting…");
        expect(revertChip()?.getAttribute("aria-disabled")).toBe("true");
        expect(document.activeElement).toBe(revertChip());
        await act(async () => {
          revertChip()?.click();
        });
        expect(document.querySelector('[data-testid="chat-file-change-revert-dialog"]')).toBeNull();
        expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(1);
        expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);
        expect(showStatus).not.toHaveBeenCalled();

        // The request was never cancelled: its result still shows.
        await act(async () => {
          settle({ ok: true, rev: "c".repeat(40), committed: true });
        });
        await waitFor(0);
        expect(showStatus).toHaveBeenCalledWith("Reverted. Saved as a new version.", "success", 4000, undefined);
        expect(container.querySelector('[data-testid="chat-file-change-file-chip"]')?.getAttribute("title")).toBe(
          "src/app.ts (reverted)",
        );
        expect(document.activeElement?.getAttribute("data-testid")).toBe("chat-file-change-file-chip");
      });

      it("closes on Escape while the revert runs", async () => {
        let settle: (value: unknown) => void = () => {};
        revertWorkspaceGitCommit.mockReturnValue(
          new Promise((resolve) => {
            settle = resolve;
          }),
        );
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
        await pressRevertAndConfirm();

        await act(async () => {
          document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(document.querySelector('[data-testid="chat-file-change-revert-dialog"]')).toBeNull();
        expect(revertChip()?.textContent).toBe("Reverting…");
        expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);

        await act(async () => {
          settle({
            ok: false,
            conflict: true,
            code: "revert_conflict",
            errorInfo: { status: 409, code: "revert_conflict", message: "conflict", routeUnavailable: false },
          });
        });
        await waitFor(0);
        expect(showStatus).toHaveBeenCalledWith(
          "Later changes touch the same lines, so this can't be reverted automatically.",
          "warning",
          6500,
          undefined,
        );
        expect(revertChip()?.textContent).toBe("Revert this change");
        expect(revertChip()?.hasAttribute("aria-disabled")).toBe(false);
      });

      it("stops waiting after a while and still shows the answer when it comes", async () => {
        let settle: (value: unknown) => void = () => {};
        revertWorkspaceGitCommit.mockReturnValue(
          new Promise((resolve) => {
            settle = resolve;
          }),
        );
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          revertChip()?.focus();
          await act(async () => {
            revertChip()?.click();
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
          });
          expect(dialog()?.getAttribute("data-state")).toBe("ready");
          await act(async () => {
            confirmButton()?.click();
          });

          await act(async () => {
            await vi.advanceTimersByTimeAsync(REVERT_WAIT_TIMEOUT_MS - 1000);
          });
          expect(dialog()).not.toBeNull();
          expect(showStatus).not.toHaveBeenCalled();

          await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
          });
          // The card stops waiting: the dialog closes, the chip is free again,
          // and the toast says the revert may still finish.
          expect(dialog()).toBeNull();
          expect(showStatus).toHaveBeenCalledTimes(1);
          expect(showStatus).toHaveBeenCalledWith(
            "The revert is taking longer than expected. It may still finish, and you'll see the result when it does.",
            "warning",
            9000,
          );
          expect(revertChip()?.textContent).toBe("Revert this change");
          expect(document.activeElement).toBe(revertChip());

          // The answer arrives later and is still shown.
          await act(async () => {
            settle({ ok: true, rev: "c".repeat(40), committed: true });
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
          });
          expect(showStatus).toHaveBeenCalledTimes(2);
          expect(showStatus).toHaveBeenLastCalledWith("Reverted. Saved as a new version.", "success", 4000, undefined);
          expect(container.querySelector('[data-testid="chat-file-change-file-chip"]')?.getAttribute("title")).toBe(
            "src/app.ts (reverted)",
          );
          expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      // A revert the card stopped waiting for still holds the space's lease,
      // so a second request would only fail against it. Pressing Revert this
      // change again waits for the first one instead.
      function revertStillRunning() {
        let settle: (value: unknown) => void = () => {};
        revertWorkspaceGitCommit.mockReturnValueOnce(
          new Promise((resolve) => {
            settle = resolve;
          }),
        );
        revertWorkspaceGitCommit.mockResolvedValue({
          ok: false,
          conflict: false,
          code: "lease_conflict",
          error: "lease conflict",
          errorInfo: { status: 409, code: "lease_conflict", message: "lease conflict", routeUnavailable: false },
        });
        return (value: unknown) => settle(value);
      }

      async function revertUntilTheCardStopsWaiting() {
        await act(async () => {
          revertChip()?.click();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });
        await act(async () => {
          confirmButton()?.click();
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(REVERT_WAIT_TIMEOUT_MS);
        });
        expect(dialog()).toBeNull();
        expect(showStatus).toHaveBeenCalledTimes(1);
        expect(revertChip()?.textContent).toBe("Revert this change");
      }

      function scopeText() {
        return document.querySelector('[data-testid="chat-file-change-revert-scope"]')?.textContent;
      }

      it("waits for a revert it stopped waiting for instead of sending another, and shows its answer", async () => {
        const settle = revertStillRunning();
        const commits: Event[] = [];
        const onCommit = (event: Event) => commits.push(event);
        window.addEventListener("instafy:workspace-commit", onCommit);
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          await revertUntilTheCardStopsWaiting();

          // Pressed again while the first request still runs: the dialog
          // waits for it and says so. It checks nothing and sends nothing.
          await act(async () => {
            revertChip()?.click();
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
          });
          expect(dialog()).not.toBeNull();
          expect(scopeText()).toBe(
            "Your earlier revert of this change is still running. Closing this doesn't stop it. You'll see the result when it's done.",
          );
          expect(dialogButton("Close")?.disabled).toBe(false);
          expect(confirmButton()?.getAttribute("aria-disabled")).toBe("true");
          expect(revertChip()?.textContent).toBe("Reverting…");
          await act(async () => {
            confirmButton()?.click();
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
          });
          expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(1);
          expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);

          // The first request saves the revert: the card says so once,
          // marks the file and tells the space a version was saved.
          await act(async () => {
            settle({ ok: true, rev: "c".repeat(40), committed: true });
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
          });
          expect(showStatus).toHaveBeenCalledTimes(2);
          expect(showStatus).toHaveBeenLastCalledWith("Reverted. Saved as a new version.", "success", 4000, undefined);
          expect(container.querySelector('[data-testid="chat-file-change-file-chip"]')?.getAttribute("title")).toBe(
            "src/app.ts (reverted)",
          );
          expect(commits).toHaveLength(1);
          expect(dialog()).toBeNull();
          expect(revertChip()).toBeNull();
          expect(document.activeElement?.getAttribute("data-testid")).toBe("chat-file-change-file-chip");
          expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
          window.removeEventListener("instafy:workspace-commit", onCommit);
        }
      });

      it("stops waiting again after a while, and still shows the first revert's answer", async () => {
        const settle = revertStillRunning();
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          await revertUntilTheCardStopsWaiting();

          await act(async () => {
            revertChip()?.click();
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
          });
          await act(async () => {
            dialogButton("Close")?.click();
          });
          expect(dialog()).toBeNull();
          expect(revertChip()?.textContent).toBe("Reverting…");
          expect(revertChip()?.getAttribute("aria-disabled")).toBe("true");

          // The card stops waiting a second time and frees the chip again.
          await act(async () => {
            await vi.advanceTimersByTimeAsync(REVERT_WAIT_TIMEOUT_MS);
          });
          expect(showStatus).toHaveBeenCalledTimes(2);
          expect(showStatus).toHaveBeenLastCalledWith(
            "The revert is taking longer than expected. It may still finish, and you'll see the result when it does.",
            "warning",
            9000,
          );
          expect(revertChip()?.textContent).toBe("Revert this change");
          expect(revertChip()?.hasAttribute("aria-disabled")).toBe(false);
          expect(document.activeElement).toBe(revertChip());

          await act(async () => {
            settle({ ok: true, rev: "c".repeat(40), committed: true });
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
          });
          expect(showStatus).toHaveBeenCalledTimes(3);
          expect(showStatus).toHaveBeenLastCalledWith("Reverted. Saved as a new version.", "success", 4000, undefined);
          expect(container.querySelector('[data-testid="chat-file-change-file-chip"]')?.getAttribute("title")).toBe(
            "src/app.ts (reverted)",
          );
          expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(1);
          expect(revertWorkspaceGitCommit).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("checks and reverts as usual once a revert it stopped waiting for has answered", async () => {
        const settle = revertStillRunning();
        await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          await revertUntilTheCardStopsWaiting();
          await act(async () => {
            settle({
              ok: false,
              conflict: true,
              code: "revert_conflict",
              errorInfo: { status: 409, code: "revert_conflict", message: "conflict", routeUnavailable: false },
            });
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
          });
          expect(showStatus).toHaveBeenLastCalledWith(
            "Later changes touch the same lines, so this can't be reverted automatically.",
            "warning",
            6500,
            undefined,
          );

          // Nothing runs any more: the dialog checks the version again and
          // offers Revert.
          await act(async () => {
            revertChip()?.click();
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
          });
          expect(dialog()?.getAttribute("data-state")).toBe("ready");
          expect(scopeText()).toBe("A new version that undoes it is saved on top. Nothing is removed from history.");
          expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledTimes(2);
          expect(confirmButton()?.hasAttribute("aria-disabled")).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it("focuses the summary toggle when every file of a larger change was reverted", async () => {
        versionTouches("src/app.ts", "src/util.ts");
        revertWorkspaceGitCommit.mockResolvedValue({ ok: true, rev: "c".repeat(40), committed: true });
        await renderCard({
          files: [fileChange("src/app.ts"), fileChange("src/util.ts")],
          commitRange: gitRange,
        });
        await pressRevertAndConfirm();
        await waitFor(0);

        expect(document.activeElement?.getAttribute("data-testid")).toBe("chat-file-change-toggle-files");
      });
    });

    it("leaves the files as they were when there was nothing to revert", async () => {
      revertWorkspaceGitCommit.mockResolvedValue({ ok: true, rev: head, committed: false });
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await confirmRevert();
      expect(showStatus).toHaveBeenCalledWith(
        "Nothing to revert. Those changes are already undone.",
        "info",
        4000,
        undefined,
      );
      expect(revertChip()).not.toBeNull();
    });

    it("reverts on a Desktop origin too", async () => {
      versioningState.mode = "desktop";
      versioningState.originId = "desktop-origin";
      revertWorkspaceGitCommit.mockResolvedValue({ ok: true, rev: "c".repeat(40) });
      await renderCard({ files: [fileChange("src/app.ts")], commitRange: gitRange });
      await confirmRevert();
      expect(revertWorkspaceGitCommit).toHaveBeenCalledWith(
        expect.objectContaining({ originId: "desktop-origin", routing: "default", commit: head }),
      );
      expect(revertWorkspaceGitCommit.mock.calls[0]?.[0]).not.toHaveProperty("base");
      expect(fetchWorkspaceGitHistoryReview).toHaveBeenCalledWith(
        expect.objectContaining({ originId: "desktop-origin", routing: "default", commit: head }),
      );
      expect(container.querySelector('[data-testid="chat-file-change-file-chip"]')?.textContent).toContain(
        "(reverted)",
      );
    });
  });
});
