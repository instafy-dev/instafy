export const NOTIFICATION_CATEGORIES = ["support", "conversations", "runs", "automations"] as const;
export const NOTIFICATION_CHANNELS = ["web_push", "apns", "local"] as const;
export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];
export const NOTIFICATION_EVENT_LABELS = {
  "support.reply": "There is a new reply to your support report.",
  "support.resolved": "Your support report has been resolved.",
  "conversation.reply": "There is a new reply in your conversation.",
  "run.failed": "A run could not finish.",
  "automation.completed": "Your automation has finished.",
  "automation.failed": "Your automation could not finish.",
} as const;
export type NotificationEventName = keyof typeof NOTIFICATION_EVENT_LABELS;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isNotificationEventName(value: unknown): value is NotificationEventName {
  return typeof value === "string" && Object.hasOwn(NOTIFICATION_EVENT_LABELS, value);
}

/** Notification navigation accepts resource IDs only, never controller overrides or arbitrary URLs. */
export function canonicalNotificationUrl(value: unknown, origin = "https://instafy.invalid"): string | null {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== new URL(origin).origin || url.pathname !== "/studio" || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    const supportId = url.searchParams.get("supportReportId");
    if (keys.length === 1 && supportId && UUID_PATTERN.test(supportId)) {
      return `/studio?supportReportId=${supportId.toLowerCase()}`;
    }
    const projectId = url.searchParams.get("projectId");
    const conversationId = url.searchParams.get("conversationControllerId");
    if (keys.length === 1 && projectId && UUID_PATTERN.test(projectId)) return `/studio?projectId=${projectId.toLowerCase()}`;
    if (keys.length === 2 && projectId && conversationId && UUID_PATTERN.test(projectId) && UUID_PATTERN.test(conversationId)) {
      return `/studio?projectId=${projectId.toLowerCase()}&conversationControllerId=${conversationId.toLowerCase()}`;
    }
    if (keys.length === 2 && projectId && UUID_PATTERN.test(projectId) && url.searchParams.get("panel") === "automations") {
      return `/studio?projectId=${projectId.toLowerCase()}&panel=automations`;
    }
    return keys.length === 0 ? "/studio" : null;
  } catch { return null; }
}

export interface ProductNotification {
  id: string;
  eventName: NotificationEventName;
  version: number;
  category: NotificationCategory;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
  title: string;
  body: string;
  url: string;
  seenAt: string | null;
  readAt: string | null;
  archivedAt: string | null;
}
export interface NotificationPage {
  items: ProductNotification[];
  nextCursor: string | null;
  unreadCount: number;
  asOf: string;
}
export interface NotificationPreference {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
}
export interface NotificationPreferences {
  hidePreviews: boolean;
  preferences: NotificationPreference[];
}

/** Lock-screen previews contain only registry text, never producer-supplied content. */
export function safeNotificationBody(value: unknown): string {
  return typeof value === "string" && Object.values(NOTIFICATION_EVENT_LABELS).some((body) => body === value)
    ? value
    : "You have a new notification.";
}

export interface NotificationClickDestination {
  resourceUrl: string;
  eventId: string;
  accountId: string;
}

/** Event/account IDs survive an external click and login; no content travels in the URL. */
export function buildNotificationClickUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const resourceUrl = canonicalNotificationUrl(value.url);
  if (!resourceUrl || typeof value.eventId !== "string" || typeof value.accountId !== "string" ||
    !UUID_PATTERN.test(value.eventId) || !UUID_PATTERN.test(value.accountId)) return null;
  const url = new URL(resourceUrl, "https://instafy.invalid");
  url.searchParams.set("notificationEventId", value.eventId.toLowerCase());
  url.searchParams.set("notificationAccountId", value.accountId.toLowerCase());
  return `${url.pathname}${url.search}`;
}

export function parseNotificationClickUrl(value: unknown): NotificationClickDestination | null {
  if (typeof value !== "string" || value.length > 768 || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const url = new URL(value, "https://instafy.invalid");
    if (url.origin !== "https://instafy.invalid" || url.hash) return null;
    const events = url.searchParams.getAll("notificationEventId");
    const accounts = url.searchParams.getAll("notificationAccountId");
    if (events.length !== 1 || accounts.length !== 1 || !UUID_PATTERN.test(events[0]) || !UUID_PATTERN.test(accounts[0])) return null;
    url.searchParams.delete("notificationEventId");
    url.searchParams.delete("notificationAccountId");
    const resourceUrl = canonicalNotificationUrl(`${url.pathname}${url.search}`);
    return resourceUrl ? { resourceUrl, eventId: events[0].toLowerCase(), accountId: accounts[0].toLowerCase() } : null;
  } catch { return null; }
}
