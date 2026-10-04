import type { CodeFile, CodeWorkspace } from "../types";

/**
 * Undo and redo restore whole workspace snapshots. For buffers read from a
 * pinned origin (the versioned modes set `originId`), the fields that say
 * which saved version the buffer is based on must not travel back in time:
 * an undo after a save would otherwise make the next save claim the
 * pre-save revision and conflict with its own commit. Only the text the user
 * edits (`modified`) is restored; the base text and read ids stay current.
 * Buffers without an `originId` (legacy reads) are restored as before.
 */
export function keepSavedVersionIds(restored: CodeWorkspace, current: CodeWorkspace): CodeWorkspace {
  const currentById = new Map(current.files.map((file) => [file.id, file]));
  let changed = false;
  const files = restored.files.map((file) => {
    const now = currentById.get(file.id);
    if (!now || !now.originId) {
      return file;
    }
    const next: CodeFile = {
      ...file,
      generated: now.generated,
      baseRev: now.baseRev ?? null,
      blobOid: now.blobOid ?? null,
      originId: now.originId,
      readAt: now.readAt ?? null,
    };
    if (now.isNew === true) {
      next.isNew = true;
    } else {
      delete next.isNew;
    }
    changed = true;
    return next;
  });
  return changed ? { ...restored, files } : restored;
}
