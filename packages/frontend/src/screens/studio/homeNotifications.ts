import { canonicalNotificationUrl, type ProductNotification } from "../../notifications/notificationContract";
import type { HomeFeedEvent } from "./homeFeed";

export interface HomeNotificationTarget {
  key: string;
  url: string;
  kind: "conversation" | "support" | "automation";
  projectId: string | null;
  conversationId: string | null;
  supportReportId: string | null;
  resourceId: string;
}

/**
 * Destination identity comes from the same allowlisted URL used to navigate.
 * A failed run in no chat has none: there is nothing for the person to open
 * and read, so Home never lists it ("Run failed · All teams" stayed unread for
 * days). The activity ledger's own row for it stays in Recent activity.
 */
export function getHomeNotificationTarget(item: ProductNotification): HomeNotificationTarget | null {
  const canonical = canonicalNotificationUrl(item.url);
  if (!canonical) return null;
  const params = new URL(canonical, "https://instafy.invalid").searchParams;
  const projectId = params.get("projectId");
  const conversationId = params.get("conversationControllerId");
  const supportReportId = params.get("supportReportId");
  const resourceId = item.resourceId.trim().toLowerCase();
  const base = { url: canonical, projectId, conversationId, supportReportId, resourceId };
  if (item.eventName.startsWith("support.")) {
    return supportReportId ? { ...base, kind: "support", key: `support:${supportReportId}` } : null;
  }
  if (item.eventName.startsWith("automation.")) {
    return resourceId ? { ...base, kind: "automation", key: `automation:${projectId ?? ""}:${resourceId}` } : null;
  }
  return conversationId && (item.eventName === "conversation.reply" || item.eventName === "run.failed")
    ? { ...base, kind: "conversation", key: `conversation:${conversationId}` }
    : null;
}

export function homeNotificationIsUnread(item: ProductNotification): boolean {
  return !item.readAt && !item.archivedAt;
}

/**
 * Whether this notification alone lists its row under Unread. A failed run
 * is shown in its chat as the turn's failure block and is read with the chat,
 * but reading a chat marks only its replies read, so its failure stayed unread
 * after the person had read it. The chat's own unread state (its inbox row, an
 * unread reply) lists it instead; a failure only names the row's status.
 */
export function homeNotificationMakesUnread(item: ProductNotification): boolean {
  return homeNotificationIsUnread(item) && item.eventName !== "run.failed";
}

/** Live activity and unrelated events with the same project URL never merge. */
export function homeEventMatchesNotification(
  event: HomeFeedEvent,
  item: ProductNotification,
  conversationKey: (event: HomeFeedEvent) => string,
): boolean {
  const target = getHomeNotificationTarget(item);
  if (!target || event.kind === "running" || event.kind === "queued") return false;
  if (target.projectId && event.project.id && target.projectId !== event.project.id.toLowerCase()) return false;
  const activity = event.source.type === "activity" ? event.source.item : null;
  const isAutomationActivity = activity?.kind.startsWith("automation.") || typeof activity?.data.automationId === "string";
  if (target.kind === "conversation" && !isAutomationActivity && conversationKey(event) === target.conversationId) return true;
  if (event.source.type !== "activity") return false;
  if (item.eventName === "run.failed" && !isAutomationActivity && event.source.item.run?.id.toLowerCase() === target.resourceId) return true;
  const automationId = event.source.item.data.automationId;
  return target.kind === "automation" && typeof automationId === "string" &&
    automationId.toLowerCase() === target.resourceId &&
    ["automation.failed", "automation.completed", "run.failed", "run.finished"].includes(event.source.item.kind);
}

/** Add durable state without replacing the richer title and preview in Home. */
export function mergeHomeNotificationEvents(
  existing: HomeFeedEvent[],
  notifications: HomeFeedEvent[],
  conversationKey: (event: HomeFeedEvent) => string,
): HomeFeedEvent[] {
  const result = [...existing];
  for (const notification of notifications) {
    const items = notification.notifications ?? [];
    const matching = result.filter((event) => items.some((item) => homeEventMatchesNotification(event, item, conversationKey)));
    if (!matching.length) {
      result.push(notification);
      continue;
    }
    // Keep the legacy acknowledgement source, then prefer detailed ledger rows
    // over the recent-chat fallback. Ordering remains the latest event's time.
    matching.sort((a, b) => {
      const rank = (event: HomeFeedEvent) => event.lane === "needs" ? 0 : event.source.type === "activity" ? 1 : 2;
      return rank(a) - rank(b) || (b.at ?? 0) - (a.at ?? 0);
    });
    const preferred = matching[0];
    const allItems = new Map([...matching.flatMap((event) => event.notifications ?? []), ...items].map((item) => [item.id, item]));
    const lane = matching.some((event) => event.lane === "needs") || [...allItems.values()].some(homeNotificationMakesUnread)
      ? "needs" : "activity";
    const latestNotification = (notification.at ?? 0) >= (preferred.at ?? 0);
    const latestKind = latestNotification ? notification.kind : preferred.kind;
    const outcome = (event: HomeFeedEvent) => {
      if (event.kind === "run_failed" || event.kind === "automation_failed") return "failed";
      if (event.kind === "run_finished" || event.kind === "automation_completed") return "completed";
      return event.kind;
    };
    const outcomeChanged = latestNotification && outcome(notification) !== outcome(preferred);
    const sameFailure = outcome(notification) === "failed" && outcome(preferred) === "failed";
    const merged: HomeFeedEvent = {
      ...preferred,
      lane,
      kind: latestKind,
      // An old run's failure text is not the description of a later success.
      // Keep content-rich previews only while they describe the same outcome.
      preview: outcomeChanged ? notification.preview : preferred.preview,
      statusLabel: latestNotification
        ? sameFailure ? preferred.statusLabel ?? notification.statusLabel : notification.statusLabel
        : preferred.statusLabel,
      at: Math.max(...[notification, ...matching].map((event) => event.at ?? 0)) || null,
      dismissible: lane === "needs",
      notifications: [...allItems.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
    };
    for (const event of matching) result.splice(result.indexOf(event), 1);
    result.push(merged);
  }
  return result;
}
