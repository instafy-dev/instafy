import { useCallback, useEffect, useMemo, useRef } from "react";
import { useActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import { markUnsavedWorkSeen, unsavedWorkSeenKey, useUnsavedWorkSeen } from "../../../workspace/unsavedWorkSeen";
import { collectRecoveryRefs } from "../../../workspace/unsavedWorkSignals";
import { pendingUnsavedWorkEntries, useUnsavedWork } from "../../../workspace/unsavedWorkStore";

export const OPEN_SOURCE_CONTROL_EVENT = "instafy:open-source-control";

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
 * makes the list load again.
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

  const unseen = useMemo(() => {
    if (!enabled || unsavedWork.status !== "ok") {
      return [];
    }
    return pendingUnsavedWorkEntries(unsavedWork.visibleEntries).filter((entry) => !seen.has(unsavedWorkSeenKey(entry)));
  }, [enabled, seen, unsavedWork.visibleEntries, unsavedWork.status]);

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
