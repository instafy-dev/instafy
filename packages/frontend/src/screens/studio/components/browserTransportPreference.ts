import type { BrowserTransport } from "./usePersonalBrowserBridge";

const BROWSER_TRANSPORT_STORAGE_PREFIX = "instafy:browser-transport";

export function browserTransportPreferenceKey(userId: string): string {
  return `${BROWSER_TRANSPORT_STORAGE_PREFIX}:${userId}`;
}

export function parseBrowserTransportPreference(value: string | null): BrowserTransport | null {
  return value === "personal" || value === "shared" ? value : null;
}

export function readBrowserTransportPreference(userId: string): BrowserTransport | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return parseBrowserTransportPreference(
      window.localStorage.getItem(browserTransportPreferenceKey(userId)),
    );
  } catch {
    return null;
  }
}

export function writeBrowserTransportPreference(
  userId: string,
  transport: BrowserTransport,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(browserTransportPreferenceKey(userId), transport);
  } catch {
    // Browser storage can be unavailable in hardened or private contexts.
  }
}
