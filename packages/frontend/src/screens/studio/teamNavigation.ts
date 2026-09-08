import type { NavigateFunction, To } from "react-router-dom";
import { isUUID } from "../../utils/uuid";

export type StudioNavigationPage = "home" | "team" | "account" | "workspace";

/** An explicit destination supersedes a URL write queued by closing a drawer. */
export function navigateStudioExplicitly(
  consumeUrlNavigation: () => unknown,
  navigate: NavigateFunction,
  target: To | number,
) {
  consumeUrlNavigation();
  if (typeof target === "number") return navigate(target);
  return navigate(target);
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

export function buildTeamNavigationSearch(search: string, orgKey: string, page: "team" | "home") {
  const params = new URLSearchParams(search);
  params.set("panel", page);
  params.set("teamId", orgKey);
  for (const key of ["workspaceTab", "reviewTab", "jobId", "settingsTab", "settingsOrgId", "settingsCategory"])
    params.delete(key);
  return `?${params.toString()}`;
}

/** Only record a settled route owned by the current account and team. */
export function canRememberTeamWorkspace(search: string, projectId: string | null, orgKey: string) {
  const params = new URLSearchParams(search);
  const scope = resolveTeamNavigationScope(search, orgKey);
  if (scope.page === "home" || scope.page === "account" || scope.orgKey !== orgKey) return false;
  const urlProject = params.get("projectId");
  return Boolean(projectId) && (!urlProject || urlProject === projectId);
}
