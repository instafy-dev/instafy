import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  controllerClient,
  type ControllerRuntimeStatusEntry,
  type OriginError,
  type WorkspaceRecoveryEntry,
} from "../sdk/instafy";

/**
 * Unsaved work kept on recovery refs, shared by the History
 * drawer, the sidebar badge and the one-time chat row. Only the `stateless`
 * and `desktop` modes read it; legacy spaces never call the route.
 *
 * Fetched on Studio load and project switch, when the drawer opens, on focus
 * when older than five minutes, when a finished turn reports a recovery
 * ref, and when a runtime whose rolling save may be listed stops. There is
 * no interval: no event exists for ref creation.
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
/**
 * A list has carried a rolling save. Until one does, a stop fetches nothing
 * again, so a server without the flag sees no change.
 */
let rollingSavesListed = false;

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
  if (snapshot.status === "ok" || snapshot.status === "unsupported") {
    pruneConflicts(key, snapshot.entries);
  }
  if (!rollingSavesListed && snapshot.entries.some((entry) => entry.rollingSave === true)) {
    rollingSavesListed = true;
  }
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

/** Entries that still hold unsaved work (a restored entry does not). */
export function pendingUnsavedWorkEntries(entries: WorkspaceRecoveryEntry[]): WorkspaceRecoveryEntry[] {
  return entries.filter((entry) => !entry.restoredRev);
}

/** Which rolling saves Studio hides, for one project. */
export interface RollingSaveScope {
  /**
   * Which origins are live is known. Until it is, every rolling save is
   * hidden: one shown at first paint could belong to a running workspace.
   */
  known: boolean;
  /** Origins whose rolling saves are hidden: live ones, and stopped ones until the list is fetched again. */
  hidden: ReadonlySet<string>;
}

const EMPTY_ORIGINS: ReadonlySet<string> = new Set<string>();
const UNKNOWN_SCOPE: RollingSaveScope = Object.freeze({ known: false, hidden: EMPTY_ORIGINS });

/**
 * The entries Studio shows: the Unsaved work section, the badge and the
 * chat row all read through this one filter. A rolling save is hidden while
 * the origin that last wrote it is live, because its rev changes on every
 * save and a Restore or Remove would race the turn's own publish. Entries
 * without the server's `rollingSave` flag always show, and a list without
 * one is returned as it is.
 */
export function visibleUnsavedWorkEntries(
  entries: WorkspaceRecoveryEntry[],
  scope: RollingSaveScope,
): WorkspaceRecoveryEntry[] {
  if (!entries.some((entry) => entry.rollingSave === true)) {
    return entries;
  }
  return entries.filter((entry) => {
    if (entry.rollingSave !== true) {
      return true;
    }
    if (!scope.known) {
      return false;
    }
    return !entry.origin || !scope.hidden.has(entry.origin);
  });
}

// ---------------------------------------------------------------------------
// Live origins: which rolling saves are hidden, and the list after a stop
// ---------------------------------------------------------------------------

/** Wait this long after an origin stops, so stops close together share one list. */
export const UNSAVED_WORK_STOP_REFETCH_DELAY_MS = 1_000;

interface LiveOriginsRecord {
  projectId: string;
  /** The last live set the runtime status reported; null until one arrives. */
  live: ReadonlySet<string> | null;
  /** Origins that stopped: their rolling saves stay hidden until the list is fetched again. */
  settling: ReadonlySet<string>;
  scope: RollingSaveScope;
}

let liveOrigins: LiveOriginsRecord | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function liveOriginsRecord(
  projectId: string,
  live: ReadonlySet<string> | null,
  settling: ReadonlySet<string>,
): LiveOriginsRecord {
  const scope: RollingSaveScope =
    live === null
      ? UNKNOWN_SCOPE
      : { known: true, hidden: settling.size === 0 ? live : new Set([...live, ...settling]) };
  return { projectId, live, settling, scope };
}

function sameOrigins(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false;
    }
  }
  return true;
}

function cancelSettle(): void {
  if (settleTimer !== null) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

/** The origins the runtime status calls live: each visible runtime's latest unreleased origin. */
export function liveOriginIds(statuses: readonly ControllerRuntimeStatusEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of statuses) {
    const origin = entry.origin;
    const originId = typeof origin?.originId === "string" ? origin.originId.trim() : "";
    if (originId && origin?.status !== "released") {
      ids.push(originId);
    }
  }
  return ids;
}

/**
 * Record the live origins of `projectId`, or `null` while they are not
 * known (before the first runtime status, or while it loads again). An
 * unknown moment keeps the last known set. An origin that leaves the set
 * keeps its rolling saves hidden until the project's lists are fetched
 * again, so the final save appears once, with its final rev.
 */
