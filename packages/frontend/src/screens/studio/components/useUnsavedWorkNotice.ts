import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WorkspaceRecoveryEntry } from "../../../sdk/instafy";
import { useActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import { markUnsavedWorkSeen, unsavedWorkSeenKey, useUnsavedWorkSeen } from "../../../workspace/unsavedWorkSeen";
import { collectRecoveryRefs } from "../../../workspace/unsavedWorkSignals";
import { pendingUnsavedWorkEntries, useUnsavedWork } from "../../../workspace/unsavedWorkStore";
import { filesUndoneByPerson, normalizeUndonePath } from "./chatLaterChanges";

export const OPEN_SOURCE_CONTROL_EVENT = "instafy:open-source-control";

/**
 * Whether the open chat tells of an entry. Work kept when a change was taken
 * back (an `undone` entry) comes from one chat: it shows only in the chat
 * where a person's Undo kept it, that Undo's line naming every one of its
 * files. Work kept when Octo's own next turn put back a change a Stop left
 * unsaved shows in no chat: its row already reads "Undone", and History
 * keeps it. Any other entry shows in each chat, as before: another chat
 * can't tell where it came from.
 */
function toldInThisChat(entry: WorkspaceRecoveryEntry, undoneHere: ReadonlySet<string>): boolean {
  if (entry.kind !== "undone") return true;
  return entry.paths.length > 0 && entry.paths.every((path) => undoneHere.has(normalizeUndonePath(path)));
}

export interface UnsavedWorkNotice {
  /** New entries this viewer has not been told about. */
  count: number;
  onOpenHistory: () => void;
  onDismiss: () => void;
}

/**
 * The one-time chat row for new unsaved work (stateless and desktop modes).
 * Per viewer and not written into the conversation: entries this viewer
 * has seen (opened History from the row, or dismissed it) are remembered in
 * localStorage. A finished turn whose artifacts report a new recovery ref
 * makes the list load again. Work kept when a change was taken back shows
 * only in its own chat, or in none (`toldInThisChat`).
 */
export function useUnsavedWorkNotice({
  userId,
  messages,
}: {
  userId: string | null;
  messages: ReadonlyArray<{ metadata?: Record<string, unknown> | null }>;
}): UnsavedWorkNotice | null {
  const versioning = useActiveWorkspaceVersioning();
  const projectId = versioning.projectId;
  const enabled = versioning.historyReady;
  const unsavedWork = useUnsavedWork({ projectId, originId: versioning.originId, enabled });
  // Shared: History marks the entries it shows as seen too.
  const seen = useUnsavedWorkSeen(projectId, userId);
  const { refresh } = unsavedWork;

  // New recovery refs on finished turns: list again. The first look at the
  // transcript is covered by the load on mount.
  const reportedRefs = useMemo(() => collectRecoveryRefs(messages), [messages]);
  const knownRefsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const known = knownRefsRef.current;
    knownRefsRef.current = new Set([...(known ?? []), ...reportedRefs]);
    if (known === null || !enabled) {
      return;
    }
    if (reportedRefs.some((ref) => !known.has(ref))) {
      void refresh({ force: true });
    }
  }, [enabled, refresh, reportedRefs]);

  // The files a person undid in this chat: the work those Undos kept is this chat's to tell.
  const undoneHere = useMemo(() => filesUndoneByPerson(messages), [messages]);
  const unseen = useMemo(() => {
    if (!enabled || unsavedWork.status !== "ok") {
      return [];
    }
    return pendingUnsavedWorkEntries(unsavedWork.visibleEntries).filter(
      (entry) => !seen.has(unsavedWorkSeenKey(entry)) && toldInThisChat(entry, undoneHere),
    );
  }, [enabled, seen, undoneHere, unsavedWork.visibleEntries, unsavedWork.status]);

  const markSeen = useCallback(() => {
    markUnsavedWorkSeen(projectId, userId, unseen.map(unsavedWorkSeenKey));
  }, [projectId, unseen, userId]);

  const openHistory = useCallback(() => {
    markSeen();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(OPEN_SOURCE_CONTROL_EVENT, { detail: { projectId } }));
    }
  }, [markSeen, projectId]);

  if (!userId || !projectId || unseen.length === 0) {
    return null;
  }
  return { count: unseen.length, onOpenHistory: openHistory, onDismiss: markSeen };
}
