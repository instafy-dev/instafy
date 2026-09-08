import type { SettingsTab, StudioPanel } from "../screens/studio/types";

export type StudioDestination =
  | {
      /** Show or close navigation beside the current destination without changing its scope. */
      kind: "drawer";
      workspaceTab: "history" | "files" | "sourceControl" | "workspaces" | null;
    }
  | {
      /** Restore a previously visited Studio URL, with a fresh history/scroll entry. */
      kind: "route";
      search: string;
    }
  | {
      kind: "conversation";
      projectId: string;
      conversationId?: string | null;
      conversationControllerId?: string | null;
      jobId?: string | null;
    }
  | {
      kind: "panel";
      panel: StudioPanel;
      settingsTab?: SettingsTab;
      settingsCategory?: string | null;
      settingsOrgId?: string | null;
      teamId?: string | null;
      workspaceTab?: "history" | "files" | "sourceControl" | "workspaces" | null;
    };

/** A destination is written once; route hydration selects the corresponding UI. */
export function buildStudioDestinationSearch(search: string, destination: StudioDestination): string {
  if (destination.kind === "route") {
    const restored = new URLSearchParams(destination.search).toString();
    return restored ? `?${restored}` : "";
  }
  const params = new URLSearchParams(search);
  if (destination.kind === "drawer") {
    if (destination.workspaceTab) params.set("workspaceTab", destination.workspaceTab);
    else params.delete("workspaceTab");
    const next = params.toString();
    return next ? `?${next}` : "";
  }
  const currentTeam = params.get("teamId") ?? params.get("settingsOrgId");
  for (const key of ["jobId", "reviewTab", "workspaceTab", "settingsTab", "settingsCategory", "settingsItem", "settingsOrgId", "teamId", "view"]) {
    params.delete(key);
  }
  if (destination.kind === "conversation") {
    params.set("projectId", destination.projectId);
    params.delete("panel");
    for (const key of ["conversationId", "conversationControllerId", "jobId"] as const) {
      const value = destination[key]?.trim();
      if (value) params.set(key, value);
      else params.delete(key);
    }
    // A browser-session resume target belongs to its original space.
    if (new URLSearchParams(search).get("projectId") !== destination.projectId) {
      params.delete("browserRuntimeId");
    }
  } else {
    if (destination.panel === "chat") params.delete("panel");
    else params.set("panel", destination.panel);
    if (destination.panel === "settings") {
      params.set("settingsTab", destination.settingsTab ?? "org");
      if (destination.settingsCategory) params.set("settingsCategory", destination.settingsCategory);
      if ((destination.settingsTab ?? "org") === "org" && destination.settingsOrgId) {
        params.set("settingsOrgId", destination.settingsOrgId);
      }
    }
    if (destination.panel === "home" || destination.panel === "team" ||
        (destination.panel === "settings" && destination.settingsTab === "profile")) {
      const teamId = destination.teamId === undefined ? currentTeam : destination.teamId;
      if (teamId) params.set("teamId", teamId);
    }
    if (destination.workspaceTab) params.set("workspaceTab", destination.workspaceTab);
  }
  const next = params.toString();
  return next ? `?${next}` : "";
}
