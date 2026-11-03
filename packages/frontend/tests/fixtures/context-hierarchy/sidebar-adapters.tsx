import { createContext, useContext, useState, type ReactNode } from "react";
import { controllerClient as historyController } from "./adapters";

export const reviewOrganizations = [
  { id: "workshop", name: "Instafy Workshop", slug: "workshop", role: "owner", avatarUrl: null, accentColor: "violet" },
  { id: "studio", name: "Design Studio", slug: "studio", role: "builder", avatarUrl: null, accentColor: "blue" },
  { id: "research", name: "Research Lab", slug: "research", role: "builder", avatarUrl: null, accentColor: "green" },
];
const projects = [
  { id: "live", name: "live eval 2026 — browser review", orgId: "workshop", orgName: "Instafy Workshop", state: null, isRemoteOnly: false },
  { id: "product", name: "Product website", orgId: "workshop", orgName: "Instafy Workshop", state: null, isRemoteOnly: false },
  { id: "design", name: "Design system", orgId: "studio", orgName: "Design Studio", state: null, isRemoteOnly: false },
  { id: "research", name: "Research notes", orgId: "research", orgName: "Research Lab", state: null, isRemoteOnly: false },
];
const remoteProjects = projects.map(project => ({ projectId: project.id, projectName: project.name, orgId: project.orgId, orgName: project.orgName }));
const noop = () => {};
const ProjectContext = createContext({ activeProjectId: "live", switchProject: (id: string) => { void id; } });
export function SidebarReviewDataProvider({ children }: { children: ReactNode }) {
  const [activeProjectId, switchProject] = useState("live");
  return <ProjectContext.Provider value={{ activeProjectId, switchProject }}>{children}</ProjectContext.Provider>;
}
export function useProjects() {
  return { ...useContext(ProjectContext), projectList: projects, createProject: noop };
}
export function useMergedControllerProjects({ orgId }: { orgId?: string | null }) {
  return { mergedProjects: projects, remoteLoading: false, remoteLoadedScope: orgId ?? null,
    remoteDiscoveryResolved: true, remoteError: null, remoteRefreshing: false,
    allRemoteProjects: remoteProjects, retryRemoteProjects: noop };
}
export const runtimeControllerEnabled = true;
export const controllerClient = {
  ...historyController,
  core: { enabled: true },
  organizations: { list: async () => reviewOrganizations, listMembers: async () => [], create: async () => { throw new Error("Creation is disabled in this local preview."); } },
  projects: { listMembers: async () => [], listResult: async () => ({ status: "success", projects: remoteProjects }) },
};
export const useProfile = () => ({ profile: { fullName: "Review user", avatarUrl: null } });
export const useRuntimeMenuOptions = () => ({ runtime: { copyTunnelDetails: noop }, runtimeOptions: [] });
export const useAppLogs = () => ({ logs: [], hasLogs: false, hasErrors: false, clearLogs: noop });
export const useAppUpdateMetadata = () => ({ metadata: null, refresh: noop });
export const useDesktopReleaseLookup = () => ({ lookup: { status: "unavailable" } });
