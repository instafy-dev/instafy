import { useCallback, useEffect, useSyncExternalStore } from "react";
import { controllerClient, type OriginError, type WorkspaceRecoveryEntry } from "../sdk/instafy";

/**
 * Unsaved work kept on recovery and salvage refs, shared by the History
 * drawer, the sidebar badge and the one-time chat row. Only the `stateless`
 * and `desktop` modes read it; legacy spaces never call the route.
 *
 * Fetched on Studio load and project switch, when the drawer opens, on focus
 * when older than five minutes, and when a finished turn reports a recovery
 * ref. There is no interval: no event exists for ref creation.
 */

export type UnsavedWorkStatus = "idle" | "ok" | "unsupported" | "error";

export interface UnsavedWorkSnapshot {
  status: UnsavedWorkStatus;
  /** The last list that loaded. Kept through a later failed refresh. */
  entries: WorkspaceRecoveryEntry[];
  error: OriginError | null;
  fetchedAt: number | null;
  loading: boolean;
}

export const UNSAVED_WORK_FOCUS_REFRESH_MS = 5 * 60_000;
/** Mounts within this window reuse the list instead of fetching again. */
export const UNSAVED_WORK_MOUNT_REUSE_MS = 30_000;

const IDLE_SNAPSHOT: UnsavedWorkSnapshot = Object.freeze({
  status: "idle",
  entries: [],
  error: null,
  fetchedAt: null,
  loading: false,
}) as UnsavedWorkSnapshot;

const snapshots = new Map<string, UnsavedWorkSnapshot>();
const inflight = new Map<string, { seq: number; promise: Promise<UnsavedWorkSnapshot> }>();
const latestSeq = new Map<string, number>();
const listeners = new Set<() => void>();
let fetchSeq = 0;

function storeKey(projectId: string, originId: string): string {
  return `${projectId}:${originId}`;
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.warn("[unsaved-work] listener failed:", error);
    }
  }
}

function writeSnapshot(key: string, snapshot: UnsavedWorkSnapshot): UnsavedWorkSnapshot {
  snapshots.set(key, snapshot);
  notify();
  return snapshot;
}

export function getUnsavedWorkSnapshot(
  projectId: string | null | undefined,
  originId: string | null | undefined,
): UnsavedWorkSnapshot {
  if (!projectId || !originId) {
    return IDLE_SNAPSHOT;
  }
  return snapshots.get(storeKey(projectId, originId)) ?? IDLE_SNAPSHOT;
}

export function subscribeUnsavedWork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Entries that still hold unsaved work (a restored salvage entry does not). */
export function pendingUnsavedWorkEntries(entries: WorkspaceRecoveryEntry[]): WorkspaceRecoveryEntry[] {
  return entries.filter((entry) => !entry.restoredRev);
}

/**
 * Load the list. A list fetched within `maxAgeMs` is reused; a call while
 * another one is on the wire joins it unless `force` is set. Only the newest
 * fetch per key may store its answer.
 */
