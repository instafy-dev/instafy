import type { ActivityItem } from "../../services/runtimeController/activity";

/** A viewer-authorized slice. Never mix personal or another team's activity into this view. */
export function teamActivity(items: ActivityItem[], organizationId: string | null): ActivityItem[] {
  if (!organizationId) return [];
  const latest = new Map<string, ActivityItem>();
  for (const item of items) {
    if (item.org?.id !== organizationId || !item.project?.id || !item.conversation?.id) continue;
    const key = item.run?.id ?? item.conversation.id;
    const previous = latest.get(key);
    if (!previous || Date.parse(item.at) > Date.parse(previous.at)) latest.set(key, item);
  }
  return [...latest.values()].sort((a, b) => Number(b.live) - Number(a.live)
    || Number(b.needsYou) - Number(a.needsYou) || Date.parse(b.at) - Date.parse(a.at));
}

export function teamWorkStatus(item: ActivityItem): string {
  if (item.needsYou) return "Needs attention";
  const status = item.run?.status;
  if (status === "failed" || status === "error") return "Run failed";
  if (status === "canceled" || status === "cancelled") return "Canceled";
  if (status === "queued" || status === "pending" || status === "awaiting_lease") return "Queued";
  if (item.live) return "Running";
  if (status === "success" || status === "succeeded" || status === "completed") return "Turn completed";
  return "Update";
}

export function teamWorkHref(item: ActivityItem): string | null {
  if (!item.project?.id || !item.conversation?.id) return null;
  const params = new URLSearchParams({
    projectId: item.project.id,
    conversationControllerId: item.conversation.id,
    panel: "chat",
  });
  return `/studio?${params}`;
}
