import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationState } from "../../conversations/ConversationsProvider";
import {
  createGitReviewTab,
  createTabForConversation,
  formatUnreadBadge,
  normalizeExplorerPath,
} from "../workspaceTabFactories";
import {
  loadPersistedWorkspaceGitReviews,
  loadPersistedWorkspaceTabs,
  persistWorkspaceGitReviewState,
  persistWorkspaceTabsState,
} from "../workspaceTabPersistence";
import {
  consumeWorkspaceUrlNavigation,
  consumeWorkspaceUrlPush,
  requestWorkspaceUrlNavigation,
} from "../workspaceTabUrlIntents";

function createConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    localId: "conversation-1",
    title: "Conversation 1",
    visibility: "private",
    lifecycleStatus: "active",
    controllerId: null,
    parentConversationId: null,
    threadKind: null,
    ownerAgent: null,
    originMessageId: null,
    delegatedByAgentId: null,
    messages: [],
    draft: "",
    draftEditorState: null,
    assistantEnabled: true,
    extraAgentHandles: [],
    unreadCount: 0,
    createdAt: 1,
    pendingRunIds: [],
    awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {},
    runtimePreference: null,
    ...overrides,
    activeGoal: overrides.activeGoal ?? null,
  };
}

function createSessionStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

describe("workspaceTab helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: createSessionStorageMock(),
      sessionStorage: createSessionStorageMock(),
    });
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deduplicates persisted conversation tabs and preserves the active tab", () => {
    persistWorkspaceTabsState({
      projects: {
        "project-1": {
          conversations: ["conversation-1", "conversation-1", "conversation-2"],
          activeConversationId: "conversation-2",
        },
      },
    });

    expect(loadPersistedWorkspaceTabs()).toEqual({
      projects: {
        "project-1": {
          conversations: ["conversation-1", "conversation-2"],
          activeConversationId: "conversation-2",
        },
      },
    });
  });

  it("persists git review tabs and exposes URL navigation consumption helpers", () => {
    persistWorkspaceGitReviewState({
      projects: {
        "project-1": {
          tabs: [
            {
              id: "workspace-git-review-1",
              review: {
                kind: "savedVersion",
                commit: "abc123456789",
                shortCommit: "abc123",
                title: "Saved version",
                committedAt: "2026-04-21T00:00:00.000Z",
              },
              returnTabId: "workspace-tab-chat",
            },
          ],
        },
      },
    });

    expect(loadPersistedWorkspaceGitReviews()).toEqual({
      projects: {
        "project-1": {
          tabs: [
            {
              id: "workspace-git-review-1",
              review: {
                kind: "savedVersion",
                commit: "abc123456789",
                shortCommit: "abc123",
                title: "Saved version",
                committedAt: "2026-04-21T00:00:00.000Z",
              },
              returnTabId: "workspace-tab-chat",
            },
          ],
        },
      },
    });

    expect(requestWorkspaceUrlNavigation()).toBe("push");
    expect(requestWorkspaceUrlNavigation("replace")).toBe("replace");
    expect(consumeWorkspaceUrlNavigation("replace")).toEqual({
      mode: "replace",
      nextMode: null,
    });
    expect(consumeWorkspaceUrlPush("push")).toEqual({
      pushed: true,
      nextMode: null,
    });
  });

  it("restores preview ownership only for a chat in the same saved tab set", () => {
    persistWorkspaceTabsState({ projects: {
      first: { conversations: ["a", "b"], previewConversationId: "b" },
      second: { conversations: ["x"], previewConversationId: "b" },
    } });
    const restored = loadPersistedWorkspaceTabs();
    expect(restored?.projects.first.previewConversationId).toBe("b");
    expect(restored?.projects.second.previewConversationId).toBeUndefined();
  });

  it("creates conversation and git review tabs with stable derived state", () => {
    const conversationTab = createTabForConversation(
      createConversation({
        localId: "conversation-99",
        title: "Private thread",
        unreadCount: 12,
      }),
    );

    expect(conversationTab.id).toBe("workspace-conversation-conversation-99");
    expect(conversationTab.badge).toBe("9+");
    expect(formatUnreadBadge(0)).toBeNull();
    expect(normalizeExplorerPath("\\docs\\guides/")).toBe("docs/guides");

    const gitReviewTab = createGitReviewTab(
      {
        kind: "savedVersion",
        commit: "abc123456789",
        shortCommit: "abc123",
        title: "Saved version",
        committedAt: "2026-04-21T00:00:00.000Z",
      },
      "workspace-tab-chat",
      { id: "workspace-git-review-4" },
    );
    const nextGitReviewTab = createGitReviewTab(
      { kind: "workingTree", title: "Review pending changes", entries: [] },
      null,
    );

    expect(gitReviewTab.title).toBe("Review abc123");
    expect(nextGitReviewTab.id).toBe("workspace-git-review-5");
    expect(nextGitReviewTab.title).toBe("Review pending changes");
  });
});
