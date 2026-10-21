import { useSyncExternalStore } from "react";

/**
 * Which sites shown in Studio have received the person's location.
 *
 * - On this device (localStorage): every site that received it (title, space,
 *   last time) and whether the person stopped it. A stop sticks until they turn
 *   it back on in Studio; nothing a site does can undo it.
 * - This session (memory): which sites received it since Studio loaded (the 📍
 *   marker) and which are following the person right now (the marker pulses).
 *
 * A site is keyed by the space, the preview's title, its port and its path.
 * The agent can change the title or the port when it edits or restarts a site,
 * so a key that changes is matched back to what Studio already knows
 * (adoptLocationSite): the same preview keeps its record and status under the
 * new key, and a stop also covers a preview in the same space with the same
 * title. Nothing here knows what the site is.
 *
 * The list belongs to the signed-in account (setLocationSitesAccount): another
 * account on this device never sees it, and signing out empties it.
 */

export type LocationSiteIdentity = {
  projectId: string;
  title: string;
  port: number;
  path: string;
};

export type LocationSiteRecord = {
  key: string;
  projectId: string;
  title: string;
  /** The space's name when the site last received location, if Studio knew it. */
  space: string | null;
  /** Epoch ms of the last position sent; null when stopped before it ever received one. */
  lastAt: number | null;
  stopped: boolean;
  /** The preview this was last seen as; it stays the same when the agent renames the site. */
  previewId?: string | null;
};

export type LocationSiteMeta = { key: string; projectId: string; title: string; space: string | null; previewId?: string | null };

/** Prefix of the per-account storage key; see locationSitesStorageKey. */
export const LOCATION_SITES_STORAGE_KEY = "instafy.previewLocationSites.v1";

export function locationSitesStorageKey(account: string): string {
  return `${LOCATION_SITES_STORAGE_KEY}:${account}`;
}
/** Sites that were not stopped kept on the list; a stopped site is never dropped, so its stop holds. */
export const LOCATION_SITES_LIMIT = 50;

