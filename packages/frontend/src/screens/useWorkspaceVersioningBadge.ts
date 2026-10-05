import { useMemo } from "react";
import type { VersioningMode } from "../services/runtimeController/workspaceVersioning";
import type { WorkspaceRecoveryEntry } from "../sdk/instafy";
import { unsavedWorkSeenKey, useUnsavedWorkSeen } from "../workspace/unsavedWorkSeen";
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
  /** The viewer: salvage entries they have seen stop counting. */
  userId?: string | null;
}

export function uncommittedChangesBadgeLabel(count: number): string {
  return `${count} uncommitted ${count === 1 ? "change" : "changes"}`;
}

export function unsavedWorkBadgeLabel(count: number): string {
  return `${count} unsaved work ${count === 1 ? "entry" : "entries"}`;
}

/**
 * Entries the badge counts. Salvage from the old file server is kept for
 * good and cannot be removed, so it counts only until this viewer has seen
 * it (in History or on the chat row); everything else counts until it is
 * restored or removed.
 */
export function badgeUnsavedWorkEntries(
  entries: WorkspaceRecoveryEntry[],
  seen: ReadonlySet<string>,
): WorkspaceRecoveryEntry[] {
  return pendingUnsavedWorkEntries(entries).filter(
    (entry) => entry.kind !== "salvage" || !seen.has(unsavedWorkSeenKey(entry)),
  );
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
  userId = null,
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
  const seen = useUnsavedWorkSeen(legacyInput.activeProjectId, userId);
  const unsavedCount = historyReady && !legacy ? badgeUnsavedWorkEntries(unsavedWork.entries, seen).length : 0;

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
