import type { WorkspaceRecoveryEntry } from "../sdk/instafy";

/**
 * Which unsaved-work entries this viewer has already been told about, so the
 * one-time chat row appears once per new entry. Per viewer and per browser:
 * nothing here is shared or written into the conversation.
 */

const SEEN_STORAGE_PREFIX = "instafy.unsavedWork.seen.";
/** Keep the newest keys only; recovery refs are short-lived. */
const SEEN_LIMIT = 200;

function seenStorageKey(projectId: string, userId: string): string {
  return `${SEEN_STORAGE_PREFIX}${projectId}.${userId}`;
}

/** A moved ref (new work kept under the same name) counts as new. */
export function unsavedWorkSeenKey(entry: Pick<WorkspaceRecoveryEntry, "ref" | "rev">): string {
  return `${entry.ref}@${entry.rev}`;
}

export function readUnsavedWorkSeen(
  projectId: string | null | undefined,
  userId: string | null | undefined,
): Set<string> {
  if (!projectId || !userId || typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(seenStorageKey(projectId, userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch (_error) {
    return new Set();
  }
}

export function markUnsavedWorkSeen(
  projectId: string | null | undefined,
  userId: string | null | undefined,
  keys: string[],
): Set<string> {
  const seen = readUnsavedWorkSeen(projectId, userId);
  if (!projectId || !userId || keys.length === 0) {
    return seen;
  }
  for (const key of keys) {
    seen.delete(key);
    seen.add(key);
  }
  const kept = Array.from(seen).slice(-SEEN_LIMIT);
  try {
    window.localStorage.setItem(seenStorageKey(projectId, userId), JSON.stringify(kept));
  } catch (_error) {
    // Storage can be unavailable (private windows); the row then shows again next visit.
  }
  return new Set(kept);
}
