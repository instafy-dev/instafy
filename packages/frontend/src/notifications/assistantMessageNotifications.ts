import { routeNotificationClick } from "./notificationPresentation";
import { notificationStorageKey, getNotificationSession, isNotificationSessionCurrent } from "./notificationSession";
import { canonicalNotificationUrl, safeNotificationBody } from "./notificationContract";
import { Capacitor } from "@capacitor/core";
import { ensureWebPushSubscriptionRegistered, hasActiveWebPushSubscription, unregisterWebPushSubscription } from "./webPushRegistration";
import { requestNativePushTokenRegistered, unregisterNativePushToken } from "./nativePushRegistration";

type DesktopNotificationPayload = {
  title: string;
  body?: string;
  url?: string;
  eventId?: string;
  accountId?: string;
};

const ENABLED_KEY = "instafy.notifications.enabled";
const NUDGE_SEEN_KEY = "instafy.notifications.browser_nudge_seen";
const DEBUG_KEY = "instafy.notifications.debug";
const FORCE_LOCAL_KEY = "instafy.notifications.force_local";

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

function notificationsForceLocalEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(FORCE_LOCAL_KEY) === "1";
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

function getDesktopBridge(): { notify: (payload: DesktopNotificationPayload) => Promise<unknown> } | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (window as typeof window & { instafyDesktop?: unknown }).instafyDesktop;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const notify = (candidate as { notify?: unknown }).notify;
  if (typeof notify !== "function") {
    return null;
  }
  return { notify: notify as (payload: DesktopNotificationPayload) => Promise<void> };
}

function canUseLocalStorage(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const key = "__instafy_storage_probe__";
    window.localStorage.setItem(key, "1");
    window.localStorage.removeItem(key);
    return true;
  } catch (_error) {
    return false;
  }
}

function readStoredEnabled(): boolean | null {
  if (!canUseLocalStorage()) {
    return null;
  }
  const raw = window.localStorage.getItem(notificationStorageKey(ENABLED_KEY));
  if (raw === "1") {
    return true;
  }
  if (raw === "0") {
    return false;
  }
  return null;
}

export function areMessageNotificationsEnabled(): boolean {
  const stored = readStoredEnabled();
  if (stored !== null) {
    return stored;
  }
  return Boolean(getDesktopBridge());
}

export function setMessageNotificationsEnabled(enabled: boolean) {
  if (!canUseLocalStorage()) {
    return;
  }
  window.localStorage.setItem(notificationStorageKey(ENABLED_KEY), enabled ? "1" : "0");
}

export function isAppInForeground(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  const visible = document.visibilityState === "visible";
  if (Capacitor.isNativePlatform()) {
    return visible;
  }
  const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return visible && focused;
}

export function shouldOfferBrowserNotificationsNudge(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (navigator.webdriver) {
    return false;
  }
  if (getDesktopBridge() || Capacitor.isNativePlatform()) {
    return false;
  }
  if (!("Notification" in window)) {
    return false;
  }
  if (Notification.permission !== "default") {
    return false;
  }
  if (!canUseLocalStorage()) {
    return false;
  }
  return window.localStorage.getItem(notificationStorageKey(NUDGE_SEEN_KEY)) !== "1";
}

export function markBrowserNotificationsNudgeSeen() {
  if (!canUseLocalStorage()) {
    return;
  }
  window.localStorage.setItem(notificationStorageKey(NUDGE_SEEN_KEY), "1");
}

export async function enableBrowserMessageNotifications(): Promise<boolean> {
  const session = getNotificationSession();
  if (!session) return false;
  if (typeof window === "undefined") {
    logNotificationDebug("enable browser notifications skipped: no window");
    return false;
  }
  if (!("Notification" in window)) {
    logNotificationDebug("enable browser notifications skipped: Notification API unavailable");
    return false;
  }
  const permission = await Notification.requestPermission();
  if (!isNotificationSessionCurrent(session)) return false;
  const enabled = permission === "granted";
  logNotificationDebug("browser notification permission result", { permission, enabled });
  setMessageNotificationsEnabled(enabled);
  if (enabled) {
    const ok = await ensureWebPushSubscriptionRegistered();
    logNotificationDebug("web push registration after permission", { success: ok });
  }
  return enabled;
}

