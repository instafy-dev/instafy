/**
 * The notification center's timer found the unread feed changed (a new,
 * seen, read or archived notification). Owners of account-wide state that
 * moves with notifications, such as the Home inbox and support reports,
 * refresh on it instead of polling on their own fast timers.
 */
export const NOTIFICATION_FEED_CHANGED_EVENT = "instafy:notification-feed-changed";
