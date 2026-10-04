import { useMemo } from "react";
import type { VersioningMode } from "../services/runtimeController/workspaceVersioning";
import { pendingUnsavedWorkEntries, useUnsavedWork } from "../workspace/unsavedWorkStore";
import { useStudioGitStatusBadge, type StudioGitStatusBadgeInput } from "./useStudioGitStatusBadge";

export interface SidebarCountBadge {
  count: number;
  label: string;
}

export interface WorkspaceVersioningBadgeInput extends StudioGitStatusBadgeInput {
  /** The chrome mode; `legacy` keeps today's uncommitted-changes badge. */
  chromeMode: VersioningMode;
  /** A probe answered `stateless` or `desktop`: unsaved work may be listed. */
  historyReady: boolean;
  originId: string | null;
}

export function uncommittedChangesBadgeLabel(count: number): string {
  return `${count} uncommitted ${count === 1 ? "change" : "changes"}`;
}

export function unsavedWorkBadgeLabel(count: number): string {
  return `${count} unsaved work ${count === 1 ? "entry" : "entries"}`;
}

/**
 * The Changes/History nav badge. Legacy spaces keep exactly today's logic
 * (git status, event driven, slow gated fallback). Stateless and Desktop
 * spaces count unsaved work instead and make no `/git/status` call; the list
 * loads on Studio load and project switch, and on focus after five minutes.
 */
export function useWorkspaceVersioningBadge({
  chromeMode,
  historyReady,
  originId,
  ...legacyInput
}: WorkspaceVersioningBadgeInput): { badge: SidebarCountBadge | null } {
  const legacy = chromeMode === "legacy";
  const { gitDirtyCount, gitSupported } = useStudioGitStatusBadge({ ...legacyInput, paused: !legacy });
  const unsavedWork = useUnsavedWork({
    projectId: legacyInput.activeProjectId,
    originId,
    enabled:
      historyReady &&
      !legacy &&
      legacyInput.projectReadyForWorkspace &&
      !legacyInput.controllerProjectMissing,
  });
  const unsavedCount = historyReady && !legacy ? pendingUnsavedWorkEntries(unsavedWork.entries).length : 0;

  const badge = useMemo<SidebarCountBadge | null>(() => {
    if (legacy) {
      if (!gitSupported || gitDirtyCount <= 0) {
        return null;
      }
      return { count: gitDirtyCount, label: uncommittedChangesBadgeLabel(gitDirtyCount) };
    }
    if (unsavedCount <= 0) {
      return null;
    }
    return { count: unsavedCount, label: unsavedWorkBadgeLabel(unsavedCount) };
  }, [gitDirtyCount, gitSupported, legacy, unsavedCount]);

  return { badge };
}
