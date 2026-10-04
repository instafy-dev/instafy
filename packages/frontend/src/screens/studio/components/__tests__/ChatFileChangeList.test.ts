// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchWorkspaceGitDiff,
  revertWorkspaceGitPaths,
  readWorkspaceFile,
  openPanelTab,
  requestUrlPush,
  openGitDiffTab,
  showStatus,
  projectAccessState,
  runtimeState,
  versioningState,
} = vi.hoisted(() => ({
  fetchWorkspaceGitDiff: vi.fn(),
  revertWorkspaceGitPaths: vi.fn(),
  readWorkspaceFile: vi.fn(),
  openPanelTab: vi.fn(),
  requestUrlPush: vi.fn(),
  openGitDiffTab: vi.fn(),
  showStatus: vi.fn(),
  projectAccessState: {
    projectCapabilitiesResolved: true,
    canWriteProject: true,
  },
  runtimeState: { effectiveRuntimeId: null as string | null, runtimeReady: false },
  versioningState: {
    mode: "legacy" as "legacy" | "stateless" | "desktop",
    recovery: "unknown" as "unknown" | "supported" | "unsupported",
    originId: null as string | null,
  },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: {
        read: readWorkspaceFile,
      },
      git: {
        fetchDiff: fetchWorkspaceGitDiff,
        revertPaths: revertWorkspaceGitPaths,
      },
    },
  },
}));

vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({
    effectiveRuntimeId: runtimeState.effectiveRuntimeId,
    runtimeReady: runtimeState.runtimeReady,
  }),
}));

vi.mock("../../../../workspace/useWorkspaceVersioning", () => ({
  useWorkspaceVersioning: () => ({ ...versioningState, resolved: versioningState.mode !== "legacy" }),
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

import { ChatFileChangeList, resolveUniqueChatFileChanges } from "../ChatFileChangeList";
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
    revertWorkspaceGitPaths.mockReset();
    readWorkspaceFile.mockReset();
    openPanelTab.mockReset();
    requestUrlPush.mockReset();
    openGitDiffTab.mockReset();
    showStatus.mockReset();
    projectAccessState.projectCapabilitiesResolved = true;
    projectAccessState.canWriteProject = true;
    runtimeState.effectiveRuntimeId = null;
    runtimeState.runtimeReady = false;
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

  it("explains a save that did not run with the same words as a failed one", async () => {
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
    expect(state?.getAttribute("title")).toBe(
      "These changes weren't saved to the space yet. The agent saves them at its next turn, and anything left over is kept as unsaved work.",
    );
    expect(state?.getAttribute("title")).not.toMatch(/auto-save|save a version|\u2014/i);
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
    expect(chips[0]?.title).toBe("Secret files stay out of the space. Use Secrets for these values.");
    expect(chips[1]?.title).toBe(
      "Larger than 20 MB, so it isn't saved to the space. The saved version is unchanged.",
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
    expect(notes[0]?.textContent).toBe(".env: Secret files stay out of the space. Use Secrets for these values.");
    expect(notes[1]?.classList.contains("sr-only")).toBe(true);
    expect(notes[0]?.parentElement?.getAttribute("data-testid")).toBe("chat-file-change-summary");
    expect(container.textContent).not.toMatch(/\u2014/);
  });

  it("words every reason a save can leave a file out for", async () => {
    const reasons = [
      ["excluded", "Build output, dependency and cache folders aren't saved to the space."],
      ["ignored", "This file matches .gitignore, so it isn't saved to the space."],
      ["attachment", "Old chat upload files aren't saved to the space."],
      ["policy", "This space's file rules refused this file."],
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
});
