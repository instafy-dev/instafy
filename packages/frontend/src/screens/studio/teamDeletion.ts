import {
  PROJECT_ACCESS_REFRESH_EVENT,
  type ProjectAccessRefreshEventDetail,
} from "../../projects/projectAccessEvents";
import { markProjectDeletedHere, unmarkProjectDeletedHere } from "../../projects/projectDeletion";
import { controllerClient } from "../../sdk/instafy";

/**
 * "incomplete": the team's spaces are deleted, but the controller keeps the
 * team until their machines are released, and its message says to delete it
 * again. `nextProjectId` is the space this tab moved to, when it knew one
 * outside the team.
 */
export type TeamDeletionOutcome =
  | { status: "deleted"; nextProjectId: string | null }
  | { status: "incomplete"; message: string; nextProjectId: string | null }
  | { status: "failed" };

/**
 * Deletes the team `orgId` from this tab. The controller announces each of
 * its spaces deleted while the request runs, which can take minutes, and this
 * tab moves on by itself once it answers. So those spaces are marked deleted
 * here first, and their notices do not block the open space or move it twice.
 * A failed delete clears the marks; a space it did delete was announced and
 * is off the lists already. An incomplete one leaves as a finished one does.
 */
export async function deleteTeamFromThisTab({
  orgId,
  projects,
  leave,
  removeTeamProjects,
}: {
  orgId: string;
  projects: readonly { id: string; orgId: string | null }[];
  /** Moves this tab to `projectId`, or to the Spaces page when it is null. */
  leave: (projectId: string | null) => void;
  removeTeamProjects: (orgId: string) => void;
}): Promise<TeamDeletionOutcome> {
  const teamProjectIds = projects.filter((project) => project.orgId === orgId).map((project) => project.id);
  teamProjectIds.forEach(markProjectDeletedHere);
  const result = await controllerClient.organizations.delete(orgId);
  if (result.status === "failed") {
    teamProjectIds.forEach(unmarkProjectDeletedHere);
    return { status: "failed" };
  }

  const nextProjectId = projects.find((project) => project.orgId !== orgId)?.id ?? null;
  leave(nextProjectId);
  removeTeamProjects(orgId);
  // Lists cached from before the delete refresh now. A team that is kept
  // stays listed, without its spaces.
  window.dispatchEvent(new CustomEvent<ProjectAccessRefreshEventDetail>(PROJECT_ACCESS_REFRESH_EVENT, {
    detail: { projectId: null, deletedOrgId: result.status === "deleted" ? orgId : null },
  }));
  return result.status === "incomplete"
    ? { status: "incomplete", message: result.message, nextProjectId }
    : { status: "deleted", nextProjectId };
}
