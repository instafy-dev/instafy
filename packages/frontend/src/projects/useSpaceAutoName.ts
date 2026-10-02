import { useEffect, useMemo } from "react";
import { useConversations } from "../conversations/ConversationsProvider";
import { controllerClient } from "../sdk/instafy";
import { useProject } from "./useProject";
import { useProjectState } from "./ProjectStateProvider";
import { resolveSpaceAutoName } from "./spaceAutoName";
import { isUntitledSpaceName, realSpaceName } from "./spaceName";

const { getSummaryResult: getControllerProjectSummaryResult, rename: updateControllerProjectName } =
  controllerClient.projects;

// One try per space per page load, whatever the outcome: an automatic name is
// a convenience, and a failure must not turn into a retry loop.
const attemptedSpaceIds = new Set<string>();

async function nameUntitledSpace(
  projectId: string,
  name: string,
  setProjectName: (projectId: string, name: string) => void,
): Promise<void> {
  try {
    // The local name can be stale. Read the stored one first, so a rename
    // made in another tab or on another device is never overwritten.
    const { summary } = await getControllerProjectSummaryResult(projectId);
    if (!summary) {
      return;
    }
    const storedName = realSpaceName(summary.projectName);
    if (storedName) {
      setProjectName(projectId, storedName);
      return;
    }
    const saved = realSpaceName((await updateControllerProjectName({ projectId, projectName: name }))?.projectName);
    if (saved) {
      setProjectName(projectId, saved);
    }
  } catch {
    // The space stays untitled and can still be renamed in Settings.
  }
}

/**
 * Names the active space after its first chat while the space has no name of
 * its own (see resolveSpaceAutoName). Only someone who can edit the space does
 * this, and a name a person chose is never replaced.
 */
export function useSpaceAutoName(): void {
  const { activeProjectId, activeProjectName, canWriteProject, projectCapabilitiesResolved } = useProject();
  const { projectKey, conversations, remoteConversationHistoryResolved } = useConversations();
  const { setProjectName } = useProjectState();
  // Chats change on every streamed reply, so skip the work outright for a
  // named space. The provider keeps the previous space's chats for one render
  // on a switch, and until the chat list loads the first chat is unknown.
  const eligible = Boolean(activeProjectId) &&
    projectKey === activeProjectId &&
    remoteConversationHistoryResolved &&
    projectCapabilitiesResolved &&
    canWriteProject &&
    isUntitledSpaceName(activeProjectName) &&
    !attemptedSpaceIds.has(activeProjectId ?? "");
  const name = useMemo(
    () => (eligible ? resolveSpaceAutoName(conversations) : null),
    [conversations, eligible],
  );

  useEffect(() => {
    if (!activeProjectId || !name || attemptedSpaceIds.has(activeProjectId)) {
      return;
    }
    attemptedSpaceIds.add(activeProjectId);
    void nameUntitledSpace(activeProjectId, name, setProjectName);
  }, [activeProjectId, name, setProjectName]);
}
