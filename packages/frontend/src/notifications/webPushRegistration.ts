import { getNotificationSession, isNotificationSessionCurrent } from "./notificationSession";
import {
  type WebPushSubscriptionPayload,
  controllerClient,
} from "../sdk/instafy";

const DEBUG_KEY = "instafy.notifications.debug";

function notificationsDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

function logNotificationDebug(message: string, details?: Record<string, unknown>) {
  if (!notificationsDebugEnabled()) {
    return;
  }
  if (details) {
    console.info(`[notifications] ${message}`, details);
    return;
  }
  console.info(`[notifications] ${message}`);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padded = base64String.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64String.length / 4) * 4, "=");
  const raw = atob(padded);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

function canUseWebPush(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return "serviceWorker" in navigator && "PushManager" in window;
}

function hasGrantedNotificationPermission(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (!("Notification" in window)) {
    return false;
  }
  return Notification.permission === "granted";
}

async function getExistingServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!canUseWebPush()) {
    return null;
  }
  try {
    return (await navigator.serviceWorker.getRegistration("/")) ?? null;
  } catch (_error) {
    return null;
  }
}

async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!canUseWebPush()) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return await navigator.serviceWorker.ready.catch(() => registration);
  } catch (_error) {
    return null;
  }
}

async function loadExistingSubscription(): Promise<PushSubscription | null> {
  const registration = await getExistingServiceWorkerRegistration();
  if (!registration) {
    return null;
  }
  try {
    return await registration.pushManager.getSubscription();
  } catch (_error) {
    return null;
  }
}

export async function hasActiveWebPushSubscription(): Promise<boolean> {
  const subscription = await loadExistingSubscription();
  const active = Boolean(subscription);
  logNotificationDebug("web push subscription check", { active });
  return active;
}

export async function unregisterWebPushSubscription(session = getNotificationSession()): Promise<boolean> {
  if (!canUseWebPush()) {
    return true;
  }
  const subscription = await loadExistingSubscription();
  if (!subscription) {
    return true;
  }

  const endpoint = typeof subscription.endpoint === "string" ? subscription.endpoint.trim() : "";
  try {
    await subscription.unsubscribe();
  } catch {
    // ignore unsubscribe failures
  }
  if (!endpoint) {
    return false;
  }

  if (!session) return false;
  const removed = await controllerClient.notifications.removeWebPushSubscription({
    endpoint, accessToken: session.accessToken,
  });
  return removed.success;
}

function extractSubscriptionPayload(subscription: PushSubscription): WebPushSubscriptionPayload | null {
  try {
    const json = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    const endpoint = typeof json.endpoint === "string" ? json.endpoint.trim() : "";
    const p256dh = typeof json.keys?.p256dh === "string" ? json.keys.p256dh.trim() : "";
    const auth = typeof json.keys?.auth === "string" ? json.keys.auth.trim() : "";
    if (!endpoint || !p256dh || !auth) {
      return null;
    }
    return { endpoint, keys: { p256dh, auth } };
  } catch (_error) {
    return null;
  }
}

export async function ensureWebPushSubscriptionRegistered(): Promise<boolean> {
  const session = getNotificationSession();
  if (!session) return false;
  if (!canUseWebPush()) {
    logNotificationDebug("web push registration skipped: API unavailable");
    return false;
  }
  // Never trigger browser permission prompts here; explicit opt-in happens via UI actions.
  if (!hasGrantedNotificationPermission()) {
    return false;
  }

  const vapid = await controllerClient.notifications.getWebPushVapidPublicKey();
  const publicKey = vapid.success ? vapid.publicKey?.trim() ?? "" : "";
  if (!publicKey) {
    logNotificationDebug("web push registration failed: missing VAPID public key", {
      error: vapid.error ?? null,
    });
    return false;
  }

  const registration = await ensureServiceWorkerRegistration();
  if (!registration) {
    logNotificationDebug("web push registration failed: service worker unavailable");
    return false;
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    try {
      const applicationServerKey = urlBase64ToUint8Array(publicKey);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
      });
    } catch (_error) {
      logNotificationDebug("web push registration failed: subscribe() threw");
      return false;
    }
  }

  const payload = extractSubscriptionPayload(subscription);
  if (!payload) {
    logNotificationDebug("web push registration failed: invalid subscription payload");
    return false;
  }

  if (!isNotificationSessionCurrent(session)) return false;
  const stored = await controllerClient.notifications.upsertWebPushSubscription({
    accessToken: session.accessToken,
    subscription: payload,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
  });
  if (getNotificationSession()?.userId !== session.userId) {
    await controllerClient.notifications.removeWebPushSubscription({ endpoint: payload.endpoint, accessToken: session.accessToken });
    return false;
  }
  logNotificationDebug("web push registration upsert result", {
    success: stored.success,
    error: stored.error ?? null,
  });
  return stored.success;
}
