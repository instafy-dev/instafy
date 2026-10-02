import { useMemo } from "react";
import { useProjectMetadata } from "./ProjectMetadataProvider";
import { useProjectState } from "./ProjectStateProvider";
import { useProjectAccess } from "./ProjectAccessProvider";
import { spaceDisplayName } from "./spaceName";

export function useProject() {
  const { projects, activeProjectId } = useProjectState();
  const { metadata } = useProjectMetadata();
  const projectAccess = useProjectAccess();

  const activeProjectName = useMemo(() => {
    const activeName = activeProjectId ? projects[activeProjectId]?.metadata.projectName : null;
    return spaceDisplayName(activeName || metadata.projectName);
  }, [activeProjectId, metadata.projectName, projects]);

  return {
    activeProjectId,
    activeProjectName,
    ...projectAccess,
  };
}
