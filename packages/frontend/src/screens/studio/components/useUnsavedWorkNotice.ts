import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WorkspaceRecoveryEntry } from "../../../sdk/instafy";
import { useActiveWorkspaceVersioning } from "../../../workspace/useActiveWorkspaceVersioning";
import { markUnsavedWorkSeen, unsavedWorkSeenKey, useUnsavedWorkSeen } from "../../../workspace/unsavedWorkSeen";
import { collectRecoveryRefs } from "../../../workspace/unsavedWorkSignals";
import { pendingUnsavedWorkEntries, useUnsavedWork } from "../../../workspace/unsavedWorkStore";
import { normalizeUndonePath, readChangeUndone } from "./chatLaterChanges";

export const OPEN_SOURCE_CONTROL_EVENT = "instafy:open-source-control";

type ChatLine = { metadata?: Record<string, unknown> | null; timestamp?: number };

/** An Undo line of the chat (`change_undone`): when it was recorded, its files, and whether a person's Undo left it. */
type UndoLine = { at: number; paths: ReadonlySet<string>; byPerson: boolean };

/**
 * How far an Undo line may read before the moment its work was kept (the
 * machine that kept it and the chat's server keep their own clocks), and how
 * long after it the line may come: once the Undo's answer reached Studio, or
 * the next turn reported its take-back, with their tries again.
 */
const KEPT_LINE_EARLIER_MS = 5_000;
const KEPT_LINE_LATER_MS = 60_000;

/** A kept ref's name, which begins with when it was kept: `<UTC time>-undone-<hash>`. */
const KEPT_NAME = /(?:^|\/)(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-undone-[^/]*$/;

/** When an entry's work was kept: its commit's date, else the time its name begins with. */
function keptAt(entry: WorkspaceRecoveryEntry): number | null {
  const date = entry.date ? Date.parse(entry.date) : Number.NaN;
  if (Number.isFinite(date)) return date;
  const name = KEPT_NAME.exec(entry.ref);
  if (!name) return null;
  const [year, month, day, hour, minute, second] = name.slice(1).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function undoLines(messages: ReadonlyArray<ChatLine>): UndoLine[] {
  const named = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  return messages.flatMap((message) => {
    const line = readChangeUndone(message);
    if (!line || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return [];
    const metadata = message.metadata as Record<string, unknown>;
    return [{
      at: message.timestamp,
      paths: new Set(line.paths),
      byPerson: named(metadata.actorUserId) && !named(metadata.putBackByJobId),
    }];
  });
}

/**
 * Whether the open chat tells of an entry. Work kept when a change was taken
 * back (an `undone` entry) is told only in the chat whose Undo kept it, when
 * that was a person's Undo: the chat's Undo line that names every one of its
 * files and was recorded nearest the moment it was kept, within a minute
 * after. Work Octo's own next turn kept, putting back a change a Stop left
 * unsaved, is told in no chat: its row already reads "Undone", and History
 * keeps it. So is work no line of the chat can be tied to. Any other entry
 * shows in each chat, as before: another chat can't tell where it came from.
 */
function toldInThisChat(entry: WorkspaceRecoveryEntry, lines: readonly UndoLine[]): boolean {
  if (entry.kind !== "undone") return true;
  const at = keptAt(entry);
  const files = entry.paths.map(normalizeUndonePath).filter((path) => path.length > 0);
  if (at === null || files.length === 0) return false;
  let keptBy: UndoLine | null = null;
  for (const line of lines) {
    const after = line.at - at;
    if (after < -KEPT_LINE_EARLIER_MS || after > KEPT_LINE_LATER_MS) continue;
    if (!files.every((path) => line.paths.has(path))) continue;
    if (!keptBy || Math.abs(after) < Math.abs(keptBy.at - at)) keptBy = line;
  }
  return keptBy?.byPerson === true;
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
  messages: ReadonlyArray<ChatLine>;
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

  // The chat's Undo lines: the work a person's Undo here kept is this chat's to tell.
  const lines = useMemo(() => undoLines(messages), [messages]);
  const unseen = useMemo(() => {
    if (!enabled || unsavedWork.status !== "ok") {
      return [];
    }
    return pendingUnsavedWorkEntries(unsavedWork.visibleEntries).filter(
      (entry) => !seen.has(unsavedWorkSeenKey(entry)) && toldInThisChat(entry, lines),
    );
  }, [enabled, lines, seen, unsavedWork.visibleEntries, unsavedWork.status]);

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
