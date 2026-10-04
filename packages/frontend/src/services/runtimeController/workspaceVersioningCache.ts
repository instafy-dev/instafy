/**
 * In-memory record of how each workspace origin keeps versions, plus the
 * signals that correct it. Kept apart from the probe so the request modules
 * can report what they see without importing the probe (no import cycle).
 */

/**
 * - `legacy`: a cloud space on the stateful gateway (today's UI).
 * - `stateless`: a cloud space on the stateless gateway (`/git/status` says
 *   `stateless: true`): every save is a version.
 * - `desktop`: the project's default origin is a Desktop (or EFS) origin.
 */
export type VersioningMode = "legacy" | "stateless" | "desktop";

export type VersioningOriginMode = "hosted" | "desktop" | "efs" | "unknown";

/** Whether `GET /git/recovery` exists on this controller and origin. */
export type RecoverySupport = "unknown" | "supported" | "unsupported";

export interface OriginVersioning {
  projectId: string;
  originId: string;
  originMode: VersioningOriginMode;
  mode: VersioningMode;
  /** `/git/status` answered `stateless: true`. */
  stateless: boolean;
  recovery: RecoverySupport;
  /** Epoch ms of the probe that produced this entry. */
  checkedAt: number;
  /** A response contradicted this entry; it must be probed again before it is trusted. */
  stale: boolean;
}

/**
 * Something a response revealed about its origin.
 *
 * - `committed`: an apply or revert answered `committed: true`.
 * - `stateless`: a status answered `stateless: true`.
 * - `not_supported`: `/git/revert` answered 400 `not_supported`.
 * - `delete_requires_base_rev`: a delete without `baseRev` was refused.
 * - `legacy_saved`: a save in legacy mode finished; check the mode again.
 * - `recovery_supported` / `recovery_unsupported`: what `GET /git/recovery` answered.
 */
export type VersioningSignal =
  | "committed"
  | "stateless"
  | "not_supported"
  | "delete_requires_base_rev"
  | "legacy_saved"
  | "recovery_supported"
  | "recovery_unsupported";

/** Entries older than this are probed again on focus, reconnect or mount. */
export const VERSIONING_STALE_MS = 60_000;

const MODE_STORAGE_PREFIX = "instafy.versioning.mode.";

const STATELESS_SIGNALS: ReadonlySet<VersioningSignal> = new Set([
  "committed",
  "stateless",
  "not_supported",
  "delete_requires_base_rev",
]);

const entries = new Map<string, OriginVersioning>();
/** Recovery support learned before any probe stored an entry for the origin. */
const recoveryByOrigin = new Map<string, RecoverySupport>();
const listeners = new Set<() => void>();

function cacheKey(projectId: string, originId: string): string {
  return `${projectId}:${originId}`;
}

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.warn("[workspace-versioning] listener failed:", error);
    }
  }
}

export function getCachedWorkspaceVersioning(
  projectId: string | null | undefined,
  originId: string | null | undefined,
): OriginVersioning | null {
  if (!projectId || !originId) {
    return null;
  }
  return entries.get(cacheKey(projectId, originId)) ?? null;
}

export function knownRecoverySupport(originId: string): RecoverySupport {
  return recoveryByOrigin.get(originId) ?? "unknown";
}

/** Store a probe result (a new object, so subscribers see a new snapshot). */
export function storeWorkspaceVersioning(entry: OriginVersioning): OriginVersioning {
  const stored: OriginVersioning = {
    ...entry,
    recovery:
      entry.recovery !== "unknown" ? entry.recovery : knownRecoverySupport(entry.originId),
  };
  entries.set(cacheKey(stored.projectId, stored.originId), stored);
  writeLastVersioningMode(stored.projectId, stored.mode);
  notify();
  return stored;
}

/**
 * Record what a response revealed about an origin. A signal that contradicts
 * a cached `legacy` entry marks it stale so the next read probes again at
 * once; recovery signals update the entry in place.
 */
export function noteVersioningSignal(
  originId: string | null | undefined,
  signal: VersioningSignal,
): void {
  const id = originId?.trim();
  if (!id) {
    return;
  }
  let changed = false;
  if (signal === "recovery_supported" || signal === "recovery_unsupported") {
    const recovery: RecoverySupport = signal === "recovery_supported" ? "supported" : "unsupported";
    if (recoveryByOrigin.get(id) !== recovery) {
      recoveryByOrigin.set(id, recovery);
    }
    for (const [key, entry] of entries) {
      if (entry.originId === id && entry.recovery !== recovery) {
        entries.set(key, { ...entry, recovery });
        changed = true;
      }
    }
  } else {
    for (const [key, entry] of entries) {
      if (entry.originId !== id || entry.stale) {
        continue;
      }
      const contradicts =
        signal === "legacy_saved" || (STATELESS_SIGNALS.has(signal) && entry.mode === "legacy");
      if (contradicts) {
        entries.set(key, { ...entry, stale: true });
        changed = true;
      }
    }
  }
  if (changed) {
    notify();
  }
}

/** Subscribe to cache changes (shape fits `useSyncExternalStore`). */
export function subscribeWorkspaceVersioning(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch (_error) {
    return null;
  }
}

/** The last probed mode for a project: a first-paint guess only, never a routing decision. */
export function readLastVersioningMode(projectId: string | null | undefined): VersioningMode | null {
  if (!projectId) {
    return null;
  }
  try {
    const value = storage()?.getItem(`${MODE_STORAGE_PREFIX}${projectId}`);
    return value === "legacy" || value === "stateless" || value === "desktop" ? value : null;
  } catch (_error) {
    return null;
  }
}

function writeLastVersioningMode(projectId: string, mode: VersioningMode): void {
  try {
    storage()?.setItem(`${MODE_STORAGE_PREFIX}${projectId}`, mode);
  } catch (_error) {
    // Storage can be unavailable (private mode, quota); the guess is optional.
  }
}

/** Test hook: drop every cached entry and listener. */
export function resetWorkspaceVersioningCacheForTests(): void {
  entries.clear();
  recoveryByOrigin.clear();
  listeners.clear();
}