export function setUnsavedWorkLiveOrigins(
  projectId: string | null | undefined,
  originIds: Iterable<string> | null,
): void {
  const project = projectId?.trim() || null;
  const current = liveOrigins && liveOrigins.projectId === project ? liveOrigins : null;
  if (!current) {
    // Another project, or none: nothing carries over.
    cancelSettle();
    if (!project) {
      if (liveOrigins) {
        liveOrigins = null;
        notify();
      }
      return;
    }
    liveOrigins = liveOriginsRecord(project, originIds === null ? null : new Set(originIds), EMPTY_ORIGINS);
    notify();
    return;
  }
  if (originIds === null) {
    return;
  }
  const live = new Set(originIds);
  const departed =
    rollingSavesListed && current.live ? [...current.live].filter((id) => !live.has(id)) : [];
  if (current.live && departed.length === 0 && sameOrigins(current.live, live)) {
    return;
  }
  const settling = departed.length === 0 ? current.settling : new Set([...current.settling, ...departed]);
  const sameProject = current.projectId;
  liveOrigins = liveOriginsRecord(sameProject, live, settling);
  if (departed.length > 0) {
    cancelSettle();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void settleStoppedOrigins(sameProject);
    }, UNSAVED_WORK_STOP_REFETCH_DELAY_MS);
  }
  notify();
}

/**
 * Fetch every list of `projectId` that has loaded again, then show the
 * stopped origins' saves. Legacy spaces never loaded one, so they fetch
 * nothing.
 */
async function settleStoppedOrigins(projectId: string): Promise<void> {
  const batch = liveOrigins?.projectId === projectId ? liveOrigins.settling : EMPTY_ORIGINS;
  if (batch.size === 0) {
    return;
  }
  const prefix = `${projectId}:`;
  const originIds: string[] = [];
  for (const [key, snapshot] of snapshots) {
    if (key.startsWith(prefix) && (snapshot.status === "ok" || snapshot.status === "error")) {
      originIds.push(key.slice(prefix.length));
    }
  }
  await Promise.allSettled(
    originIds.map((originId) => refreshUnsavedWork({ projectId, originId, force: true })),
  );
  // A newer forced fetch may have taken over one of these: show its answer.
  await Promise.allSettled(originIds.map((originId) => inflight.get(storeKey(projectId, originId))?.promise));
  const record = liveOrigins;
  if (!record || record.projectId !== projectId) {
    return;
  }
  const settling = new Set([...record.settling].filter((id) => !batch.has(id)));
  liveOrigins = liveOriginsRecord(projectId, record.live, settling);
  notify();
}

/** Which rolling saves are hidden in `projectId` right now. */
export function getRollingSaveScope(projectId: string | null | undefined): RollingSaveScope {
  const project = projectId?.trim() || null;
  return liveOrigins && project && liveOrigins.projectId === project ? liveOrigins.scope : UNKNOWN_SCOPE;
}

/**
 * Feed the live origins from the runtime status. Mounted once, where the
 * statuses are kept. Statuses still held from the previous project count as
 * unknown, so a project switch never shows the new project's live saves.
 */
