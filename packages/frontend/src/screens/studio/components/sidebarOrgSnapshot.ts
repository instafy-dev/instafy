import { normalizeOrgAccent } from "../../../org/orgAccent";
import type { ControllerOrgSummary } from "../../../sdk/instafy";

/**
 * Stale-while-revalidate cache for the sidebar's team rail.
 *
 * The rail is rendered from `listControllerOrganizations()`, which cannot even
 * start until auth resolves. Without a cache the first paint reserves zero
 * height and the rail pops in, shoving everything below it down. We persist the
 * bare minimum needed to paint the rail at the right size and identity, keyed
 * per user, and hydrate from it on mount.
 *
 * Every read/write is best-effort: a missing, foreign, malformed or
 * unwritable store degrades silently to the pre-cache behaviour (no rail).
 */

const STORAGE_KEY_PREFIX = "instafy:sidebar-orgs:v1:";
/** Storing more orgs than the rail could ever consult is pure bloat. */
const MAX_CACHED_ORGS = 24;
/** Guards against a corrupt/absurd count reserving a screen-high gap. */
const MAX_RAIL_CHIP_COUNT = 99;

/** The only org fields the rail (and its labels) actually read. */
export interface CachedSidebarOrg {
  id: string;
  name: string;
  slug: string | null;
  avatarUrl: string | null;
  accentColor?: string | null;
}

export interface SidebarOrgSnapshot {
  /** Normalized owner of the snapshot; re-checked on read, not just via the key. */
  user: string;
  orgs: CachedSidebarOrg[];
  /**
   * How many chips the rail rendered last time (`teamRailTeams.length`).
   * `> 1` doubles as the "this user has a team rail" flag and gives the
   * loading placeholder the right height in the collapsed (stacked) layout.
   */
  railChipCount: number;
}

export function normalizeSidebarOrgUser(userEmail: string | null | undefined): string | null {
  if (typeof userEmail !== "string") {
    return null;
  }
  const trimmed = userEmail.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function sidebarOrgSnapshotStorageKey(userEmail: string | null | undefined): string | null {
  const user = normalizeSidebarOrgUser(userEmail);
  return user ? `${STORAGE_KEY_PREFIX}${user}` : null;
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    return window.localStorage;
  } catch {
    // Accessing localStorage throws outright in some privacy modes.
    return null;
  }
}

function toCachedOrg(value: unknown): CachedSidebarOrg | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : null;
  const name = typeof record.name === "string" ? record.name : null;
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    slug: typeof record.slug === "string" ? record.slug : null,
    avatarUrl: typeof record.avatarUrl === "string" ? record.avatarUrl : null,
    ...(normalizeOrgAccent(record.accentColor) ? { accentColor: normalizeOrgAccent(record.accentColor) } : {}),
  };
}

/** Reads the snapshot for `userEmail`; null unless it exists AND belongs to them. */
export function readSidebarOrgSnapshot(
  userEmail: string | null | undefined,
): SidebarOrgSnapshot | null {
  const user = normalizeSidebarOrgUser(userEmail);
  const key = sidebarOrgSnapshotStorageKey(userEmail);
  const storage = getLocalStorage();
  if (!user || !key || !storage) {
    return null;
  }
  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (normalizeSidebarOrgUser(typeof record.user === "string" ? record.user : null) !== user) {
      return null;
    }
    const orgs = Array.isArray(record.orgs)
      ? record.orgs
          .map(toCachedOrg)
          .filter((org): org is CachedSidebarOrg => org !== null)
          .slice(0, MAX_CACHED_ORGS)
      : [];
    const rawCount = record.railChipCount;
    const railChipCount =
      typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0
        ? Math.min(Math.floor(rawCount), MAX_RAIL_CHIP_COUNT)
        : 0;
    return { user, orgs, railChipCount };
  } catch {
    // Malformed JSON, a hostile value, a throwing storage — treat as no cache.
    return null;
  }
}

/** The cached orgs as the component's state shape; `[]` whenever nothing usable is cached. */
export function readCachedControllerOrgs(
  userEmail: string | null | undefined,
): ControllerOrgSummary[] {
  const snapshot = readSidebarOrgSnapshot(userEmail);
  if (!snapshot) {
    return [];
  }
  return snapshot.orgs.map((org) => ({
    id: org.id,
    slug: org.slug ?? "",
    name: org.name,
    avatarUrl: org.avatarUrl,
    ...(org.accentColor ? { accentColor: org.accentColor } : {}),
  }));
}

/** True when the last successful load for this user rendered a team rail. */
export function sidebarTeamRailExpected(userEmail: string | null | undefined): boolean {
  return (readSidebarOrgSnapshot(userEmail)?.railChipCount ?? 0) > 1;
}

/** Persists the minimal rail snapshot. Never throws (quota, private mode, SSR). */
export function writeSidebarOrgSnapshot(
  userEmail: string | null | undefined,
  orgs: readonly ControllerOrgSummary[],
  railChipCount: number,
): void {
  const user = normalizeSidebarOrgUser(userEmail);
  const key = sidebarOrgSnapshotStorageKey(userEmail);
  const storage = getLocalStorage();
  if (!user || !key || !storage) {
    return;
  }
  const snapshot: SidebarOrgSnapshot = {
    user,
    orgs: orgs.slice(0, MAX_CACHED_ORGS).map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug ?? null,
      avatarUrl: org.avatarUrl ?? null,
      ...(normalizeOrgAccent(org.accentColor) ? { accentColor: normalizeOrgAccent(org.accentColor) } : {}),
    })),
    railChipCount:
      Number.isFinite(railChipCount) && railChipCount > 0
        ? Math.min(Math.floor(railChipCount), MAX_RAIL_CHIP_COUNT)
        : 0,
  };
  try {
    storage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // Quota exceeded / storage disabled: the rail just pops in, as it used to.
  }
}
