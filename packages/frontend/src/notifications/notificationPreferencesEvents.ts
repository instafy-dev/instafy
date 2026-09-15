/** Account-scoped invalidation; credential material never travels in this event. */
export const NOTIFICATION_PREFERENCES_CHANGED_EVENT = "instafy:notification-preferences-changed";

export interface NotificationPreferencesChangedDetail {
  userId: string;
}
