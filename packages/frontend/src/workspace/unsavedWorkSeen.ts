import { useMemo, useSyncExternalStore } from "react";
import type { WorkspaceRecoveryEntry } from "../sdk/instafy";

/**
 * Which unsaved-work entries this viewer has already been told about, so the
 * one-time chat row appears once per new entry. Per viewer and per browser:
 * nothing here is shared or written into the conversation.
 */

const SEEN_STORAGE_PREFIX = "instafy.unsavedWork.seen.";
/** Keep the newest recovery keys only; recovery refs are short-lived. */
const SEEN_LIMIT = 200;
/**
 * Salvage refs are kept for good and cannot be removed, and only being seen
 * stops them counting on the badge: newer recovery keys never push them out.
 * They have a cap of their own (one gateway salvage per space in practice).
 */
const SALVAGE_SEEN_LIMIT = 100;
const SALVAGE_REF_PREFIX = "refs/instafy/salvage/";

const seenListeners = new Set<() => void>();
let seenVersion = 0;

/** Called whenever this browser marks entries seen (the badge and the row follow). */
export function subscribeUnsavedWorkSeen(listener: () => void): () => void {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
}

function notifySeen(): void {
  seenVersion += 1;
  for (const listener of Array.from(seenListeners)) {
    try {
      listener();
    } catch (error) {
      console.warn("[unsaved-work] seen listener failed:", error);
    }
  }
}

function getSeenVersion(): number {
  return seenVersion;
}

function seenStorageKey(projectId: string, userId: string): string {
  return `${SEEN_STORAGE_PREFIX}${projectId}.${userId}`;
}

/** A moved ref (new work kept under the same name) counts as new. */
export function unsavedWorkSeenKey(entry: Pick<WorkspaceRecoveryEntry, "ref" | "rev">): string {
  return `${entry.ref}@${entry.rev}`;
}

function isSalvageSeenKey(key: string): boolean {
  return key.startsWith(SALVAGE_REF_PREFIX);
}

/** The newest keys of each kind, in their original order. */
function trimSeenKeys(keys: string[]): string[] {
  const kept = new Set([
    ...keys.filter(isSalvageSeenKey).slice(-SALVAGE_SEEN_LIMIT),
    ...keys.filter((key) => !isSalvageSeenKey(key)).slice(-SEEN_LIMIT),
  ]);
  return keys.filter((key) => kept.has(key));
}

/**
 * Marks this tab made that storage refused to keep (blocked site data, a
 * full quota, a locked-down webview), per project and viewer. Reads merge
 * them in, so Dismiss and History still retire what was seen for the rest of
 * the session.
 */
const seenInMemory = new Map<string, string[]>();

function readStoredSeen(storageKey: string): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch (_error) {
    return [];
  }
}

/** Stored keys first, then the ones only this tab holds, oldest first. */
function seenKeys(storageKey: string): string[] {
  const stored = readStoredSeen(storageKey);
  const memory = seenInMemory.get(storageKey) ?? [];
  if (memory.length === 0) {
    return stored;
  }
  const storedSet = new Set(stored);
  return [...stored, ...memory.filter((key) => !storedSet.has(key))];
}

export function readUnsavedWorkSeen(
  projectId: string | null | undefined,
  userId: string | null | undefined,
): Set<string> {
  if (!projectId || !userId) {
    return new Set();
  }
  return new Set(seenKeys(seenStorageKey(projectId, userId)));
}

export function markUnsavedWorkSeen(
  projectId: string | null | undefined,
  userId: string | null | undefined,
  keys: string[],
): Set<string> {
  if (!projectId || !userId || keys.length === 0) {
    return readUnsavedWorkSeen(projectId, userId);
  }
  const storageKey = seenStorageKey(projectId, userId);
  const seen = new Set(seenKeys(storageKey));
  for (const key of keys) {
    seen.delete(key);
    seen.add(key);
  }
  const kept = trimSeenKeys(Array.from(seen));
  // In memory first, so the marks hold for this session whatever storage does.
  seenInMemory.set(storageKey, kept);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(kept));
    seenInMemory.delete(storageKey);
  } catch (_error) {
    // Storage can be unavailable (private windows, blocked site data): the
    // marks last for this session and the row shows again next visit.
  }
  notifySeen();
  return new Set(kept);
}

export function resetUnsavedWorkSeenForTests(): void {
  seenInMemory.clear();
}

/** The entries this viewer has seen, kept current across every hook that marks them. */
export function useUnsavedWorkSeen(
  projectId: string | null | undefined,
  userId: string | null | undefined,
): Set<string> {
  const version = useSyncExternalStore(subscribeUnsavedWorkSeen, getSeenVersion, getSeenVersion);
  return useMemo(() => {
    void version;
    return readUnsavedWorkSeen(projectId, userId);
  }, [projectId, userId, version]);
}
