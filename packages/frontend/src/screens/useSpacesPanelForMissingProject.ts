import { useEffect, useRef } from "react";

export type SpacesPanelForMissingProjectInput = {
  activeProjectId: string | null | undefined;
  /** The space the URL names. */
  routedProjectId: string | null | undefined;
  controllerProjectMissing: boolean;
  projectReadyForWorkspace: boolean;
  openPanelTab: (panel: "projects") => void;
};

/**
 * Opens the Spaces panel once for each space that is gone or closed to this
 * account, so its notice does not sit under that space's chat tab and header.
 * A space deleted while it was open leaves no space open as the URL still
 * names it, so then the URL's space is the missing one.
 */
export function useSpacesPanelForMissingProject({
  activeProjectId,
  routedProjectId,
  controllerProjectMissing,
  projectReadyForWorkspace,
  openPanelTab,
}: SpacesPanelForMissingProjectInput): void {
  const handledProjectIdRef = useRef<string | null>(null);
  const missingProjectId = activeProjectId?.trim() || routedProjectId?.trim() || "";

  useEffect(() => {
    if (!projectReadyForWorkspace || !controllerProjectMissing || !missingProjectId) {
      return;
    }
    if (handledProjectIdRef.current === missingProjectId) {
      return;
    }
    handledProjectIdRef.current = missingProjectId;
    openPanelTab("projects");
  }, [controllerProjectMissing, missingProjectId, openPanelTab, projectReadyForWorkspace]);
}
