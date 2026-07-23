const STORAGE_KEY = "instafy.projects.lastOpenedAt";
const MAX_ENTRIES = 200;

export type ProjectRecencyMap = Record<string, number>;

export function readProjectRecency(): ProjectRecencyMap {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return {};
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const map: ProjectRecencyMap = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) {
        map[id] = at;
      }
    }
    return map;
  } catch {
    return {};
  }
}

export function recordProjectOpened(projectId: string, at: number = Date.now()) {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    const map = readProjectRecency();
    map[projectId] = at;
    const entries = Object.entries(map)
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
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
