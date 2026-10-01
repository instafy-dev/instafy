import { useCallback, useEffect, useRef, useState } from "react";

export interface BrowserAddressHistoryEntry {
  url: string;
  title: string;
  lastVisitedAt: number;
}

const STORAGE_PREFIX = "instafy:browser-address-history:v1:";
const CHANGE_EVENT = "instafy:browser-address-history-changed";
const MAX_ENTRIES = 100;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 300;

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.href.length <= MAX_URL_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

function readHistory(key: string | null): BrowserAddressHistoryEntry[] {
  if (!key || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw || raw.length > 1_000_000) return [];
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    const entries = new Map<string, BrowserAddressHistoryEntry>();
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      const url = normalizeUrl(value.url);
      if (!url || typeof value.title !== "string" || typeof value.lastVisitedAt !== "number"
        || !Number.isFinite(value.lastVisitedAt) || value.lastVisitedAt < 0) continue;
      if ((entries.get(url)?.lastVisitedAt ?? -1) >= value.lastVisitedAt) continue;
      entries.set(url, { url, title: value.title.trim().slice(0, MAX_TITLE_LENGTH), lastVisitedAt: value.lastVisitedAt });
    }
    return [...entries.values()].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeHistory(key: string, entries: BrowserAddressHistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    if (entries.length) window.localStorage.setItem(key, JSON.stringify(entries));
    else window.localStorage.removeItem(key);
    // Storage events cover other windows; this event updates sibling browser surfaces.
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }));
  } catch {
    // Storage is optional: denied access or quota exhaustion must not break browsing.
  }
}

/** Local address recall across browser locations. Never stores draft address input. */
export function useBrowserAddressHistory(
  userId: string | null | undefined,
  currentPage?: { url: string; title?: string | null } | null,
): { entries: BrowserAddressHistoryEntry[]; clear: () => void } {
  const key = userId?.trim() ? `${STORAGE_PREFIX}${encodeURIComponent(userId.trim())}` : null;
  const url = normalizeUrl(currentPage?.url);
  const title = currentPage?.title?.trim().slice(0, MAX_TITLE_LENGTH) ?? "";
  const [snapshot, setSnapshot] = useState(() => ({ key, entries: readHistory(key) }));
  const previousPage = useRef<{ key: string | null; url: string | null; blocked: boolean } | null>(null);

  useEffect(() => {
    const refresh = () => setSnapshot({ key, entries: readHistory(key) });
    const onLocalChange = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail === key) refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === key) refresh();
    };
    window.addEventListener(CHANGE_EVENT, onLocalChange);
    window.addEventListener("storage", onStorage);
    refresh();
    return () => {
      window.removeEventListener(CHANGE_EVENT, onLocalChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);

  useEffect(() => {
    const previous = previousPage.current;
    // A still-mounted browser can briefly retain the outgoing account's page.
    const blocked = Boolean(previous && previous.url === url && (previous.key !== key || previous.blocked));
    previousPage.current = { key, url, blocked };
    if (!key || !url || blocked) return;
    const entries = readHistory(key);
    const existing = entries.find((entry) => entry.url === url);
    const isNavigation = !previous || previous.key !== key || previous.url !== url;
    if (!isNavigation) {
      // Late page titles improve existing history, but must not undo Clear history.
      if (!existing || !title || existing.title === title) return;
      writeHistory(key, entries.map((entry) => entry.url === url ? { ...entry, title } : entry));
      return;
    }
    writeHistory(key, [
      { url, title: title || existing?.title || "", lastVisitedAt: Date.now() },
      ...entries.filter((entry) => entry.url !== url),
    ].slice(0, MAX_ENTRIES));
  }, [key, url, title]);

  const clear = useCallback(() => {
    if (key) writeHistory(key, []);
    setSnapshot({ key, entries: [] });
  }, [key]);

  // Do not render the previous account's history while the subscription changes.
  return { entries: snapshot.key === key ? snapshot.entries : [], clear };
}
