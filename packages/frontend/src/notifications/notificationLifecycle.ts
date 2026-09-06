import { areMessageNotificationsEnabled } from "./assistantMessageNotifications";
import { ensureNativePushTokenRegistered, unregisterNativePushToken } from "./nativePushRegistration";
import { ensureWebPushSubscriptionRegistered, unregisterWebPushSubscription } from "./webPushRegistration";
import { getNotificationSession, setNotificationSession, type NotificationSession } from "./notificationSession";
import { publishNotificationAccount } from "./notificationPresentation";
let transition: Promise<void> = Promise.resolve();
let generation = 0;

export function changeNotificationSession(next: NotificationSession | null): Promise<void> {
  const previous = getNotificationSession();
  const accountChanged = previous?.userId !== next?.userId;
  const revision = ++generation;
  setNotificationSession(next);
  const presentationGate = accountChanged ? publishNotificationAccount(null) : Promise.resolve();
  transition = transition.catch(() => {}).then(async () => {
    // Close the old account's presentation gate before network cleanup.
    await presentationGate;
    if (accountChanged && previous) {
      await Promise.allSettled([unregisterNativePushToken(previous), unregisterWebPushSubscription(previous)]);
    }
    if (revision !== generation) return;
    await publishNotificationAccount(next?.userId ?? null);
    if (next && areMessageNotificationsEnabled()) {
      // Registration callbacks carry their initiating account epoch. Do not let
      // a slow provider registration block a later sign-out cleanup.
      void Promise.allSettled([ensureNativePushTokenRegistered(), ensureWebPushSubscriptionRegistered()]);
    }
  });
  return transition;
}

/** Sign-out must remain responsive offline; cleanup continues with captured credentials. */
export async function releaseNotificationSession(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      changeNotificationSession(null),
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, 4_000); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
}
