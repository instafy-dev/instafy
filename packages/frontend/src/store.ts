import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { DEFAULT_PROJECT_AI_MODEL } from "./ai/modelDefaults";
import type {
  CollaborationSettings,
  ProjectContent,
  ProjectMetadata,
  ProjectOrgInfo,
  SiteBuilderState,
  VersionControlSettings
} from "./types";
import { createDefaultCodeWorkspace } from "./code/defaults";
import { createDefaultBillingState } from "./credits/defaults";
import { writePendingProjectSwitch } from "./screens/pendingProjectSwitch";
import { isUUID } from "./utils/uuid";
import { studioPerformance } from "./telemetry/studioPerformance";

type HistoryEntry = SiteBuilderState;

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

export interface SessionStore {
  state: SiteBuilderState;
  history: HistoryEntry[];
  future: HistoryEntry[];
  projects: Record<string, SiteBuilderState>;
  activeProjectId: string;
  workspaceScope: string;
  setWorkspaceScope: (scope: string) => void;
  updateMetadata: (updater: (metadata: SiteBuilderState["metadata"]) => SiteBuilderState["metadata"]) => void;
  updateContent: (updater: (content: SiteBuilderState["content"]) => SiteBuilderState["content"]) => void;
  updateDeployment: (
    updater: (deployment: SiteBuilderState["deployment"]) => SiteBuilderState["deployment"]
  ) => void;
  updateCode: (updater: (code: SiteBuilderState["code"]) => SiteBuilderState["code"]) => void;
  updateVersionControl: (
    updater: (versionControl: SiteBuilderState["versionControl"]) => SiteBuilderState["versionControl"]
  ) => void;
  updateCollaboration: (
    updater: (collaboration: SiteBuilderState["collaboration"]) => SiteBuilderState["collaboration"]
  ) => void;
  updateBilling: (updater: (billing: SiteBuilderState["billing"]) => SiteBuilderState["billing"]) => void;
  createProject: (options?: CreateProjectOptions) => string;
  switchProject: (projectId: string) => void;
  setProjectOrg: (projectId: string, org: ProjectOrgInfo) => void;
  setProjectName: (projectId: string, name: string) => void;
  removeProject: (projectId: string) => void;
  removeProjectsByOrgId: (orgId: string) => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
}


const baseMetadata: ProjectMetadata = {
  projectType: "general",
  projectName: "Untitled Instafy Project",
  prompt: "",
  goal: "",
  targetAudience: "",
  tone: "",
  aiModel: DEFAULT_PROJECT_AI_MODEL,
  tags: []
};

const baseContent: ProjectContent = {};

const baseVersionControl: VersionControlSettings = {
  enabled: false,
  provider: "github",
  mode: "managed",
  organization: "",
  repository: "",
  branch: "main",
  status: "idle",
  lastSyncedAt: null,
  automationEnabled: true,
  error: null,
  repoUrl: null
};

const baseCollaboration: CollaborationSettings = {
  enabled: false,
  inviteToken: null,
  allowGuestEditors: false,
  pendingInvites: []
};

function createEmptyContent(): ProjectContent {
  return clone(baseContent);
}

