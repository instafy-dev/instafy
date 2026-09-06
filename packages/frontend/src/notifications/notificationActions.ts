import { Capacitor } from "@capacitor/core";
import { NOTIFICATION_NAVIGATE_EVENT, NOTIFICATION_RECEIVED_EVENT, routeNotificationClick } from "./notificationPresentation";
import { getNotificationSession } from "./notificationSession";
import { parseNotificationClickUrl } from "./notificationContract";

type ListenerHandle = { remove: () => Promise<void> };
export function installNotificationActionListeners(): () => void {
  let disposed = false;
  const handles: ListenerHandle[] = [];
  const add = (handle: ListenerHandle) => { if (disposed) void handle.remove(); else handles.push(handle); };
  const onNavigate = (event: Event) => {
    const url = (event as CustomEvent<{url?: unknown}>).detail?.url;
    if (parseNotificationClickUrl(url) && typeof url === "string") window.location.assign(url);
  };
  window.addEventListener(NOTIFICATION_NAVIGATE_EVENT, onNavigate);
  const onMessage = (event: MessageEvent) => {
    const payload = event.data as { type?: unknown; accountId?: unknown } | null;
    if (payload?.type === NOTIFICATION_RECEIVED_EVENT && payload.accountId === getNotificationSession()?.userId) {
      window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT));
    }
  };
  navigator.serviceWorker?.addEventListener("message", onMessage);
  if (Capacitor.isNativePlatform()) {
    void (async () => {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      add(await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
        if (!disposed) routeNotificationClick(action.notification.data);
      }));
      add(await PushNotifications.addListener("pushNotificationReceived", (notification) => {
        if (!disposed && notification.data?.accountId === getNotificationSession()?.userId) {
          window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT));
        }
      }));
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      add(await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
        if (!disposed) routeNotificationClick(action.notification.extra);
      }));
    })().catch(() => { /* The center remains available without native plugins. */ });
  }
  return () => {
    disposed = true;
    window.removeEventListener(NOTIFICATION_NAVIGATE_EVENT, onNavigate);
    navigator.serviceWorker?.removeEventListener("message", onMessage);
    for (const handle of handles) void handle.remove();
  };
}

export { processNotificationClickDestination } from "./notificationClickDestination";
