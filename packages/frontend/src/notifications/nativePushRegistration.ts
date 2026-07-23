import { Capacitor } from "@capacitor/core";
import { controllerClient } from "../sdk/instafy";

let initialized = false;
const NATIVE_TOKEN_STORAGE_KEY = "instafy.notifications.native_push_token";

function resolveNativePlatform(): "ios" | "android" {
  try {
    const platform = Capacitor.getPlatform();
    return platform === "android" ? "android" : "ios";
  } catch {
    return "ios";
  }
}

async function ensureNativePushListeners(): Promise<void> {
  const { PushNotifications } = await import("@capacitor/push-notifications");
  if (initialized) {
    return;
  }
  initialized = true;

  PushNotifications.addListener("registration", (token) => {
    const value = token?.value?.trim?.() ?? "";
    if (!value) {
      return;
    }
    try {
      window.localStorage.setItem(NATIVE_TOKEN_STORAGE_KEY, value);
    } catch {
      // ignore storage errors
    }
    void controllerClient.notifications.upsertNativePushToken({
      token: value,
      platform: resolveNativePlatform(),
      environment: import.meta.env.DEV ? "sandbox" : "production",
    });
  });

  PushNotifications.addListener("registrationError", (error) => {
    console.warn("[push] registration error:", error);
  });
}

export async function ensureNativePushTokenRegistered(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return false;
  }

  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await ensureNativePushListeners();

    const current = await PushNotifications.checkPermissions();
    if (current.receive !== "granted") {
      return false;
    }

    await PushNotifications.register();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[push] unable to register native push token:", message);
    return false;
  }
}

export async function requestNativePushTokenRegistered(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return false;
  }

  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await ensureNativePushListeners();

    const current = await PushNotifications.checkPermissions();
    if (current.receive !== "granted") {
      const requested = await PushNotifications.requestPermissions();
      if (requested.receive !== "granted") {
        return false;
      }
    }

    await PushNotifications.register();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[push] unable to request native push permission:", message);
    return false;
  }
}

export async function unregisterNativePushToken(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return true;
  }
  if (typeof window === "undefined") {
    return true;
  }

  let token = "";
  try {
    token = window.localStorage.getItem(NATIVE_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    token = "";
  }
  token = token.trim();
  if (!token) {
    return true;
  }

  const removed = await controllerClient.notifications.removeNativePushToken({
    token,
    platform: "ios",
  });
  try {
    window.localStorage.removeItem(NATIVE_TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }

  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await PushNotifications.unregister();
  } catch {
    // ignore unregister errors
  }

  return removed.success;
}
