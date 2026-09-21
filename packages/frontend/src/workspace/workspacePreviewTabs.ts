import type { WorkspaceConversationTabState, WorkspaceFileTabState, WorkspacePanelTabState, WorkspaceTabState } from "./workspaceTabFactories";
import type { StudioPanel } from "../screens/studio/types";

export function isWorkspacePreviewTab(tab: WorkspaceTabState | null | undefined): tab is
  (WorkspaceConversationTabState | WorkspaceFileTabState | WorkspacePanelTabState) & { preview: true } {
  return Boolean(tab && "preview" in tab && tab.preview);
}

/** Utility browsing has its own slot; it must not displace a chat or file. */
export function isUtilityPreviewPanel(panel: StudioPanel): boolean {
  return panel !== "chat" && panel !== "code" && panel !== "sourceControl";
}

export function insertPreviewTab(tabs: WorkspaceTabState[], tab: WorkspaceTabState): WorkspaceTabState[] {
  const replaceAt = isWorkspacePreviewTab(tab)
    ? tabs.findIndex((current) => current.kind === tab.kind && isWorkspacePreviewTab(current) && !current.dirty)
    : -1;
  return replaceAt < 0 ? [...tabs, tab] : tabs.map((current, index) => index === replaceAt ? tab : current);
}
