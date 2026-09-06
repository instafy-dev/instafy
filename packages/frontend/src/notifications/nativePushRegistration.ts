import { Capacitor } from "@capacitor/core";
import { controllerClient } from "../sdk/instafy";
import { getNotificationSession, isNotificationSessionCurrent, notificationStorageKey, type NotificationSession } from "./notificationSession";

let initialized: Promise<void> | null = null;
let registrationSession: NotificationSession | null = null;
const NATIVE_TOKEN_STORAGE_KEY = "instafy.notifications.native_push_token";
// One native device token can move between accounts. Serialize all server writes,
// including cleanup of already-started old-account requests, so a delayed upsert
// can never overtake the new owner's registration.
let tokenMutation: Promise<void> = Promise.resolve();
function mutateNativeToken<T>(operation: () => Promise<T>): Promise<T> {
  const result = tokenMutation.then(operation, operation);
  tokenMutation = result.then(() => {}, () => {});
  return result;
}
export function resolveNativePushPlatform(): "ios" | "android" | null {
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android" ? platform : null;
}
async function ensureNativePushListeners(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await PushNotifications.addListener("registration", (token) => {
      const session = registrationSession;
      const value = token?.value?.trim() ?? "";
      if (!session || !isNotificationSessionCurrent(session) || !value || resolveNativePushPlatform() !== "ios") return;
      const key = notificationStorageKey(NATIVE_TOKEN_STORAGE_KEY, session.userId);
      try { window.localStorage.setItem(key, value); } catch { /* unavailable storage */ }
      void mutateNativeToken(async () => {
        if (!isNotificationSessionCurrent(session)) return;
        await controllerClient.notifications.upsertNativePushToken({
          token: value, platform: "ios", environment: import.meta.env.DEV ? "sandbox" : "production", accessToken: session.accessToken,
        });
        if (!isNotificationSessionCurrent(session)) {
          await controllerClient.notifications.removeNativePushToken({ token: value, platform: "ios", accessToken: session.accessToken });
        }
      }).catch(() => {});
    });
    await PushNotifications.addListener("registrationError", () => {
      console.warn("[push] native push registration failed");
    });
  })().catch((error) => { initialized = null; throw error; });
  return initialized;
}
async function registerNativePush(requestPermission: boolean): Promise<boolean> {
  // FCM is not implemented. Never register Android tokens as if delivery worked.
  if (!Capacitor.isNativePlatform() || resolveNativePushPlatform() !== "ios") return false;
  const session = getNotificationSession();
  if (!session) return false;
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await ensureNativePushListeners();
    let permission = await PushNotifications.checkPermissions();
    if (requestPermission && permission.receive !== "granted") permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted" || !isNotificationSessionCurrent(session)) return false;
    registrationSession = session;
    await PushNotifications.register();
    return isNotificationSessionCurrent(session);
  } catch { return false; }
}
export function ensureNativePushTokenRegistered(): Promise<boolean> { return registerNativePush(false); }
export function requestNativePushTokenRegistered(): Promise<boolean> { return registerNativePush(true); }
export async function unregisterNativePushToken(session = getNotificationSession()): Promise<boolean> {
  if (!session || registrationSession?.userId === session.userId) registrationSession = null;
  if (!Capacitor.isNativePlatform() || typeof window === "undefined") return true;
  const platform = resolveNativePushPlatform();
  if (!platform) return true;
  const key = notificationStorageKey(NATIVE_TOKEN_STORAGE_KEY, session?.userId);
  let token = "";
  try {
    token = window.localStorage.getItem(key) ?? window.localStorage.getItem(NATIVE_TOKEN_STORAGE_KEY) ?? "";
    window.localStorage.removeItem(NATIVE_TOKEN_STORAGE_KEY);
  } catch { /* unavailable storage */ }
  let unregistered = true;
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await PushNotifications.unregister();
  } catch { unregistered = false; }
  // Detach the OS token before a network operation that may wait while offline.
  let removed = true;
  if (token.trim() && session) {
    const result = await mutateNativeToken(() => controllerClient.notifications.removeNativePushToken({ token: token.trim(), platform, accessToken: session.accessToken }));
    removed = result.success;
    if (removed) { try { window.localStorage.removeItem(key); } catch { /* unavailable storage */ } }
  }
  return removed && unregistered;
}
