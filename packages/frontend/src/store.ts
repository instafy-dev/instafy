import { normalizeSpaceAvatarUrl, normalizeSpaceIcon, normalizeSpaceColor, type ProjectIdentity } from "@instafy/sdk/project-identity";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { DEFAULT_PROJECT_AI_MODEL } from "./ai/modelDefaults";
import type {
  ProjectMetadata,
  ProjectOrgInfo,
  SiteBuilderState
} from "./types";
import { createDefaultCodeWorkspace } from "./code/defaults";
import { createDefaultBillingState } from "./credits/defaults";
import { writePendingProjectSwitch } from "./screens/pendingProjectSwitch";
import { forgetWorkspaceTabsForProjects, rememberWorkspaceTabsForProject } from "./workspace/workspaceTabPersistence";
import { isUUID } from "./utils/uuid";
import { studioPerformance } from "./telemetry/studioPerformance";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hydrateProjectState(state: SiteBuilderState): SiteBuilderState {
  const hydrated = clone(state);
  hydrated.billing = {
    ...createDefaultBillingState(),
    ...(hydrated.billing ?? {}),
    subscription: hydrated.billing?.subscription ?? null
  };
  return hydrated;
}

const WORKSPACE_STORAGE_BASE_KEY = "instafy.workspace";
const WORKSPACE_SCOPE_STORAGE_KEY = `${WORKSPACE_STORAGE_BASE_KEY}.scope`;
const WORKSPACE_STORAGE_PREFIX = `${WORKSPACE_STORAGE_BASE_KEY}.user`;
const DEFAULT_WORKSPACE_SCOPE = "anonymous";

function getWorkspaceStorageKey(scope: string): string {
  return `${WORKSPACE_STORAGE_PREFIX}:${scope}`;
}

function loadWorkspaceScope(): string {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return DEFAULT_WORKSPACE_SCOPE;
    }
    const raw = window.localStorage.getItem(WORKSPACE_SCOPE_STORAGE_KEY);
    const trimmed = raw?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : DEFAULT_WORKSPACE_SCOPE;
  } catch {
    return DEFAULT_WORKSPACE_SCOPE;
  }
}

function persistWorkspaceScope(scope: string) {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    window.localStorage.setItem(WORKSPACE_SCOPE_STORAGE_KEY, scope);
  } catch {
    // ignore storage failures
  }
}

function loadWorkspaceSnapshot(
  scope: string,
):
  | { projects: Record<string, SiteBuilderState>; activeProjectId: string }
  | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    const raw = window.localStorage.getItem(getWorkspaceStorageKey(scope));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      projects?: Record<string, SiteBuilderState>;
      activeProjectId?: string;
    } | null;
    if (!parsed || !parsed.projects) {
      return null;
    }
    return {
      projects: parsed.projects,
      activeProjectId: parsed.activeProjectId ?? ""
    };
  } catch {
    return null;
  }
}

function persistWorkspaceSnapshot(
  scope: string,
  projects: Record<string, SiteBuilderState>,
  activeProjectId: string,
) {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    window.localStorage.setItem(
      getWorkspaceStorageKey(scope),
      JSON.stringify({ projects, activeProjectId })
    );
  } catch {
    // ignore storage failures
  }
}

interface CreateProjectOptions {
  templateId?: string;
  projectName?: string;
  projectId?: string;
  orgId?: string | null;
  orgName?: string | null;
  tags?: string[];
}

export interface RemoveProjectOptions {
  /**
   * Removing the open space opens another one this browser knows, unless this
   * is false. A tab whose URL still names a space it cannot open shows that
   * notice with no space open: another space's files and chats would appear
   * behind it, as if they were the missing space's.
   */
  openFallback?: boolean;
  /**
   * The space is confirmed deleted, so its saved workspace tabs go too. Off
   * by default: a space also leaves the store when its access check gets a
   * 401, 403 or 404, and a 401 can be a token refresh in flight, so that
   * removal must not erase the tabs of a space that is still there.
   */
  forgetSavedTabs?: boolean;
}

