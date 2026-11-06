import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import { runtimeEntryIsReady } from "../../../runtime/utils/runtimeEntry";

// Undo of a change a Stop left unsaved (the turn's save never ran): there is
// no version to revert, so Undo puts the files back in the folder the turn
// ran in, as the saved version has them (`/git/revert` on that folder's own
// origin, with what the turn left in each file, which the origin checks). It
// is no message and no turn.

/**
 * The origin of the folder the space's turns run in on `runtimeId`, while
 * that machine serves it; null when it does not (it is stopped, or has no
 * origin of its own).
 */
export function runtimeFolderOriginId(
  statuses: readonly ControllerRuntimeStatusEntry[] | null | undefined,
  runtimeId: string | null | undefined,
): string | null {
  if (!runtimeId) return null;
  const origin = (statuses ?? []).find((entry) => entry.runtimeId === runtimeId)?.origin;
  const originId = typeof origin?.originId === "string" ? origin.originId.trim() : "";
  return originId && origin?.status !== "released" ? originId : null;
}

/**
 * The machine whose folder an Undo changes, for either Undo: the one that ran
 * the change's turn while it still serves its folder, else the space's one
 * ready machine that serves a folder, and only then the one the space's turns
 * run on now. That last one is often none: a space whose machine nobody chose
 * has none until a chat opens Instafy's browser.
 *
 * A change no save took is only in the folder of the machine that ran its
 * turn (named by the stopped turn's report). A saved version can be followed
 * by any folder that answers, so the machine the save went through (named by
 * its origin) counts only while it is ready: one that stopped answering keeps
 * its folder's origin until it is swept.
 */
export function undoFolderRuntimeId(
  statuses: readonly ControllerRuntimeStatusEntry[] | null | undefined,
  turn: { runtimeId?: string | null; originId?: string | null },
  effectiveRuntimeId: string | null | undefined,
): string | null {
  const entries = statuses ?? [];
  if (turn.runtimeId && runtimeFolderOriginId(entries, turn.runtimeId)) return turn.runtimeId;
  const turnOrigin = turn.originId?.trim();
  const savedFrom = turnOrigin
    ? entries.find(
        (entry) => runtimeEntryIsReady(entry) && runtimeFolderOriginId(entries, entry.runtimeId) === turnOrigin,
      )
    : undefined;
  if (savedFrom) return savedFrom.runtimeId;
  const ready = entries.filter((entry) => runtimeEntryIsReady(entry) && runtimeFolderOriginId(entries, entry.runtimeId));
  if (ready.length === 1) return ready[0]!.runtimeId;
  return effectiveRuntimeId ?? null;
}

/** Paths the folder's origin never puts back: its own metadata and repositories. */
export function isFolderRevertablePath(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments[0]?.toLowerCase() === ".instafy") return false;
  return !segments.some((segment) => {
    const lower = segment.toLowerCase();
    return lower === ".git" || lower === ".bind";
  });
}