export async function refreshUnsavedWork(params: {
  projectId: string | null | undefined;
  originId: string | null | undefined;
  force?: boolean;
  maxAgeMs?: number;
}): Promise<UnsavedWorkSnapshot> {
  const projectId = params.projectId?.trim();
  const originId = params.originId?.trim();
  if (!projectId || !originId) {
    return IDLE_SNAPSHOT;
  }
  const key = storeKey(projectId, originId);
  const current = snapshots.get(key) ?? IDLE_SNAPSHOT;
  if (
    !params.force &&
    typeof params.maxAgeMs === "number" &&
    current.fetchedAt !== null &&
    current.status !== "error" &&
    Date.now() - current.fetchedAt < params.maxAgeMs
  ) {
    return current;
  }
  const pending = inflight.get(key);
  if (pending && !params.force) {
    return pending.promise;
  }

  const seq = ++fetchSeq;
  latestSeq.set(key, seq);
  if (!current.loading) {
    writeSnapshot(key, { ...current, loading: true });
  }

  const run = async (): Promise<UnsavedWorkSnapshot> => {
    const result = await controllerClient.workspace.git
      .fetchRecovery({ projectId, originId })
      .catch((error: unknown) => {
        console.warn("[unsaved-work] list failed:", error);
        return null;
      });
    if (latestSeq.get(key) !== seq) {
      return snapshots.get(key) ?? IDLE_SNAPSHOT;
    }
    const previous = snapshots.get(key) ?? IDLE_SNAPSHOT;
    const fetchedAt = Date.now();
    if (!result) {
      return writeSnapshot(key, {
        status: "error",
        entries: previous.entries,
        error: { status: 0, message: "unsaved work could not be listed", routeUnavailable: false },
        fetchedAt,
        loading: false,
      });
    }
    if (result.status === "unsupported") {
      return writeSnapshot(key, { status: "unsupported", entries: [], error: null, fetchedAt, loading: false });
    }
    if (result.status === "error") {
      return writeSnapshot(key, {
        status: "error",
        entries: previous.entries,
        error: result.error,
        fetchedAt,
        loading: false,
      });
    }
    return writeSnapshot(key, {
      status: "ok",
      entries: result.entries,
      error: null,
      fetchedAt,
      loading: false,
    });
  };

  const promise = run().finally(() => {
    if (inflight.get(key)?.seq === seq) {
      inflight.delete(key);
    }
  });
  inflight.set(key, { seq, promise });
  return promise;
}

/** Apply a local change after a restore or remove; the next fetch replaces it. */
export function patchUnsavedWorkEntries(
  projectId: string | null | undefined,
  originId: string | null | undefined,
  update: (entries: WorkspaceRecoveryEntry[]) => WorkspaceRecoveryEntry[],
): void {
  if (!projectId || !originId) {
    return;
  }
  const key = storeKey(projectId, originId);
  const current = snapshots.get(key);
  if (!current) {
    return;
  }
  writeSnapshot(key, { ...current, entries: update(current.entries) });
}

export function resetUnsavedWorkStoreForTests(): void {
  snapshots.clear();
  inflight.clear();
  latestSeq.clear();
  fetchSeq = 0;
  notify();
}

export interface UseUnsavedWorkResult extends UnsavedWorkSnapshot {
  refresh: (options?: { force?: boolean }) => Promise<UnsavedWorkSnapshot>;
}

/**
 * The unsaved-work list of one origin. With `enabled`, it loads on mount and
 * when the project or origin changes (reusing a list fetched moments ago),
 * and again on window focus when the list is older than five minutes.
 */
export function useUnsavedWork({
  projectId,
  originId,
  enabled,
}: {
  projectId: string | null | undefined;
  originId: string | null | undefined;
  enabled: boolean;
}): UseUnsavedWorkResult {
  const project = projectId?.trim() || null;
  const origin = originId?.trim() || null;
  const getSnapshot = useCallback(() => getUnsavedWorkSnapshot(project, origin), [project, origin]);
  const snapshot = useSyncExternalStore(subscribeUnsavedWork, getSnapshot, getSnapshot);
  const active = enabled && project !== null && origin !== null;

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!active) {
        return getUnsavedWorkSnapshot(project, origin);
      }
      return refreshUnsavedWork({ projectId: project, originId: origin, force: options?.force === true });
    },
    [active, origin, project],
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    void refreshUnsavedWork({
      projectId: project,
      originId: origin,
      maxAgeMs: UNSAVED_WORK_MOUNT_REUSE_MS,
    });
  }, [active, origin, project]);

  useEffect(() => {
    if (!active || typeof window === "undefined") {
      return undefined;
    }
    const handleFocus = () => {
      void refreshUnsavedWork({
        projectId: project,
        originId: origin,
        maxAgeMs: UNSAVED_WORK_FOCUS_REFRESH_MS,
      });
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [active, origin, project]);

  return { ...snapshot, refresh };
}
