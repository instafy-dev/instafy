export const PROJECT_ACCESS_REFRESH_EVENT = "instafy:project-access-refresh";

export interface ProjectAccessRefreshEventDetail {
  projectId?: string | null;
}

// Fired when a project or organization roster changed for another viewer.
// The controller fans project.members_changed out per project; the sync hook
// forwards it as this window event so cached rosters refetch without a timer.
export const MEMBERS_CHANGED_EVENT = "instafy:members-changed";

export interface MembersChangedEventDetail {
  projectId?: string | null;
  orgId?: string | null;
}
