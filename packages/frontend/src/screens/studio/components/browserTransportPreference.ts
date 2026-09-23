import type { BrowserTransport } from "./usePersonalBrowserBridge";

const BROWSER_TRANSPORT_STORAGE_PREFIX = "instafy:browser-transport";

export function resolveBrowserTransportSelection({ resume, preference, personalAvailable }: {
  resume: BrowserTransport | null;
  preference: BrowserTransport | null;
  personalAvailable: boolean;
}): BrowserTransport {
  if (resume) return resume;
  if (preference === "shared") return "shared";
  return personalAvailable ? "personal" : "shared";
}

export function browserTransportPreferenceKey(userId: string): string {
  return `${BROWSER_TRANSPORT_STORAGE_PREFIX}:${userId}`;
}

export function parseBrowserTransportPreference(value: string | null): BrowserTransport | null {
  return value === "personal" || value === "shared" ? value : null;
}

export function readBrowserTransportPreference(userId: string): BrowserTransport | null {
  return readTransport(browserTransportPreferenceKey(userId));
}

export function browserSessionTransportKey(userId: string, projectId: string, conversationId: string): string {
  return `instafy:browser-session-location:${userId}:${projectId}:${conversationId}`;
}

export function readBrowserSessionTransport(userId: string, projectId: string, conversationId: string): BrowserTransport | null {
  const key = browserSessionTransportKey(userId, projectId, conversationId);
  return readTransport(key, "sessionStorage") ?? readTransport(key);
}

export function writeBrowserSessionTransport(userId: string, projectId: string, conversationId: string, transport: BrowserTransport): void {
  const key = browserSessionTransportKey(userId, projectId, conversationId);
  writeTransport(key, transport, "sessionStorage");
  writeTransport(key, transport);
}

function readTransport(key: string, storage: "localStorage" | "sessionStorage" = "localStorage"): BrowserTransport | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return parseBrowserTransportPreference(
      window[storage].getItem(key),
    );
  } catch {
    return null;
  }
}

export function writeBrowserTransportPreference(
  userId: string,
  transport: BrowserTransport,
): void {
  writeTransport(browserTransportPreferenceKey(userId), transport);
}

function writeTransport(key: string, transport: BrowserTransport, storage: "localStorage" | "sessionStorage" = "localStorage"): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window[storage].setItem(key, transport);
  } catch {
    // Browser storage can be unavailable in hardened or private contexts.
  }
}
