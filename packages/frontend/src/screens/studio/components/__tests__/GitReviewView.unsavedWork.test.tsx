// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceGitReviewSource } from "../../../../workspace/gitReviewTypes";

const mocks = vi.hoisted(() => ({
  fetchDiff: vi.fn(),
  fetchHistoryReview: vi.fn(),
  openPanelTab: vi.fn(),
}));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({ activeProjectId: "project-1" }),
}));
vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ effectiveRuntimeId: "runtime-1" }),
}));
vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: vi.fn() }),
}));
vi.mock("../../../../hooks/useBreakpoint", () => ({
  useBreakpoint: () => true,
}));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openPanelTab: mocks.openPanelTab, requestUrlPush: vi.fn() }),
}));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      git: {
        fetchDiff: mocks.fetchDiff,
        fetchHistoryReview: mocks.fetchHistoryReview,
      },
    },
  },
}));

import { GitReviewView } from "../GitReviewView";

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

const REF = "refs/instafy/recovery/11111111-2222-3333-4444-555555555555/run-1";
const REV = "a".repeat(40);
const BASE = "b".repeat(40);

describe("GitReviewView: unsaved work and pinned saved versions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchDiff.mockResolvedValue({ supported: true, path: "src/a.ts", diff: "", error: null });
    mocks.fetchHistoryReview.mockResolvedValue({
      supported: true,
      commit: REV,
      entries: [{ path: "src/a.ts", code: "M" }],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("diffs unsaved work base..rev at the ref on the pinned origin, read-only", async () => {
    const review: WorkspaceGitReviewSource = {
      kind: "unsavedWork",
      ref: REF,
      rev: REV,
      base: BASE,
      title: "Agent work that couldn't be saved",
      date: new Date().toISOString(),
      entries: [{ path: "src/a.ts", code: "" }],
      originId: "origin-1",
      initialMode: "focused",
    };
    await act(async () => root.render(<GitReviewView review={review} />));
    await flush();

    expect(container.querySelector('[data-testid="git-review-title"]')?.textContent).toBe(
      "Agent work that couldn't be saved",
    );
    expect(container.textContent).toContain("Unsaved work");
    expect(mocks.fetchHistoryReview).not.toHaveBeenCalled();
    expect(mocks.fetchDiff).toHaveBeenCalledWith({
      projectId: "project-1",
      runtimeId: "runtime-1",
      path: "src/a.ts",
      commit: REV,
      base: BASE,
      routing: "default",
      originId: "origin-1",
      ref: REF,
    });
    // No editor opens from unsaved work.
    expect(container.querySelector('[data-testid="git-review-diff-open-file"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Open "]')).toBeNull();
  });

  it("reads a History saved version from the pinned default origin", async () => {
    const review: WorkspaceGitReviewSource = {
      kind: "savedVersion",
      commit: REV,
      shortCommit: REV.slice(0, 8),
      title: "Update src/a.ts",
      committedAt: new Date().toISOString(),
      routing: "default",
      originId: "origin-1",
      initialMode: "focused",
    };
    await act(async () => root.render(<GitReviewView review={review} />));
    await flush();

    expect(mocks.fetchHistoryReview).toHaveBeenCalledWith({
      projectId: "project-1",
      runtimeId: "runtime-1",
      commit: REV,
      routing: "default",
      originId: "origin-1",
    });
    expect(mocks.fetchDiff).toHaveBeenCalledWith(
      expect.objectContaining({ commit: REV, routing: "default", originId: "origin-1", ref: null }),
    );
  });

  it("keeps a legacy saved version request exactly as before", async () => {
    const review: WorkspaceGitReviewSource = {
      kind: "savedVersion",
      commit: REV,
      shortCommit: REV.slice(0, 8),
      title: "Saved version",
      committedAt: new Date().toISOString(),
      initialMode: "focused",
    };
    await act(async () => root.render(<GitReviewView review={review} />));
    await flush();

    expect(mocks.fetchHistoryReview).toHaveBeenCalledWith({
      projectId: "project-1",
      runtimeId: "runtime-1",
      commit: REV,
    });
    expect(mocks.fetchDiff).toHaveBeenCalledWith({
      projectId: "project-1",
      runtimeId: "runtime-1",
      path: "src/a.ts",
      commit: REV,
      base: null,
    });
  });
});
