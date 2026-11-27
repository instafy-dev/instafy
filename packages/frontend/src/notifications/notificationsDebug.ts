const DEBUG_KEY = "instafy.notifications.debug";

/** Whether this browser asked for notification debug lines (`localStorage["instafy.notifications.debug"] = "1"`). */
export function notificationsDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

export function logNotificationDebug(message: string, details?: Record<string, unknown>) {
  if (!notificationsDebugEnabled()) {
    return;
  }
  if (details) {
    console.info(`[notifications] ${message}`, details);
    return;
  }
  console.info(`[notifications] ${message}`);
}
