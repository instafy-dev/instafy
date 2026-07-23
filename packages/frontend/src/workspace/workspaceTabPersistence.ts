const WORKSPACE_TABS_STORAGE_KEY = "instafy.workspace.tabs";
const WORKSPACE_GIT_REVIEW_STORAGE_KEY = "instafy.workspace.git-review-tabs";

export interface PersistedWorkspaceProjectState {
  conversations: string[];
  activeConversationId?: string;
}

export interface PersistedWorkspaceTabsState {
  projects: Record<string, PersistedWorkspaceProjectState>;
}

export interface PersistedWorkspaceGitReviewProjectState {
  tabs: {
    id: string;
    review: import("./gitReviewTypes").WorkspaceGitReviewSource;
    returnTabId: string | null;
  }[];
}

export interface PersistedWorkspaceGitReviewState {
  projects: Record<string, PersistedWorkspaceGitReviewProjectState>;
}

export function loadPersistedWorkspaceTabs(): PersistedWorkspaceTabsState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedWorkspaceTabsState;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.projects ||
      typeof parsed.projects !== "object"
    ) {
      return null;
    }
    const projects: Record<string, PersistedWorkspaceProjectState> = {};
    for (const [projectId, value] of Object.entries(parsed.projects)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const rawConversations = Array.isArray(
        (value as PersistedWorkspaceProjectState).conversations,
      )
        ? (value as PersistedWorkspaceProjectState).conversations.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      const conversationSeen = new Set<string>();
      const conversations = rawConversations.filter((id) => {
        if (conversationSeen.has(id)) {
          return false;
        }
        conversationSeen.add(id);
        return true;
      });
      const activeConversationId =
        typeof value.activeConversationId === "string"
          ? value.activeConversationId
          : undefined;
      projects[projectId] = { conversations, activeConversationId };
    }
    return { projects };
  } catch (error) {
    console.warn("[workspace-tabs] failed to load persisted tabs:", error);
    return null;
  }
}

export function persistWorkspaceTabsState(state: PersistedWorkspaceTabsState) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("[workspace-tabs] failed to persist tabs:", error);
  }
}

export function loadPersistedWorkspaceGitReviews(): PersistedWorkspaceGitReviewState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(WORKSPACE_GIT_REVIEW_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedWorkspaceGitReviewState;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.projects ||
      typeof parsed.projects !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch (error) {
    console.warn(
      "[workspace-tabs] failed to load persisted git review tabs:",
      error,
    );
    return null;
  }
}

export function persistWorkspaceGitReviewState(
  state: PersistedWorkspaceGitReviewState,
) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(
      WORKSPACE_GIT_REVIEW_STORAGE_KEY,
      JSON.stringify(state),
    );
  } catch (error) {
    console.warn("[workspace-tabs] failed to persist git review tabs:", error);
  }
}