export function locationSiteKey(site: LocationSiteIdentity): string {
  return JSON.stringify([site.projectId, site.title.trim(), site.port, site.path || "/"]);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readRecord(value: unknown): LocationSiteRecord | null {
  if (!isRecord(value)) return null;
  const { key, projectId, title, space, lastAt, stopped, previewId } = value;
  if (typeof key !== "string" || !key || typeof projectId !== "string" || typeof title !== "string") return null;
  const record: LocationSiteRecord = {
    key, projectId, title,
    space: typeof space === "string" ? space : null,
    lastAt: typeof lastAt === "number" && Number.isFinite(lastAt) ? lastAt : null,
    stopped: stopped === true,
  };
  if (typeof previewId === "string" && previewId) record.previewId = previewId;
  return record;
}

// --- device ----------------------------------------------------------------

let records: readonly LocationSiteRecord[] | null = null;
/** Used only when the browser refuses storage (a private window): the list lives as long as the page. */
let memoryOnly = false;
/** The signed-in account; null keeps the list in memory only. */
let account: string | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  if (memoryOnly || !account) return null;
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

/**
 * Whose list this is. Studio calls it whenever the signed-in account changes
 * (null when signed out): the list, the session's 📍 state and the stops
 * switch with it, so nobody sees which sites got another person's location.
 */
export function setLocationSitesAccount(next: string | null): void {
  const normalized = next?.trim() || null;
  if (normalized === account) return;
  account = normalized;
  records = null;
  memoryOnly = false;
  receivedThisSession.clear();
  previewKeys.clear();
  statusCache.clear();
  notify();
}

function load(): readonly LocationSiteRecord[] {
  if (records) return records;
  let parsed: unknown = null;
  try { parsed = account ? JSON.parse(storage()?.getItem(locationSitesStorageKey(account)) ?? "null") : null; } catch { parsed = null; }
  records = Array.isArray(parsed) ? parsed.map(readRecord).filter((record): record is LocationSiteRecord => Boolean(record)) : [];
  return records;
}

function save(next: readonly LocationSiteRecord[]) {
  // Most recent first; once more than the limit were never stopped, the oldest of those go.
  // A stopped site always stays: dropping it would give it the location again.
  const sorted = [...next].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  let allowed = sorted.filter(record => !record.stopped).length;
  for (let index = sorted.length - 1; index >= 0 && allowed > LOCATION_SITES_LIMIT; index -= 1) {
    if (sorted[index].stopped) continue;
    sorted.splice(index, 1);
    allowed -= 1;
  }
  records = sorted;
  try { if (account) storage()?.setItem(locationSitesStorageKey(account), JSON.stringify(sorted)); } catch { memoryOnly = true; }
  notify();
}

function notify() {
  for (const listener of [...listeners]) listener();
}

export function listLocationSites(): readonly LocationSiteRecord[] {
  return load();
}

export function getLocationSite(key: string): LocationSiteRecord | null {
  return load().find(record => record.key === key) ?? null;
}

export function isLocationStopped(key: string): boolean {
  return getLocationSite(key)?.stopped === true;
}

/**
 * A position went to this site. Returns whether it is the first time this
 * device sent one to it (Studio shows the one-time toast then).
 */
export function recordLocationDelivery(site: LocationSiteMeta, now = Date.now()): { first: boolean } {
  const existing = getLocationSite(site.key);
  receivedThisSession.add(site.key);
  if (site.previewId) previewKeys.set(site.previewId, site.key);
  const record: LocationSiteRecord = {
    key: site.key, projectId: site.projectId, title: site.title,
    space: site.space ?? existing?.space ?? null, lastAt: now, stopped: existing?.stopped ?? false,
  };
  const previewId = site.previewId ?? existing?.previewId ?? null;
  if (previewId) record.previewId = previewId;
  save([record, ...load().filter(entry => entry.key !== site.key)]);
  return { first: !existing };
}

/**
 * Matches a site whose key changed back to what this device knows, before
 * Studio answers it or shows its status:
 * - the same preview (previewId) under a new title or path keeps its record,
 *   its stop and this session's 📍, now under the new key and title;
 * - a stop for another preview in the same space with the same title (the
 *   site came back on another port) covers this one too.
 * Returns the site's record afterwards, or null when the device knows nothing.
 */
export function adoptLocationSite(site: LocationSiteMeta): LocationSiteRecord | null {
  if (site.previewId) previewKeys.set(site.previewId, site.key);
  const exact = getLocationSite(site.key);
  if (exact) {
    if (site.previewId && exact.previewId !== site.previewId) {
      const updated = { ...exact, previewId: site.previewId };
      save([updated, ...load().filter(entry => entry.key !== site.key)]);
      return updated;
    }
    return exact;
  }
  const all = load();
  const same = site.previewId ? all.find(entry => entry.projectId === site.projectId && entry.previewId === site.previewId) : undefined;
  if (same) {
    const moved: LocationSiteRecord = { ...same, key: site.key, title: site.title, space: site.space ?? same.space };
    if (receivedThisSession.delete(same.key)) receivedThisSession.add(site.key);
    for (const [brokerId, key] of watching) if (key === same.key) watching.set(brokerId, site.key);
    save([moved, ...all.filter(entry => entry.key !== same.key)]);
    return moved;
  }
  const title = site.title.trim();
  const stoppedTwin = all.find(entry => entry.stopped && entry.projectId === site.projectId && entry.title.trim() === title);
  if (stoppedTwin) {
    const copy: LocationSiteRecord = { key: site.key, projectId: site.projectId, title: site.title, space: site.space ?? stoppedTwin.space, lastAt: null, stopped: true };
    if (site.previewId) copy.previewId = site.previewId;
    save([copy, ...all]);
    return copy;
  }
  return null;
}

/** "Stop sharing location" (true) or "Share location again" (false). Only Studio's own controls call this. */
export function setLocationStopped(site: LocationSiteMeta | string, stopped: boolean): void {
  const key = typeof site === "string" ? site : site.key;
  const existing = getLocationSite(key);
  let record: LocationSiteRecord;
  if (existing) {
    if (existing.stopped === stopped) return;
    record = { ...existing, stopped };
  } else {
    // Stopping a site before it ever received a position still sticks; "allow" for an unknown site is a no-op.
    if (typeof site === "string" || !stopped) return;
    record = { key, projectId: site.projectId, title: site.title, space: site.space, lastAt: null, stopped };
    if (site.previewId) record.previewId = site.previewId;
  }
  save([record, ...load().filter(entry => entry.key !== key)]);
}

// --- session -----------------------------------------------------------------

const receivedThisSession = new Set<string>();
/** Broker id → the site it is following the person for. */
const watching = new Map<string, string>();
/** Preview id → the site key it was last seen with, so a tab can show its 📍. */
const previewKeys = new Map<string, string>();

export function setLocationWatching(brokerId: string, key: string | null): void {
  const before = watching.get(brokerId) ?? null;
  if (before === key) return;
  if (key) watching.set(brokerId, key); else watching.delete(brokerId);
  notify();
}

export type LocationSiteStatus = {
  /** Received the person's location since Studio loaded: the 📍 marker shows. */
  received: boolean;
  /** Following the person right now (a watch is running): the marker pulses. */
  watching: boolean;
  /** Stopped in Studio; its requests get `stopped`. */
  stopped: boolean;
  /** On this device's list (received before, or stopped). */
  known: boolean;
};

const NO_STATUS: LocationSiteStatus = { received: false, watching: false, stopped: false, known: false };
const statusCache = new Map<string, LocationSiteStatus>();

export function locationSiteStatus(key: string | null): LocationSiteStatus {
  if (!key) return NO_STATUS;
  const record = getLocationSite(key);
  const next: LocationSiteStatus = {
    received: receivedThisSession.has(key),
    watching: [...watching.values()].includes(key),
    stopped: record?.stopped === true,
    known: Boolean(record),
  };
  const cached = statusCache.get(key);
  if (cached && cached.received === next.received && cached.watching === next.watching
    && cached.stopped === next.stopped && cached.known === next.known) return cached;
  statusCache.set(key, next);
  return next;
}

/** The status of the site a preview was last seen as (for its tab), or nothing. */
export function locationPreviewStatus(previewId: string): LocationSiteStatus {
  return locationSiteStatus(previewKeys.get(previewId) ?? null);
}

export function subscribeLocationSites(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Another Studio tab on this device stopped or allowed a site.
if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (!account || event.key !== locationSitesStorageKey(account)) return;
    records = null;
    notify();
  });
}

export function useLocationSiteStatus(key: string | null): LocationSiteStatus {
  return useSyncExternalStore(subscribeLocationSites, () => locationSiteStatus(key), () => NO_STATUS);
}

export function useLocationSites(): readonly LocationSiteRecord[] {
  return useSyncExternalStore(subscribeLocationSites, listLocationSites, () => EMPTY);
}
const EMPTY: readonly LocationSiteRecord[] = [];

let version = 0;
subscribeLocationSites(() => { version += 1; });
/** Re-renders on any change; for callers that read several sites' status at once (the tabs). */
export function useLocationSitesVersion(): number {
  return useSyncExternalStore(subscribeLocationSites, () => version, () => 0);
}

/** Tests only: forget everything in memory (storage is left to the test). */
export function resetLocationSitesForTests(): void {
  records = null;
  memoryOnly = false;
  receivedThisSession.clear();
  watching.clear();
  previewKeys.clear();
  statusCache.clear();
  notify();
}
