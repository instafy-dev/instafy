import type { HomeFeedEvent } from "./homeFeed";
import { getHomeNotificationTarget } from "./homeNotifications";

/** A small cross-space shortcut list, derived from freshly authorized Home
 * activity. Names are not identities: two teams can have the same chat title. */
export function homeRecentChats(events: readonly HomeFeedEvent[], recentlyOpened: readonly string[], limit = 4): HomeFeedEvent[] {
  const chats = new Map<string, HomeFeedEvent>();
  for (const event of [...events].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    if (event.source.type !== "activity") continue;
    const chat = event.source.item.conversation;
    if (!chat?.id || chat.threadKind === "automation" || event.notifications?.some(item => getHomeNotificationTarget(item)?.kind === "automation")) continue;
    const key = JSON.stringify([event.project.id, chat.id]);
    if (!chats.has(key)) chats.set(key, event);
  }
  return recentlyOpened.flatMap(key => chats.has(key) ? [chats.get(key)!] : []).slice(0, limit);
}
