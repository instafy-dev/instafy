import { useMemo } from "react";
import { useProjectMetadata } from "./ProjectMetadataProvider";
import { useProjectState } from "./ProjectStateProvider";
import { useProjectAccess } from "./ProjectAccessProvider";
import { spaceDisplayName } from "./spaceName";

export function useProject() {
  const { projects, activeProjectId } = useProjectState();
  const { metadata } = useProjectMetadata();
  const projectAccess = useProjectAccess();

  // Null while no space is open: "Untitled space" there named a space that is
  // not there, behind the notice for one that was deleted.
  const activeProjectName = useMemo<string | null>(() => {
    if (!activeProjectId) {
      return null;
    }
    const activeName = projects[activeProjectId]?.metadata.projectName;
    return spaceDisplayName(activeName || metadata.projectName);
  }, [activeProjectId, metadata.projectName, projects]);

  return {
    activeProjectId,
    activeProjectName,
    ...projectAccess,
  };
}
