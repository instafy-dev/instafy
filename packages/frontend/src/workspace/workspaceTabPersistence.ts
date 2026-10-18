const WORKSPACE_TABS_STORAGE_KEY = "instafy.workspace.tabs";
const WORKSPACE_GIT_REVIEW_STORAGE_KEY = "instafy.workspace.git-review-tabs";

export interface PersistedWorkspaceProjectState {
  conversations: string[];
  activeConversationId?: string;
  previewConversationId?: string;
}

export interface PersistedWorkspaceTabsState {
  projects: Record<string, PersistedWorkspaceProjectState>;
}

export interface PersistedWorkspaceGitReviewProjectState {
  tabs: {
    id: string;
    review: import("./gitReviewTypes").WorkspaceGitReviewSource;
    returnTabId: string | null;
    workspaceOwner?: import("./workspaceTabFactories").ConversationWorkspaceOwner;
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
      const previewConversationId = typeof value.previewConversationId === "string"
        && conversations.includes(value.previewConversationId)
        ? value.previewConversationId
        : undefined;
      projects[projectId] = {
        conversations,
        activeConversationId,
        ...(previewConversationId ? { previewConversationId } : {}),
      };
    }
    return { projects };
  } catch (error) {
    console.warn("[workspace-tabs] failed to load persisted tabs:", error);
    return null;
  }
}

// Spaces confirmed deleted. Their saved tabs are dropped, and later writes
// from every tab of this browser leave them out: a tab strip keeps a copy it
// loaded before the deletion, in this tab or another one, and writing that
// copy back would restore them. The list is stored next to the tabs, so other
// tabs read it too, and keeps the latest DELETED_SPACES_LIMIT ids. A space
// created again in this browser is saved again.
const DELETED_SPACES_STORAGE_KEY = "instafy.workspace.tabs.deleted-spaces";
const DELETED_SPACES_LIMIT = 50;

function loadDeletedSpaceIds(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DELETED_SPACES_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function persistDeletedSpaceIds(projectIds: readonly string[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (projectIds.length === 0) {
      window.localStorage.removeItem(DELETED_SPACES_STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        DELETED_SPACES_STORAGE_KEY,
        JSON.stringify(projectIds.slice(-DELETED_SPACES_LIMIT)),
      );
    }
  } catch (error) {
    console.warn("[workspace-tabs] failed to persist deleted spaces:", error);
  }
}

function withoutProjects(
  projects: PersistedWorkspaceTabsState["projects"],
  projectIds: ReadonlySet<string>,
): PersistedWorkspaceTabsState["projects"] {
  return projectIds.size === 0
    ? projects
    : Object.fromEntries(Object.entries(projects).filter(([projectId]) => !projectIds.has(projectId)));
}

/** Drops the saved tabs of spaces confirmed deleted, here and for later writes. */
export function forgetWorkspaceTabsForProjects(projectIds: readonly string[]) {
  if (projectIds.length === 0) {
    return;
  }
  const deleted = new Set(projectIds);
  persistDeletedSpaceIds([...loadDeletedSpaceIds().filter((projectId) => !deleted.has(projectId)), ...deleted]);
  const persisted = loadPersistedWorkspaceTabs();
  if (persisted && projectIds.some((projectId) => persisted.projects[projectId] !== undefined)) {
    persistWorkspaceTabsState({ ...persisted, projects: withoutProjects(persisted.projects, deleted) });
  }
}

export function rememberWorkspaceTabsForProject(projectId: string) {
  const deletedIds = loadDeletedSpaceIds();
  if (deletedIds.includes(projectId)) {
    persistDeletedSpaceIds(deletedIds.filter((id) => id !== projectId));
  }
}

export function persistWorkspaceTabsState(state: PersistedWorkspaceTabsState) {
  if (typeof window === "undefined") {
    return;
  }
  const projects = withoutProjects(state.projects, new Set(loadDeletedSpaceIds()));
  try {
    window.localStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, JSON.stringify({ ...state, projects }));
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