export type RemoveProjectsByOrgIdOptions = Pick<RemoveProjectOptions, "forgetSavedTabs">;

export interface SessionStore {
  state: SiteBuilderState;
  projects: Record<string, SiteBuilderState>;
  activeProjectId: string;
  workspaceScope: string;
  setWorkspaceScope: (scope: string) => void;
  updateCode: (updater: (code: SiteBuilderState["code"]) => SiteBuilderState["code"]) => void;
  /**
   * Update the code of a space that is not the open one (a save that finished
   * after the user switched spaces). The open space's code belongs to its
   * CodeProvider, which writes it through `updateCode`.
   */
  updateProjectCode: (
    projectId: string,
    updater: (code: SiteBuilderState["code"]) => SiteBuilderState["code"],
  ) => void;
  updateBilling: (updater: (billing: SiteBuilderState["billing"]) => SiteBuilderState["billing"]) => void;
  createProject: (options?: CreateProjectOptions) => string;
  switchProject: (projectId: string) => void;
  setProjectOrg: (projectId: string, org: ProjectOrgInfo) => void;
  setProjectName: (projectId: string, name: string) => void;
  setProjectIdentity: (projectId: string, identity: ProjectIdentity) => void;
  removeProject: (projectId: string, options?: RemoveProjectOptions) => void;
  removeProjectsByOrgId: (orgId: string, options?: RemoveProjectsByOrgIdOptions) => void;
  reset: () => void;
}


const baseMetadata: ProjectMetadata = {
  projectType: "general",
  // An unnamed space stays unnamed here; spaceDisplayName supplies the words.
  projectName: "",
  prompt: "",
  goal: "",
  targetAudience: "",
  tone: "",
  aiModel: DEFAULT_PROJECT_AI_MODEL,
  tags: []
};

function createProjectState(options?: {
  projectName?: string;
  tags?: string[];
  orgId?: string | null;
  orgName?: string | null;
}): SiteBuilderState {
  const metadata: ProjectMetadata = {
    ...baseMetadata,
    projectName: options?.projectName ?? baseMetadata.projectName,
    tags: options?.tags ?? baseMetadata.tags
  };

  return {
    metadata,
    code: createDefaultCodeWorkspace(),
    billing: createDefaultBillingState(),
    org: {
      id: options?.orgId ?? null,
      name: options?.orgName ?? null
    }
  };
}

const initialWorkspaceScope = loadWorkspaceScope();
const snapshot = loadWorkspaceSnapshot(initialWorkspaceScope);
const initialProjects: Record<string, SiteBuilderState> = snapshot?.projects
  ? Object.fromEntries(
      Object.entries(snapshot.projects).map(([projectId, project]) => [
        projectId,
        hydrateProjectState(project)
      ])
    )
  : {};
const initialActiveProjectId = snapshot?.activeProjectId ?? "";
const initialProjectState =
  snapshot?.activeProjectId && snapshot.projects?.[snapshot.activeProjectId]
    ? hydrateProjectState(snapshot.projects[snapshot.activeProjectId])
    : createProjectState();