function createProjectState(options?: {
  projectName?: string;
  tags?: string[];
  orgId?: string | null;
  orgName?: string | null;
}): SiteBuilderState {
  const content = createEmptyContent();

  const metadata: ProjectMetadata = {
    ...baseMetadata,
    projectName: options?.projectName ?? baseMetadata.projectName,
    tags: options?.tags ?? baseMetadata.tags
  };

  return {
    metadata,
    content,
    deployment: {
      subdomain: "",
      hostingPlan: "instafy",
    },
    code: createDefaultCodeWorkspace(),
    versionControl: clone(baseVersionControl),
    collaboration: clone(baseCollaboration),
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
  history: [],
  future: [],
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
      history: [],
      future: [],
      projects: nextProjects,
      activeProjectId: nextActiveProjectId,
    });
  },
  updateMetadata: (updater) => {
    const store = get();
    const previous = clone(store.state);
    const nextMetadata = updater(clone(previous.metadata));
    if (JSON.stringify(previous.metadata) === JSON.stringify(nextMetadata)) {
      return;
    }
    const nextState: SiteBuilderState = {
      ...previous,
      metadata: nextMetadata
    };
    set({
      state: nextState,
      history: [...store.history, previous],
      future: [],
      projects: {
        ...store.projects,
        [store.activeProjectId]: clone(nextState)
      }
    });
  },
  updateContent: (updater) => {
    const store = get();
    const previous = clone(store.state);
    const nextContent = updater(clone(previous.content));
    if (JSON.stringify(previous.content) === JSON.stringify(nextContent)) {
      return;
    }
    const nextState: SiteBuilderState = {
      ...previous,
      content: nextContent
    };
    set({
      state: nextState,
      history: [...store.history, previous],
      future: [],
      projects: {
        ...store.projects,
        [store.activeProjectId]: clone(nextState)
      }
    });
  },
  updateDeployment: (updater) => {
    const store = get();
    const previous = clone(store.state);
    const nextDeployment = updater(clone(previous.deployment));
    if (JSON.stringify(previous.deployment) === JSON.stringify(nextDeployment)) {
      return;
    }
    const nextState: SiteBuilderState = {
      ...previous,
      deployment: nextDeployment
    };
    set({
      state: nextState,
      history: [...store.history, previous],
      future: [],
      projects: {
        ...store.projects,
        [store.activeProjectId]: clone(nextState)
      }
    });
  },
  updateCode: (updater) => {
    const store = get();
    const previousState = store.state;
    const previousSnapshot = clone(previousState);
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
      history: [...store.history, previousSnapshot],
      future: [],
      projects: {
        ...store.projects,
        [store.activeProjectId]: clone(nextState)
      }
    });
  },
  updateVersionControl: (updater) => {
    const store = get();
    const previous = clone(store.state);
    const nextVersionControl = updater(clone(previous.versionControl));
    if (JSON.stringify(previous.versionControl) === JSON.stringify(nextVersionControl)) {
      return;
    }
    const nextState: SiteBuilderState = {
      ...previous,
      versionControl: nextVersionControl
    };
    set({
      state: nextState,
      history: [...store.history, previous],
      future: [],
      projects: {
        ...store.projects,
        [store.activeProjectId]: clone(nextState)
      }
    });
  },
  updateCollaboration: (updater) => {
    const store = get();
    const previous = clone(store.state);
    const nextCollaboration = updater(clone(previous.collaboration));
    if (JSON.stringify(previous.collaboration) === JSON.stringify(nextCollaboration)) {
      return;
    }
    const nextState: SiteBuilderState = {
      ...previous,
      collaboration: nextCollaboration
    };
    set({
      state: nextState,
      history: [...store.history, previous],
      future: [],
      projects: {
        ...store.projects,
        [store.activeProjectId]: clone(nextState)
      }
    });
  },
  updateBilling: (updater) => {
    const store = get();
    const previousState = store.state;
    const previousSnapshot = clone(previousState);
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
      history: [...store.history, previousSnapshot],
      future: [],
      projects: {
        ...store.projects,
        [store.activeProjectId]: clone(nextState)
      }
    });
  },
  createProject: (options) => {
    const projectName = options?.projectName ?? `Untitled Space`;
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
    set((store) => {
      const nextProjects = {
        ...store.projects,
        [projectId]: clone(newState)
      };
      return {
        state: newState,
        history: [],
        future: [],
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
      activeProjectId: projectId,
      history: [],
      future: []
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
  removeProject: (projectId) => {
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

      const remainingIds = Object.keys(nextProjects);
      const fallbackId = remainingIds[0] ?? "";
      if (!fallbackId) {
        return {
          projects: nextProjects,
          activeProjectId: "",
          state: createProjectState(),
          history: [],
          future: [],
        };
      }
      return {
        projects: nextProjects,
        activeProjectId: fallbackId,
        state: clone(nextProjects[fallbackId]),
        history: [],
        future: [],
      };
    });
  },
  removeProjectsByOrgId: (orgId) => {
    const trimmed = orgId.trim();
    if (!trimmed) {
      return;
    }
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
          history: [],
          future: [],
        };
      }
      return {
        projects: nextProjects,
        activeProjectId: fallbackId,
        state: clone(nextProjects[fallbackId]),
        history: [],
        future: [],
      };
    });
  },
  undo: () => {
    const { history, state, future, projects, activeProjectId } = get();
    if (history.length === 0) {
      return;
    }
    const previous = history[history.length - 1];
    set({
      state: previous,
      history: history.slice(0, history.length - 1),
      future: [clone(state), ...future],
      projects: {
        ...projects,
        [activeProjectId]: clone(previous)
      }
    });
  },
  redo: () => {
    const { future, history, state, projects, activeProjectId } = get();
    if (future.length === 0) {
      return;
    }
    const next = future[0];
    set({
      state: next,
      history: [...history, clone(state)],
      future: future.slice(1),
      projects: {
        ...projects,
        [activeProjectId]: clone(next)
      }
    });
  },
  reset: () => {
    const resetState = createProjectState();
    const { projects, activeProjectId } = get();
    set({
      state: resetState,
      history: [],
      future: [],
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