export async function enableMessageNotifications(): Promise<boolean> {
  const session = getNotificationSession();
  if (!session) return false;
  const desktop = getDesktopBridge();
  if (desktop) {
    setMessageNotificationsEnabled(true);
    return true;
  }
  if (Capacitor.isNativePlatform()) {
    const ok = await requestNativePushTokenRegistered();
    if (!isNotificationSessionCurrent(session)) return false;
    setMessageNotificationsEnabled(ok);
    return ok;
  }
  return await enableBrowserMessageNotifications();
}

export async function disableBrowserMessageNotifications(): Promise<boolean> {
  setMessageNotificationsEnabled(false);
  if (typeof window === "undefined") {
    return true;
  }
  if (Capacitor.isNativePlatform()) {
    return await unregisterNativePushToken();
  }
  return await unregisterWebPushSubscription();
}

export async function disableMessageNotifications(): Promise<boolean> {
  setMessageNotificationsEnabled(false);
  const [nativeOk, webOk] = await Promise.all([
    unregisterNativePushToken(),
    unregisterWebPushSubscription(),
  ]);
  return nativeOk && webOk;
}

export async function notifyAssistantMessage(payload: DesktopNotificationPayload): Promise<boolean> {
  if (typeof window === "undefined") {
    logNotificationDebug("notify skipped: no window");
    return false;
  }
  if (!areMessageNotificationsEnabled()) {
    logNotificationDebug("notify skipped: notifications disabled");
    return false;
  }

  const session = getNotificationSession();
  if (!session || payload.accountId !== session.userId || !payload.eventId) return false;
  const url = canonicalNotificationUrl(payload.url);
  if (!url) return false;
  payload = { ...payload, title: "Instafy", body: safeNotificationBody(payload.body), url };
  const desktop = getDesktopBridge();
  if (desktop) {
    logNotificationDebug("notify via desktop bridge", {
      hasBody: Boolean(payload.body),
      hasUrl: Boolean(payload.url),
    });
    return await desktop.notify(payload) === true;
  }

  if (Capacitor.isNativePlatform()) {
    // APNs owns native background presentation; local scheduling would duplicate it.
    return false;
  }

  if ("Notification" in window && Notification.permission === "granted") {
    const hasWebPushSubscription = await hasActiveWebPushSubscription();
    if (!isNotificationSessionCurrent(session)) return false;
    const forceLocal = notificationsForceLocalEnabled();
    if (hasWebPushSubscription && !forceLocal) {
      logNotificationDebug("browser notify skipped: active web push subscription is present");
      return false;
    }
    if (hasWebPushSubscription && forceLocal) {
      logNotificationDebug("browser notify proceeding with force-local override");
    }
    try {
      const notification = new Notification(payload.title, {
        body: payload.body ?? "",
        data: { url, eventId: payload.eventId, accountId: payload.accountId },
        tag: payload.eventId,
      });
      logNotificationDebug("browser notification displayed", {
        title: payload.title,
        hasBody: Boolean(payload.body),
        hasUrl: Boolean(payload.url),
      });
      if (payload.url) {
        notification.onclick = () => {
          try {
            window.focus();
          } catch {
            // ignore focus errors
          }
          try {
            routeNotificationClick(payload);
          } catch {
            // ignore navigation errors
          }
        };
      }
      return true;
    } catch (_error) {
      logNotificationDebug("browser notification failed to display");
    }
    return false;
  }
  logNotificationDebug("browser notify skipped: permission not granted", {
    hasNotificationApi: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : "unsupported",
  });
  return false;
}
