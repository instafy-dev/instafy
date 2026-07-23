import { useMemo } from "react";
import { useProjectMetadata } from "./ProjectMetadataProvider";
import { useProjectState } from "./ProjectStateProvider";
import { useProjectAccess } from "./ProjectAccessProvider";

export function useProject() {
  const { projects, activeProjectId } = useProjectState();
  const { metadata } = useProjectMetadata();
  const projectAccess = useProjectAccess();

  const activeProjectName = useMemo(() => {
    if (activeProjectId && projects[activeProjectId]?.metadata.projectName) {
      return projects[activeProjectId]?.metadata.projectName ?? "Untitled Space";
    }
    return metadata.projectName ?? "Untitled Space";
  }, [activeProjectId, metadata.projectName, projects]);

  return {
    activeProjectId,
    activeProjectName,
    ...projectAccess,
  };
}
