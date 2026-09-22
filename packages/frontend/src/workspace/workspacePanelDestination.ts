import type { StudioDestination } from "../navigation/studioNavigation";
import type { StudioPanel } from "../screens/studio/types";

export type WorkspacePanelDestination = Extract<StudioDestination, { kind: "panel" }>;

/** Remember panel-owned state, never a stale chat, message, drawer or space URL. */
export function readWorkspacePanelDestination(search: string, panel: StudioPanel): WorkspacePanelDestination | null {
  const params = new URLSearchParams(search);
  if (params.get("panel") !== panel) return null;
  const settingsTab = params.get("settingsTab");
  return {
    kind: "panel", panel,
    ...(panel === "settings" ? {
      settingsTab: settingsTab === "profile" || settingsTab === "project" ? settingsTab : "org",
      settingsCategory: params.get("settingsCategory"),
      settingsItem: params.get("settingsItem"),
      settingsOrgId: params.get("settingsOrgId"),
    } : {}),
    teamId: params.get("teamId"),
  };
}
