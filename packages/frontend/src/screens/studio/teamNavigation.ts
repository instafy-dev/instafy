import { isUUID } from "../../utils/uuid";

export type StudioNavigationPage = "home" | "team" | "account" | "workspace";

/** Account settings remain personal while preserving the surrounding space's navigation. */
export function usesGlobalNavigationContext(page: StudioNavigationPage, activeProjectId: string | null) {
  return page === "home" || (page === "account" && !activeProjectId);
}

export function readTeamNavigationKey(value: string | null): string | null {
  return value === "personal" || (value !== null && isUUID(value)) ? value : null;
}

/** Team context is independent of a space only on explicitly team/global pages. */
export function resolveTeamNavigationScope(search: string, activeOrgKey: string) {
  const params = new URLSearchParams(search);
  const panel = params.get("panel");
  const account = panel === "settings" && params.get("settingsTab") === "profile";
  const teamSettings = panel === "settings" && params.get("settingsTab") === "org";
  const page: StudioNavigationPage = panel === "home" ? "home"
    : account ? "account" : panel === "team" || teamSettings ? "team" : "workspace";
  const requestedKey = teamSettings ? readTeamNavigationKey(params.get("settingsOrgId"))
    : page !== "workspace" ? readTeamNavigationKey(params.get("teamId")) : null;
  return { page, orgKey: requestedKey ?? activeOrgKey };
}

/** Remember workspace destinations, so global pages cannot replace a space's work. */
export function canRememberTeamWorkspace(search: string, projectId: string | null, orgKey: string) {
  const params = new URLSearchParams(search);
  const scope = resolveTeamNavigationScope(search, orgKey);
  if (scope.page !== "workspace" || scope.orgKey !== orgKey) return false;
  const urlProject = params.get("projectId");
  return Boolean(projectId) && (!urlProject || urlProject === projectId);
}
