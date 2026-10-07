import { Capacitor } from "@capacitor/core";
import { areMessageNotificationsEnabled } from "./assistantMessageNotifications";
import type { NotificationChannel } from "./notificationContract";

export type NotificationDeviceKind = "browser" | "desktop" | "ios" | "android";
export type NotificationDevicePermission = "granted" | "prompt" | "denied" | "unsupported" | "unknown" | "system";
export interface NotificationDeviceState {
  permission: NotificationDevicePermission;
  enabledForAccount: boolean;
}

export function getNotificationDeviceContext(): { kind: NotificationDeviceKind; channel: NotificationChannel } {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform() === "ios"
      ? { kind: "ios", channel: "apns" }
      : { kind: "android", channel: "local" };
  }
  const bridge = typeof window !== "undefined" ? window.instafyDesktop : undefined;
  if (typeof bridge?.notify === "function") return { kind: "desktop", channel: "local" };
  return { kind: "browser", channel: "web_push" };
}

/** Read permission only. Never request permission or register a device on mount. */
export async function readNotificationDeviceState(kind: NotificationDeviceKind, userId?: string): Promise<NotificationDeviceState> {
  const enabledForAccount = areMessageNotificationsEnabled(userId);
  // Android push registration is deliberately unsupported until FCM delivery exists.
  if (kind === "android") return { permission: "unsupported", enabledForAccount };
  // The current Desktop bridge cannot inspect OS notification permission.
  if (kind === "desktop") return { permission: "system", enabledForAccount };
  if (kind === "ios") {
    try {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      const { receive } = await PushNotifications.checkPermissions();
      return {
        permission: receive === "granted" || receive === "denied" ? receive : "prompt",
        enabledForAccount,
      };
    } catch { return { permission: "unknown", enabledForAccount }; }
  }
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { permission: "unsupported", enabledForAccount };
  }
  return {
    permission: Notification.permission === "default" ? "prompt" : Notification.permission,
    enabledForAccount,
  };
}