export const useWorkspaceStore = create<SessionStore>()(
  subscribeWithSelector<SessionStore>((set, get) => ({
  state: initialProjectState,
  projects: initialProjects,
  activeProjectId: initialActiveProjectId,
  workspaceScope: initialWorkspaceScope,
  setWorkspaceScope: (nextScope) => {
    const scope = nextScope.trim() || DEFAULT_WORKSPACE_SCOPE;
    const store = get();
    if (store.workspaceScope === scope) {
      return;
    }
    persistWorkspaceScope(scope);

    const snapshot = loadWorkspaceSnapshot(scope);
    const nextProjects: Record<string, SiteBuilderState> = snapshot?.projects
      ? Object.fromEntries(
          Object.entries(snapshot.projects).map(([projectId, project]) => [
            projectId,
            hydrateProjectState(project),
          ]),
        )
      : {};
    const nextActiveProjectId = snapshot?.activeProjectId ?? "";
    const nextState =
      snapshot?.activeProjectId && snapshot.projects?.[snapshot.activeProjectId]
        ? hydrateProjectState(snapshot.projects[snapshot.activeProjectId])
        : createProjectState();

    set({
      workspaceScope: scope,
      state: nextState,
      projects: nextProjects,
      activeProjectId: nextActiveProjectId,
    });
  },
  updateCode: (updater) => {
    const store = get();
    const previousState = store.state;
    const nextCode = updater(clone(previousState.code));
    if (JSON.stringify(previousState.code) === JSON.stringify(nextCode)) {
      return;
    }
    const nextState: SiteBuilderState = {
      ...previousState,
      code: nextCode
    };
    set({
      state: nextState,
      projects: {
        ...store.projects,
        [store.activeProjectId]: clone(nextState)
      }
    });
  },
  updateProjectCode: (projectId, updater) => {
    const store = get();
    const project = store.projects[projectId];
    if (!project || projectId === store.activeProjectId) {
      return;
    }
    const nextCode = updater(clone(project.code));
    if (JSON.stringify(project.code) === JSON.stringify(nextCode)) {
      return;
    }
    set({
      projects: {
        ...store.projects,
        [projectId]: clone({ ...project, code: nextCode })
      }
    });
  },
  updateBilling: (updater) => {
    const store = get();
    const previousState = store.state;
    const nextBilling = updater(clone(previousState.billing));
    if (JSON.stringify(previousState.billing) === JSON.stringify(nextBilling)) {
      return;
    }
    const nextState: SiteBuilderState = {
      ...previousState,
      billing: nextBilling
    };
    set({
      state: nextState,
      projects: {
        ...store.projects,
        [store.activeProjectId]: clone(nextState)
      }
    });
  },
  createProject: (options) => {
    const projectName = options?.projectName?.trim() ?? "";
    const tags = options?.tags;
    const newState = createProjectState({
      projectName,
      tags,
      orgId: options?.orgId ?? null,
      orgName: options?.orgName ?? null
    });
    const projectId =
      options?.projectId && isUUID(options.projectId)
        ? options.projectId
        : null;
    if (!projectId) {
      throw new Error("createProject requires a valid projectId");
    }
    writePendingProjectSwitch(projectId);
    rememberWorkspaceTabsForProject(projectId);
    set((store) => {
      const nextProjects = {
        ...store.projects,
        [projectId]: clone(newState)
      };
      return {
        state: newState,
        projects: nextProjects,
        activeProjectId: projectId
      };
    });
    return projectId;
  },
  switchProject: (projectId) => {
    const store = get();
    const project = store.projects[projectId];
    if (!project) {
      return;
    }
    if (projectId !== store.activeProjectId) {
      studioPerformance.beginProject(projectId, project.org?.id ?? null, store.state.org?.id ?? null);
    }
    writePendingProjectSwitch(projectId);
    set({
      state: clone(project),
      activeProjectId: projectId
    });
  },
  setProjectOrg: (projectId, org) => {
    const store = get();
    const project = store.projects[projectId];
    if (!project) {
      return;
    }
    if (
      (project.org?.id ?? null) === (org.id ?? null) &&
      (project.org?.name ?? null) === (org.name ?? null)
    ) {
      return;
    }
    const nextProject: SiteBuilderState = {
      ...project,
      org: {
        id: org.id ?? null,
        name: org.name ?? null
      }
    };
    const nextProjects = {
      ...store.projects,
      [projectId]: clone(nextProject)
    };
    const nextState =
      projectId === store.activeProjectId
        ? clone(nextProject)
        : store.state;
    set({
      projects: nextProjects,
      state: nextState
    });
  },
  setProjectName: (projectId, name) => {
    const store = get();
    const project = store.projects[projectId];
    if (!project) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    if (project.metadata.projectName === trimmed) {
      return;
    }
    const nextProject: SiteBuilderState = {
      ...project,
      metadata: {
        ...project.metadata,
        projectName: trimmed
      }
    };
    const nextProjects = {
      ...store.projects,
      [projectId]: clone(nextProject)
    };
    const nextState =
      projectId === store.activeProjectId
        ? clone(nextProject)
        : store.state;
    set({
      projects: nextProjects,
      state: nextState
    });
  },
  setProjectIdentity: (projectId, identity) => {
    const store = get();
    const project = store.projects[projectId];
    if (!project) return;
    const projectIcon = identity.projectIcon === undefined ? project.metadata.projectIcon : normalizeSpaceIcon(identity.projectIcon);
    const projectColor = identity.projectColor === undefined ? project.metadata.projectColor : normalizeSpaceColor(identity.projectColor);
    const projectAvatarUrl = identity.projectAvatarUrl === undefined ? project.metadata.projectAvatarUrl : normalizeSpaceAvatarUrl(identity.projectAvatarUrl);
    if (project.metadata.projectIcon === projectIcon && project.metadata.projectColor === projectColor && project.metadata.projectAvatarUrl === projectAvatarUrl) return;
    const nextProject = { ...project, metadata: { ...project.metadata, projectIcon, projectColor, projectAvatarUrl } };
    set({
      projects: { ...store.projects, [projectId]: clone(nextProject) },
      state: projectId === store.activeProjectId ? clone(nextProject) : store.state,
    });
  },
  removeProject: (projectId, options) => {
    const trimmed = projectId.trim();
    if (!trimmed) {
      return;
    }
    set((store) => {
      if (!store.projects[trimmed]) {
        return {};
      }
      const nextProjects = { ...store.projects };
      delete nextProjects[trimmed];

      if (store.activeProjectId !== trimmed) {
        return { projects: nextProjects };
      }

      const fallbackId = options?.openFallback === false ? "" : Object.keys(nextProjects)[0] ?? "";
      if (!fallbackId) {
        return {
          projects: nextProjects,
          activeProjectId: "",
          state: createProjectState(),
        };
      }
      return {
        projects: nextProjects,
        activeProjectId: fallbackId,
        state: clone(nextProjects[fallbackId]),
      };
    });
    if (options?.forgetSavedTabs) {
      forgetWorkspaceTabsForProjects([trimmed]);
    }
  },
  removeProjectsByOrgId: (orgId, options) => {
    const trimmed = orgId.trim();
    if (!trimmed) {
      return;
    }
    const removedIds = Object.entries(get().projects)
      .filter(([, project]) => project.org?.id === trimmed)
      .map(([projectId]) => projectId);
    set((store) => {
      const entries = Object.entries(store.projects);
      const nextEntries = entries.filter(([, project]) => project.org?.id !== trimmed);
      if (nextEntries.length === entries.length) {
        return {};
      }
      const nextProjects = Object.fromEntries(nextEntries) as Record<string, SiteBuilderState>;
      if (store.activeProjectId && nextProjects[store.activeProjectId]) {
        return { projects: nextProjects };
      }
      const fallbackId = Object.keys(nextProjects)[0] ?? "";
      if (!fallbackId) {
        return {
          projects: nextProjects,
          activeProjectId: "",
          state: createProjectState(),
        };
      }
      return {
        projects: nextProjects,
        activeProjectId: fallbackId,
        state: clone(nextProjects[fallbackId]),
      };
    });
    if (options?.forgetSavedTabs) {
      forgetWorkspaceTabsForProjects(removedIds);
    }
  },
  reset: () => {
    const resetState = createProjectState();
    const { projects, activeProjectId } = get();
    set({
      state: resetState,
      projects: {
        ...projects,
        [activeProjectId]: clone(resetState)
      }
    });
  }
})));

declare global {
  interface Window {
    __INSTAFY_STORE__?: typeof useWorkspaceStore;
  }
}

if (typeof window !== "undefined") {
  window.__INSTAFY_STORE__ = useWorkspaceStore;

  useWorkspaceStore.subscribe(
    (store) => ({
      scope: store.workspaceScope,
      projects: store.projects,
      activeProjectId: store.activeProjectId,
    }),
    ({ scope, projects, activeProjectId }) =>
      persistWorkspaceSnapshot(scope, projects, activeProjectId),
  );
}
