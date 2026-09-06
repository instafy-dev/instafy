import { controllerJsonRequest } from "./client";
import { canonicalNotificationUrl, isNotificationEventName, NOTIFICATION_CATEGORIES, NOTIFICATION_EVENT_LABELS, UUID_PATTERN, type NotificationPage, type NotificationPreferences, type ProductNotification } from "../../notifications/notificationContract";

export async function listProductNotifications(params: { view?: "all" | "unread"; before?: string | null; limit?: number; accessToken?: string } = {}): Promise<NotificationPage> {
  const result = await controllerJsonRequest<NotificationPage>({
    path: "/me/notifications", searchParams: { view: params.view ?? "all", before: params.before, limit: params.limit ?? 25 },
    accessToken: params.accessToken, fallbackError: "Unable to load notifications",
  });
  if (!result.success) throw new Error(result.error);
  const page = result.value;
  if (!Array.isArray(page.items) || typeof page.asOf !== "string" || !Number.isFinite(page.unreadCount)) throw new Error("Invalid notification response.");
  const items: ProductNotification[] = [];
  for (const item of page.items) {
    if (!item || typeof item !== "object" || item.version !== 1) continue;
    const url = canonicalNotificationUrl(item.url);
    if (!UUID_PATTERN.test(item.id) || !isNotificationEventName(item.eventName) || !url || !NOTIFICATION_CATEGORIES.includes(item.category)) continue;
    items.push({ ...item, url, title: "Instafy", body: NOTIFICATION_EVENT_LABELS[item.eventName] });
  }
  return { items, nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null, unreadCount: Math.max(0, page.unreadCount), asOf: page.asOf };
}
export async function updateProductNotificationState(params: { id: string; action: "seen" | "read" | "archive"; accessToken?: string }): Promise<void> {
  const result = await controllerJsonRequest({ path: "/me/notifications/state", method: "POST", accessToken: params.accessToken, body: { id: params.id, action: params.action }, fallbackError: "Unable to update notification" });
  if (!result.success) throw new Error(result.error);
}
export async function readAllProductNotifications(params: { before: string; accessToken?: string }): Promise<void> {
  const result = await controllerJsonRequest({ path: "/me/notifications/read-all", method: "POST", accessToken: params.accessToken, body: { before: params.before }, fallbackError: "Unable to mark notifications read" });
  if (!result.success) throw new Error(result.error);
}
export async function getProductNotificationPreferences(accessToken?: string): Promise<NotificationPreferences> {
  const result = await controllerJsonRequest<NotificationPreferences>({ path: "/me/notifications/preferences", accessToken, fallbackError: "Unable to load notification preferences" });
  if (!result.success) throw new Error(result.error);
  return result.value;
}
export async function saveProductNotificationPreferences(params: Partial<NotificationPreferences> & { accessToken?: string }): Promise<NotificationPreferences> {
  const result = await controllerJsonRequest<NotificationPreferences>({ path: "/me/notifications/preferences", method: "POST", accessToken: params.accessToken, body: { hidePreviews: params.hidePreviews, preferences: params.preferences }, fallbackError: "Unable to save notification preferences" });
  if (!result.success) throw new Error(result.error);
  return result.value;
}
