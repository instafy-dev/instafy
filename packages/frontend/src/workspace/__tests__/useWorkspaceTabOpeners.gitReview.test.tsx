// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceGitReviewSource } from "../gitReviewTypes";
import type { WorkspaceTabState } from "../workspaceTabFactories";
import { useWorkspaceTabOpeners } from "../useWorkspaceTabOpeners";

type Openers = ReturnType<typeof useWorkspaceTabOpeners>;

function unsavedWork(ref: string, title: string): WorkspaceGitReviewSource {
  return {
    kind: "unsavedWork",
    ref,
    rev: "a".repeat(40),
    base: null,
    title,
    date: null,
    entries: [{ path: "a.txt", code: "" }],
    originId: "origin-1",
  };
}

describe("openGitReviewTab with unsaved work", () => {
  let container: HTMLDivElement;
  let root: Root;
  let openers: Openers | null = null;
  let tabs: WorkspaceTabState[] = [];
  let active: WorkspaceTabState | null = null;

  function Harness({ conversationId = null, userId = null, projectId = "project-1" }: {
    conversationId?: string | null; userId?: string | null; projectId?: string;
  }) {
    const tabsRef = useRef<WorkspaceTabState[]>([]);
    const activeTabIdRef = useRef<string | null>(null);
    const persistedRef = useRef(null);
    openers = useWorkspaceTabOpeners({
      activeConversationId: conversationId,
      conversationWorkspaceUserId: userId,
      conversations: [],
      createConversation: vi.fn(),
      workspaceProjectId: projectId,
      tabsRef,
      activeTabIdRef,
      persistedGitReviewStateRef: persistedRef,
      commitTabs: (next) => {
        tabsRef.current = next;
        tabs = next;
      },
      setActiveTabInternal: (tab) => {
        activeTabIdRef.current = tab.id;
        active = tab;
      },
      ensureTabForPanel: vi.fn(),
    });
    return null;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    tabs = [];
    active = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps one review tab per ref and refreshes it in place", () => {
    act(() => openers?.openGitReviewTab(unsavedWork("refs/instafy/recovery/o/a", "First")));
    act(() => openers?.openGitReviewTab(unsavedWork("refs/instafy/recovery/o/b", "Second")));
    act(() => openers?.openGitReviewTab(unsavedWork("refs/instafy/recovery/o/a", "First again")));

    expect(tabs).toHaveLength(2);
    expect(active?.title).toBe("First again");
    expect(tabs[0]?.id).toBe(active?.id);
  });

  it("keeps the same unsaved ref scoped to its conversation, space and account", async () => {
    const ref = "refs/instafy/recovery/o/a";
    const scopes = [
      { userId: "user-a", projectId: "project-1", conversationId: "chat-a" },
      { userId: "user-a", projectId: "project-1", conversationId: "chat-b" },
      { userId: "user-a", projectId: "project-2", conversationId: "chat-a" },
      { userId: "user-b", projectId: "project-1", conversationId: "chat-a" },
    ];
    for (const scope of scopes) {
      await act(async () => root.render(<Harness {...scope} />));
      act(() => openers?.openGitReviewTab(unsavedWork(ref, "Kept work")));
      expect(active?.workspaceOwner).toEqual(scope);
    }
    expect(tabs).toHaveLength(4);
    const firstId = tabs[0]?.id;
    await act(async () => root.render(<Harness {...scopes[0]} />));
    act(() => openers?.openGitReviewTab(unsavedWork(ref, "Refreshed work")));
    expect(tabs).toHaveLength(4);
    expect(active?.id).toBe(firstId);
    expect(active?.title).toBe("Refreshed work");
    expect(tabs[1]?.title).toBe("Kept work");
  });

});