export function usePublishUnsavedWorkLiveOrigins({
  projectId,
  runtimeStatuses,
  resolved,
}: {
  projectId: string | null | undefined;
  runtimeStatuses: readonly ControllerRuntimeStatusEntry[];
  /** The runtime status has answered for the current project. */
  resolved: boolean;
}): void {
  const project = projectId?.trim() || null;
  const seenRef = useRef<{
    projectId: string | null;
    statuses: readonly ControllerRuntimeStatusEntry[];
    stale: readonly ControllerRuntimeStatusEntry[] | null;
  } | null>(null);
  useEffect(() => {
    const previous = seenRef.current;
    const stale = previous && previous.projectId !== project ? previous.statuses : (previous?.stale ?? null);
    seenRef.current = { projectId: project, statuses: runtimeStatuses, stale };
    const known = resolved && runtimeStatuses !== stale;
    setUnsavedWorkLiveOrigins(project, known ? liveOriginIds(runtimeStatuses) : null);
  }, [project, resolved, runtimeStatuses]);
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

// ---------------------------------------------------------------------------
// Restore conflicts in progress
// ---------------------------------------------------------------------------

export type UnsavedWorkPathChoice = "use" | "keep";

/** A restore that refused, and the per-file choices made since. */
export interface UnsavedWorkConflict {
  /** The entry's rev the restore was for; a moved ref drops the choices. */
  rev: string;
  /** `main` when the restore refused; per-file saves build on it. */
  head: string | null;
  paths: string[];
  resolutions: Record<string, UnsavedWorkPathChoice>;
  /**
   * Paths whose "Use this version" the space refused as `path_alias`:
   * another entry has the name in another case or Unicode form. A restore
   * conflict does not say why each path conflicts, so this is learned only
   * from such a refusal.
   */
  aliases?: string[];
}

export type UnsavedWorkConflicts = Readonly<Record<string, UnsavedWorkConflict>>;

const EMPTY_CONFLICTS: UnsavedWorkConflicts = Object.freeze({});
const conflictStates = new Map<string, UnsavedWorkConflicts>();

/**
 * Per-file choices live here, not in the drawer, so they survive the drawer
 * closing (asking the agent about one file opens the chat) and reopening.
 */
export function getUnsavedWorkConflicts(
  projectId: string | null | undefined,
  originId: string | null | undefined,
): UnsavedWorkConflicts {
  if (!projectId || !originId) {
    return EMPTY_CONFLICTS;
  }
  return conflictStates.get(storeKey(projectId, originId)) ?? EMPTY_CONFLICTS;
}

export function updateUnsavedWorkConflicts(
  projectId: string | null | undefined,
  originId: string | null | undefined,
  update: (current: UnsavedWorkConflicts) => UnsavedWorkConflicts,
): void {
  if (!projectId || !originId) {
    return;
  }
  const key = storeKey(projectId, originId);
  const current = conflictStates.get(key) ?? EMPTY_CONFLICTS;
  const next = update(current);
  if (next === current) {
    return;
  }
  if (Object.keys(next).length === 0) {
    conflictStates.delete(key);
  } else {
    conflictStates.set(key, next);
  }
  notify();
}

/** Drop choices for entries that left the list or now point at other work. */
function pruneConflicts(key: string, entries: WorkspaceRecoveryEntry[]): void {
  const current = conflictStates.get(key);
  if (!current) {
    return;
  }
  const revs = new Map(entries.map((entry) => [entry.ref, entry.rev]));
  const next: Record<string, UnsavedWorkConflict> = {};
  let changed = false;
  for (const [ref, conflict] of Object.entries(current)) {
    if (revs.get(ref) === conflict.rev) {
      next[ref] = conflict;
    } else {
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  if (Object.keys(next).length === 0) {
    conflictStates.delete(key);
  } else {
    conflictStates.set(key, next);
  }
}

export function resetUnsavedWorkStoreForTests(): void {
  snapshots.clear();
  inflight.clear();
  latestSeq.clear();
  conflictStates.clear();
  fetchSeq = 0;
  cancelSettle();
  liveOrigins = null;
  rollingSavesListed = false;
  notify();
}

/** The restore conflicts in progress for one origin, shared by every mount. */
export function useUnsavedWorkConflicts(
  projectId: string | null | undefined,
  originId: string | null | undefined,
): [UnsavedWorkConflicts, (update: (current: UnsavedWorkConflicts) => UnsavedWorkConflicts) => void] {
  const project = projectId?.trim() || null;
  const origin = originId?.trim() || null;
  const getSnapshot = useCallback(() => getUnsavedWorkConflicts(project, origin), [project, origin]);
  const conflicts = useSyncExternalStore(subscribeUnsavedWork, getSnapshot, getSnapshot);
  const update = useCallback(
    (change: (current: UnsavedWorkConflicts) => UnsavedWorkConflicts) =>
      updateUnsavedWorkConflicts(project, origin, change),
    [project, origin],
  );
  return [conflicts, update];
}

export interface UseUnsavedWorkResult extends UnsavedWorkSnapshot {
  /** `entries` as Studio shows them (see `visibleUnsavedWorkEntries`). */
  visibleEntries: WorkspaceRecoveryEntry[];
  refresh: (options?: { force?: boolean }) => Promise<UnsavedWorkSnapshot>;
}

/**
 * The unsaved-work list of one origin. With `enabled`, it loads on mount and
 * when the project or origin changes (reusing a list fetched moments ago,
 * unless `mountRefresh` is `force`, as when the History drawer opens), and
 * again on window focus when the list is older than five minutes.
 * `visibleEntries` leaves out a running workspace's rolling save.
 */
export function useUnsavedWork({
  projectId,
  originId,
  enabled,
  mountRefresh = "reuse",
}: {
  projectId: string | null | undefined;
  originId: string | null | undefined;
  enabled: boolean;
  mountRefresh?: "reuse" | "force";
}): UseUnsavedWorkResult {
  const project = projectId?.trim() || null;
  const origin = originId?.trim() || null;
  const getSnapshot = useCallback(() => getUnsavedWorkSnapshot(project, origin), [project, origin]);
  const snapshot = useSyncExternalStore(subscribeUnsavedWork, getSnapshot, getSnapshot);
  const getScope = useCallback(() => getRollingSaveScope(project), [project]);
  const scope = useSyncExternalStore(subscribeUnsavedWork, getScope, getScope);
  const visibleEntries = useMemo(() => visibleUnsavedWorkEntries(snapshot.entries, scope), [scope, snapshot.entries]);
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
      force: mountRefresh === "force",
      maxAgeMs: UNSAVED_WORK_MOUNT_REUSE_MS,
    });
  }, [active, mountRefresh, origin, project]);

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

  return { ...snapshot, visibleEntries, refresh };
}
