export const PROJECT_ACCESS_REFRESH_EVENT = "instafy:project-access-refresh";

export interface ProjectAccessRefreshEventDetail {
  projectId?: string | null;
  /**
   * The space that was deleted, when that is the change. Older controllers
   * never say; listeners then refresh as for any other access change.
   */
  deletedProjectId?: string | null;
  /**
   * The team that was deleted, when that is the change. Its spaces were
   * announced one by one before it; this drops the team and any of its spaces
   * a tab still lists. Older controllers never say.
   */
  deletedOrgId?: string | null;
}

/** The team an access refresh says was deleted, if it says so. */
export function readDeletedOrgId(event: Event): string | null {
  return (event as CustomEvent<ProjectAccessRefreshEventDetail | null>).detail?.deletedOrgId ?? null;
}

// Fired when a project or organization roster changed for another viewer.
// The controller fans project.members_changed out per project; the sync hook
// forwards it as this window event so cached rosters refetch without a timer.
export const MEMBERS_CHANGED_EVENT = "instafy:members-changed";

export interface MembersChangedEventDetail {
  projectId?: string | null;
  orgId?: string | null;
}
