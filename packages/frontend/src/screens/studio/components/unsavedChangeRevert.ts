import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";

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

/** Paths the folder's origin never puts back: its own metadata and repositories. */
export function isFolderRevertablePath(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments[0]?.toLowerCase() === ".instafy") return false;
  return !segments.some((segment) => {
    const lower = segment.toLowerCase();
    return lower === ".git" || lower === ".bind";
  });
}
