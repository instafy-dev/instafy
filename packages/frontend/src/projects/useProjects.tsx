import type { ProjectIdentity } from "@instafy/sdk/project-identity";
import { useCallback, useMemo } from "react";
import type { SiteBuilderState } from "../types";
import { useProjectState } from "./ProjectStateProvider";
import { controllerClient } from "../sdk/instafy";
import { getOrgDisplayName } from "../org/orgNaming";
import { writePendingProjectSwitch } from "../screens/pendingProjectSwitch";

export interface ProjectListItem extends ProjectIdentity {
  id: string;
  name: string;
  orgId: string | null;
  orgName: string;
  state: SiteBuilderState;
}

export function useProjects() {
  const { rename: updateControllerProjectName } = controllerClient.projects;
  const {
    projects,
    activeProjectId,
    switchProject,
    createProject,
    setProjectName,
    removeProject,
    removeProjectsByOrgId,
  } = useProjectState();

  const projectList = useMemo<ProjectListItem[]>(() => {
    return Object.entries(projects).map(([id, state]) => ({
      id,
      name: state.metadata.projectName ?? "Untitled Space",
      projectIcon: state.metadata.projectIcon,
      projectColor: state.metadata.projectColor,
      orgId: state.org?.id ?? null,
      orgName: getOrgDisplayName(state.org?.name),
      state
    }));
  }, [projects]);

  const handleSwitchProject = useCallback(
    (projectId: string) => {
      if (!projects[projectId]) {
        return;
      }
      writePendingProjectSwitch(projectId);
      switchProject(projectId);
    },
    [projects, switchProject]
  );

  const renameProject = useCallback(
    async (projectId: string, name: string): Promise<{ success: boolean; error?: string }> => {
      const trimmed = name.trim();
      if (!trimmed) {
        return { success: false, error: "Space name is required." };
      }
      setProjectName(projectId, trimmed);
      const result = await updateControllerProjectName({ projectId, projectName: trimmed });
      if (!result) {
        return { success: false, error: "Unable to rename the space right now." };
      }
      if (typeof result.projectName === "string" && result.projectName.trim().length > 0) {
        setProjectName(projectId, result.projectName.trim());
      }
      return { success: true };
    },
    [setProjectName, updateControllerProjectName],
  );

  return {
    activeProjectId,
    projects,
    projectList,
    switchProject: handleSwitchProject,
    createProject,
    setProjectName,
    renameProject,
    removeProject,
    removeProjectsByOrgId,
  };
}
