import fs from "node:fs";
import path from "node:path";

/**
 * Teammate activity in a Personal Browser profile.
 *
 * The profile belongs to its owner, but a teammate can act in it through
 * tab-share control or Explore, which use the owner's browser session and its
 * sign-ins. While a profile is marked, routine runs ask per site again, except
 * for the card's own hosts the owner allowed at the start. Only host names
 * are kept, never paths or page content.
 */
export type PersonalBrowserTeammateActivity = {
  /** Hosts the teammate visited, oldest first, at most MAX_TEAMMATE_SITES. */
  sites: string[];
  markedAtMs: number;
};

export interface PersonalBrowserTeammateActivityStore {
  read(partition: string): PersonalBrowserTeammateActivity | null;
  mark(partition: string, url: string | null): void;
  clear(partition: string): void;
}

export const MAX_TEAMMATE_SITES = 20;
const MAX_PROFILES = 64;
const FILE_VERSION = 1;

/** The host of an http(s) address, or null for anything else. */
export function teammateActivitySite(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function withSite(
  previous: PersonalBrowserTeammateActivity | null,
  url: string | null,
  now: number,
): PersonalBrowserTeammateActivity {
  const sites = previous ? [...previous.sites] : [];
  const site = teammateActivitySite(url);
  if (site) {
    const existing = sites.indexOf(site);
    if (existing >= 0) sites.splice(existing, 1);
    sites.push(site);
    while (sites.length > MAX_TEAMMATE_SITES) sites.shift();
  }
  return { sites, markedAtMs: previous?.markedAtMs ?? now };
}

export function createMemoryTeammateActivityStore(): PersonalBrowserTeammateActivityStore {
  const profiles = new Map<string, PersonalBrowserTeammateActivity>();
  return {
    read: (partition) => profiles.get(partition) ?? null,
    mark(partition, url) {
      profiles.set(partition, withSite(profiles.get(partition) ?? null, url, Date.now()));
    },
    clear(partition) {
      profiles.delete(partition);
    },
  };
}

type StoredFile = { version: number; profiles: Record<string, PersonalBrowserTeammateActivity> };

function validActivity(value: unknown): value is PersonalBrowserTeammateActivity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.sites) &&
    candidate.sites.every((site) => typeof site === "string" && site.length <= 253) &&
    typeof candidate.markedAtMs === "number";
}

/**
 * A store in Desktop's userData folder, keyed by the profile's partition.
 * A file that exists but cannot be read marks every profile, so a damaged file
 * brings the per-site prompts back instead of dropping them.
 */
export function createFileTeammateActivityStore(
  filePath: string,
  logger: (message: string) => void = () => undefined,
): PersonalBrowserTeammateActivityStore {
  let cache: Map<string, PersonalBrowserTeammateActivity> | null = null;
  let damaged = false;

  const load = (): Map<string, PersonalBrowserTeammateActivity> => {
    if (cache) return cache;
    cache = new Map();
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        damaged = true;
        logger("Personal Browser teammate activity could not be read; every profile asks per site.");
      }
      return cache;
    }
    try {
      const parsed = JSON.parse(raw) as StoredFile;
      if (parsed?.version !== FILE_VERSION || !parsed.profiles || typeof parsed.profiles !== "object") {
        throw new Error("unsupported file");
      }
      for (const [partition, activity] of Object.entries(parsed.profiles)) {
        if (!validActivity(activity)) throw new Error("invalid entry");
        cache.set(partition, { sites: activity.sites.slice(-MAX_TEAMMATE_SITES), markedAtMs: activity.markedAtMs });
      }
    } catch {
      cache.clear();
      damaged = true;
      logger("Personal Browser teammate activity is damaged; every profile asks per site.");
    }
    return cache;
  };

  const save = (profiles: Map<string, PersonalBrowserTeammateActivity>) => {
    const entries = [...profiles.entries()]
      .sort((left, right) => left[1].markedAtMs - right[1].markedAtMs)
      .slice(-MAX_PROFILES);
    const body: StoredFile = { version: FILE_VERSION, profiles: Object.fromEntries(entries) };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
    damaged = false;
  };

  return {
    read(partition) {
      const profiles = load();
      const activity = profiles.get(partition);
      if (activity) return activity;
      return damaged ? { sites: [], markedAtMs: 0 } : null;
    },
    mark(partition, url) {
      const profiles = load();
      const previous = profiles.get(partition) ?? null;
      const next = withSite(previous, url, Date.now());
      profiles.set(partition, next);
      try {
        save(profiles);
      } catch {
        logger("Personal Browser teammate activity could not be saved; it applies until Desktop restarts.");
      }
    },
    clear(partition) {
      const profiles = load();
      profiles.delete(partition);
      try {
        // Forgetting rewrites the file. A damaged file's unknown marks for
        // other profiles on this device are dropped with it.
        save(profiles);
      } catch {
        logger("Personal Browser teammate activity could not be saved.");
      }
    },
  };
}
