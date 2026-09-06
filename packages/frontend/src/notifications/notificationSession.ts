export interface NotificationSession { userId: string; accessToken: string }
let currentSession: NotificationSession | null = null;
let epoch = 0;
const sessionEpochs = new WeakMap<NotificationSession, number>();
export function getNotificationSession(): NotificationSession | null { return currentSession; }
export function isNotificationSessionCurrent(session: NotificationSession): boolean {
  return currentSession !== null && sessionEpochs.get(currentSession) === sessionEpochs.get(session);
}
export function setNotificationSession(session: NotificationSession | null): void {
  currentSession = session ? { ...session } : null;
  epoch += 1;
  if (currentSession) sessionEpochs.set(currentSession, epoch);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("instafy:notification-session"));
}
export function notificationStorageKey(key: string, userId = currentSession?.userId): string {
  // Signed-out callers cannot inherit any account's device preference.
  return `${key}:${userId ?? "signed-out"}`;
}
