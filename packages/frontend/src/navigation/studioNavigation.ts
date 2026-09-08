import type { SettingsTab, StudioPanel } from "../screens/studio/types";

export type StudioDestination =
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
      workspaceTab?: "history" | "files" | "sourceControl" | "workspaces" | null;
    };

/** A destination is written once; route hydration selects the corresponding UI. */
export function buildStudioDestinationSearch(search: string, destination: StudioDestination): string {
  const params = new URLSearchParams(search);
  for (const key of ["jobId", "reviewTab", "workspaceTab", "settingsTab", "settingsCategory", "settingsItem", "view"]) {
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
    }
    if (destination.workspaceTab) params.set("workspaceTab", destination.workspaceTab);
  }
  const next = params.toString();
  return next ? `?${next}` : "";
}
