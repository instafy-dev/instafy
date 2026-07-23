import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspaceStore } from "../store";
import type { ProjectOrgInfo, SiteBuilderState } from "../types";

interface CreateProjectOptions {
  templateId?: string;
  projectName?: string;
  projectId?: string;
  orgId?: string | null;
  orgName?: string | null;
}

interface ProjectStateContextValue {
  projects: Record<string, SiteBuilderState>;
  activeProjectId: string;
  createProject: (options?: CreateProjectOptions) => string;
  switchProject: (projectId: string) => void;
  setProjectOrg: (projectId: string, org: ProjectOrgInfo) => void;
  setProjectName: (projectId: string, name: string) => void;
  removeProject: (projectId: string) => void;
  removeProjectsByOrgId: (orgId: string) => void;
}

const ProjectStateContext = createContext<ProjectStateContextValue | null>(null);

export function ProjectStateProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Record<string, SiteBuilderState>>(() =>
    JSON.parse(JSON.stringify(useWorkspaceStore.getState().projects)) as Record<string, SiteBuilderState>
  );
  const [activeProjectId, setActiveProjectId] = useState<string>(useWorkspaceStore.getState().activeProjectId);

  useEffect(() => {
    const unsubscribeProjects = useWorkspaceStore.subscribe(
      (store) => store.projects,
      (next) => setProjects(JSON.parse(JSON.stringify(next)) as Record<string, SiteBuilderState>)
    );
    const unsubscribeActive = useWorkspaceStore.subscribe(
      (store) => store.activeProjectId,
      (next) => setActiveProjectId(next)
    );
    // Ensure we don't miss any store updates that may have occurred before the
    // subscriptions were registered (e.g. during initial bootstrap effects).
    const snapshot = useWorkspaceStore.getState();
    setProjects(JSON.parse(JSON.stringify(snapshot.projects)) as Record<string, SiteBuilderState>);
    setActiveProjectId(snapshot.activeProjectId);
    return () => {
      unsubscribeProjects();
      unsubscribeActive();
    };
  }, []);

  const createProject = useCallback((options?: CreateProjectOptions) => {
    return useWorkspaceStore.getState().createProject(options);
  }, []);

  const switchProject = useCallback((projectId: string) => {
    useWorkspaceStore.getState().switchProject(projectId);
  }, []);

  const setProjectOrg = useCallback((projectId: string, org: ProjectOrgInfo) => {
    useWorkspaceStore.getState().setProjectOrg(projectId, org);
  }, []);

  const setProjectName = useCallback((projectId: string, name: string) => {
    useWorkspaceStore.getState().setProjectName(projectId, name);
  }, []);

  const removeProject = useCallback((projectId: string) => {
    useWorkspaceStore.getState().removeProject(projectId);
  }, []);

  const removeProjectsByOrgId = useCallback((orgId: string) => {
    useWorkspaceStore.getState().removeProjectsByOrgId(orgId);
  }, []);

  const value = useMemo<ProjectStateContextValue>(
    () => ({
      projects,
      activeProjectId,
      createProject,
      switchProject,
      setProjectOrg,
      setProjectName,
      removeProject,
      removeProjectsByOrgId,
    }),
    [
      activeProjectId,
      createProject,
      projects,
      removeProject,
      removeProjectsByOrgId,
      setProjectName,
      setProjectOrg,
      switchProject,
    ]
  );

  return <ProjectStateContext.Provider value={value}>{children}</ProjectStateContext.Provider>;
}

export function useProjectState(): ProjectStateContextValue {
  const context = useContext(ProjectStateContext);
  if (!context) {
    throw new Error("useProjectState must be used within a ProjectStateProvider");
  }
  return context;
}
