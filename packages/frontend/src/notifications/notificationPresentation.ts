import { getNotificationSession } from "./notificationSession";
import { buildNotificationClickUrl, UUID_PATTERN } from "./notificationContract";
export const NOTIFICATION_RECEIVED_EVENT = "instafy:notification-received";
export const NOTIFICATION_NAVIGATE_EVENT = "instafy:notification-navigate";

function openPresentationDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("instafy-notifications", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("presentation");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
/** An atomic, shared claim prevents simultaneous SW, tabs and toast presentation. */
export async function claimNotificationPresentation(accountId: string, eventId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(accountId) || !UUID_PATTERN.test(eventId)) return false;
  try {
    const db = await openPresentationDatabase();
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction("presentation", "readwrite");
      const store = tx.objectStore("presentation");
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const old = store.openCursor();
      old.onsuccess = () => {
        const cursor = old.result;
        if (!cursor) return;
        if (typeof cursor.value === "number" && cursor.value < cutoff) cursor.delete();
        cursor.continue();
      };
      const request = store.add(Date.now(), `${accountId}:${eventId}`);
      let claimed = false;
      request.onsuccess = () => { claimed = true; };
      tx.oncomplete = () => { db.close(); resolve(claimed); };
      tx.onabort = () => { db.close(); resolve(false); };
      tx.onerror = () => { /* onabort resolves duplicate constraints */ };
    });
  } catch {
    // If durable deduplication is unavailable, the center still contains the event.
    return false;
  }
}
export async function publishNotificationAccount(accountId: string | null): Promise<void> {
  try {
    const db = await openPresentationDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("presentation", "readwrite");
      tx.objectStore("presentation").put(accountId, "active-account");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  } catch { /* Push fails closed without account state. */ }
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.controller?.postMessage({ type: "instafy:notification-account", accountId });
  }
}
export function routeNotificationClick(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  const url = buildNotificationClickUrl(value);
  if (!url) return false;
  const session = getNotificationSession();
  if (session && value.accountId !== session.userId) return false;
  // RequireAuth preserves this IDs-only path when no session exists.
  window.dispatchEvent(new CustomEvent(NOTIFICATION_NAVIGATE_EVENT, { detail: { url } }));
  return true;
}
