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
});
