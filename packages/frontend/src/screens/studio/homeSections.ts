import type { ConversationState } from "../../conversations/ConversationsProvider";
import { HOME_LIVE_DAY_KEY, type HomeFeedDay, type HomeFeedEvent, type HomeFeedModel } from "./homeFeed";
import { getHomeNotificationTarget } from "./homeNotifications";

/**
 * Which chat a Home row is about, or null when it is about no chat (a support
 * report, an automation, a run outside any chat). Chat ids are the
 * controller's; a chat the controller has not given one yet is known by its
 * local id, which only the open space has.
 */
export function homeChatKey(event: HomeFeedEvent, conversations: readonly ConversationState[]): string | null {
  const key = (value: string | null | undefined) => value?.trim().toLowerCase() || null;
  switch (event.source.type) {
    case "conversation": {
      const localId = event.source.localConversationId;
      const local = conversations.find((conversation) => conversation.localId === localId);
      return key(local?.controllerId) ?? key(localId);
    }
    case "inbox":
      return event.source.entry.source === "inbox" ? key(event.source.entry.inboxItem.conversationId) : null;
    case "activity":
      return key(event.source.item.conversation?.id);
    case "notification": {
      const target = getHomeNotificationTarget(event.source.item);
      return target?.kind === "conversation" ? key(target.conversationId) : null;
    }
    case "recent":
      return key(event.source.recent.conversationId) ?? key(event.source.recent.localConversationId);
    default:
      return null;
  }
}

/** The chat a Continue working row resumes, keyed like homeChatKey. */
export function homeConversationChatKey(conversation: Pick<ConversationState, "localId" | "controllerId">): string {
  return (conversation.controllerId?.trim() || conversation.localId).toLowerCase();
}

export interface HomeSections {
  /** Whether Continue working shows its chat: not when that chat is already unread. */
  showResume: boolean;
  needs: HomeFeedEvent[];
  recentChats: HomeFeedEvent[];
  /** Recent activity, In progress first, then by day. */
  activity: HomeFeedDay[];
  sinceCutIndex: number | null;
}

function updateCount(event: HomeFeedEvent): number {
  return event.group?.count ?? 1;
}

/** Two rows in a row for one chat read as one: the newer row, standing for both. */
function mergeRows(newer: HomeFeedEvent, older: HomeFeedEvent): HomeFeedEvent {
  const notifications = new Map([...(newer.notifications ?? []), ...(older.notifications ?? [])].map((item) => [item.id, item]));
  return {
    ...newer,
    isNew: newer.isNew || older.isNew,
    dismissible: newer.dismissible || older.dismissible,
    group: {
      count: updateCount(newer) + updateCount(older),
      newCount: (newer.group?.newCount ?? (newer.isNew ? 1 : 0)) + (older.group?.newCount ?? (older.isNew ? 1 : 0)),
      ids: [...(newer.group?.ids ?? []), ...(older.group?.ids ?? [])],
    },
    ...(notifications.size ? { notifications: [...notifications.values()] } : {}),
  };
}

/**
 * Home lists each chat once. A chat that is unread is under Unread only; the
 * chat Continue working resumes is not listed again below it; Recent chats
 * leaves out both; and Recent activity leaves out every chat listed above it.
 * Rows that remain in a row for the same chat merge into one.
 */
export function arrangeHomeSections({
  feed,
  conversations,
  resumeChatKey,
  recentChats,
}: {
  feed: Pick<HomeFeedModel, "needs" | "activity" | "hasCut">;
  conversations: readonly ConversationState[];
  /** The chat Continue working would resume, or null when there is none. */
  resumeChatKey: string | null;
  /** Recently opened chats, drawn from this feed's own rows. */
  recentChats: readonly HomeFeedEvent[];
}): HomeSections {
  const chatKey = (event: HomeFeedEvent) => homeChatKey(event, conversations);
  const listed = new Set(feed.needs.map(chatKey).filter((key): key is string => key !== null));
  const showResume = resumeChatKey !== null && !listed.has(resumeChatKey);
  if (showResume) listed.add(resumeChatKey);
  const shownRecentChats = recentChats.filter((event) => {
    const key = chatKey(event);
    return key !== null && !listed.has(key);
  });
  for (const event of shownRecentChats) listed.add(chatKey(event)!);

  const activity: HomeFeedDay[] = [];
  for (const day of feed.activity) {
    const events: HomeFeedEvent[] = [];
    for (const event of day.events) {
      const key = chatKey(event);
      if (key !== null && listed.has(key)) continue;
      const previous = events.at(-1);
      if (key !== null && previous && chatKey(previous) === key) {
        events[events.length - 1] = mergeRows(previous, event);
        continue;
      }
      events.push(event);
    }
    if (events.length) activity.push({ ...day, events });
  }

  // The cut sits before the first row already seen, past the In progress rows,
  // and only when there is something on both sides of it.
  const live = activity.find((day) => day.key === HOME_LIVE_DAY_KEY)?.events.length ?? 0;
  const dated = activity.filter((day) => day.key !== HOME_LIVE_DAY_KEY).flatMap((day) => day.events);
  const firstSeen = dated.findIndex((event) => !event.isNew);
  const sinceCutIndex = feed.hasCut && firstSeen > 0 ? live + firstSeen : null;

  return { showResume, needs: feed.needs, recentChats: shownRecentChats, activity, sinceCutIndex };
}
