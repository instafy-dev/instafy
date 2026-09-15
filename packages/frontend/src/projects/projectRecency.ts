const STORAGE_KEY = "instafy.projects.lastOpenedAt";
const MAX_ENTRIES = 200;
const MAX_STORAGE_LENGTH = 131_072;
export const PROJECT_RECENCY_CHANGE_EVENT = "instafy:project-recency-change";

export type ProjectRecencyMap = Record<string, number>;

// An omitted account preserves the legacy API. An explicitly missing account
// has no history; signed-in callers never inherit another account's visits.
export function getProjectRecencyStorageKey(userEmail?: string | null): string | null {
  if (userEmail === undefined) return STORAGE_KEY;
  const account = userEmail?.trim().toLowerCase();
  if (!account || account.length > 320) return null;
  try {
    return `${STORAGE_KEY}:account:${encodeURIComponent(account)}`;
  } catch {
    return null;
  }
}

function validProjectId(id: string): boolean {
  return id.trim().length > 0 && id.length <= 256 &&
    [...id].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
}

function boundedEntries(map: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(map)
    .filter((entry): entry is [string, number] =>
      validProjectId(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_ENTRIES);
}

export function readProjectRecency(userEmail?: string | null): ProjectRecencyMap {
  try {
    const key = getProjectRecencyStorageKey(userEmail);
    if (!key || typeof window === "undefined" || !window.localStorage) {
      return {};
    }
    const raw = window.localStorage.getItem(key);
    if (!raw || raw.length > MAX_STORAGE_LENGTH) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(boundedEntries(parsed as Record<string, unknown>));
  } catch {
    return {};
  }
}

export function recordProjectOpened(projectId: string, at: number = Date.now(), userEmail?: string | null) {
  try {
    const key = getProjectRecencyStorageKey(userEmail);
    if (!key || !validProjectId(projectId) || !Number.isFinite(at) || typeof window === "undefined" || !window.localStorage) {
      return;
    }
    const map = { ...readProjectRecency(userEmail), [projectId]: at };
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(boundedEntries(map))));
    window.dispatchEvent(new CustomEvent(PROJECT_RECENCY_CHANGE_EVENT, { detail: { key } }));
  } catch {
    // ignore storage failures
  }
}

/** Pick the most recently opened id among candidates; null when none has history. */
export function mostRecentProjectId(
  candidateIds: readonly string[],
  recency: ProjectRecencyMap = readProjectRecency(),
): string | null {
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const id of candidateIds) {
    const at = recency[id];
    if (typeof at === "number" && at > bestAt) {
      best = id;
      bestAt = at;
    }
  }
  return best;
}
