import { getOrgDisplayName } from "../../org/orgNaming";
import type { ConversationState } from "../../conversations/ConversationsProvider";
import type { NotificationInboxItem } from "../../sdk/instafy";

export type HomeAttentionKind = "running" | "queued" | "reply";

interface HomeAttentionEntryBase {
  key: string;
  title: string;
  subtitle: string;
  meta: string | null;
  preview: string | null;
  kind: HomeAttentionKind;
  testId: string;
}

export interface HomeAttentionConversationEntry extends HomeAttentionEntryBase {
  source: "conversation";
  localConversationId: string;
}

export interface HomeAttentionInboxEntry extends HomeAttentionEntryBase {
  source: "inbox";
  inboxItem: NotificationInboxItem;
}

export type HomeAttentionEntry = HomeAttentionConversationEntry | HomeAttentionInboxEntry;

interface BuildHomeAttentionEntriesOptions {
  conversations: ConversationState[];
  inboxItems: NotificationInboxItem[];
  currentSpaceName: string;
  /** Local conversation currently rendered in a visible Chat surface. */
  visibleConversationLocalId?: string | null;
  /** Controller conversation currently rendered in a visible Chat surface. */
  visibleConversationControllerId?: string | null;
  /** Optional cap; the queue is uncapped by default (bounded by MAX_ATTENTION_ENTRIES). */
  limit?: number;
}

/** Render-safety ceiling, far above anything a real account produces. */
const MAX_ATTENTION_ENTRIES = 200;

function formatRelativeTimestamp(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const timestamp = new Date(raw).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));
  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function getConversationPreview(conversation: ConversationState): string | null {
  const candidate = [...conversation.messages]
    .reverse()
    .find((message) => message.content.trim().length > 0);
  return candidate?.content.trim() ?? null;
}

function getSpaceLabel(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "Untitled Space";
}

function normalizeConversationIdentity(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function excludeVisibleConversationInboxItems(
  inboxItems: NotificationInboxItem[],
  visibleConversationControllerId: string | null | undefined,
): NotificationInboxItem[] {
  const visibleControllerId = normalizeConversationIdentity(visibleConversationControllerId);
  if (!visibleControllerId) {
    return inboxItems;
  }
  const filtered = inboxItems.filter(
    (item) => normalizeConversationIdentity(item.conversationId) !== visibleControllerId,
  );
  return filtered.length === inboxItems.length ? inboxItems : filtered;
}

export function buildHomeAttentionEntries({
  conversations,
  inboxItems,
  currentSpaceName,
  visibleConversationLocalId,
  visibleConversationControllerId,
  limit,
}: BuildHomeAttentionEntriesOptions): HomeAttentionEntry[] {
  const maxEntries = Math.min(limit ?? MAX_ATTENTION_ENTRIES, MAX_ATTENTION_ENTRIES);
  const items: HomeAttentionEntry[] = [];
  const seenConversationIds = new Set<string>();
  const visibleLocalId = normalizeConversationIdentity(visibleConversationLocalId);
  const visibleControllerId = normalizeConversationIdentity(visibleConversationControllerId);

  const registerConversation = (
    conversation: ConversationState,
    kind: HomeAttentionKind,
    subtitle: string,
    meta: string | null,
    preview: string | null,
  ) => {
    const localId = normalizeConversationIdentity(conversation.localId);
    const controllerId = normalizeConversationIdentity(conversation.controllerId);
    if (
      (visibleLocalId && localId === visibleLocalId) ||
      (visibleControllerId && controllerId === visibleControllerId)
    ) {
      return;
    }
    const dedupeKey = controllerId || localId;
    if (!dedupeKey || seenConversationIds.has(dedupeKey)) {
      return;
    }
    seenConversationIds.add(dedupeKey);
    items.push({
      key: `${kind}-${conversation.localId}`,
      title: conversation.title || "Conversation",
      subtitle,
      meta,
      preview,
      kind,
      source: "conversation",
      localConversationId: conversation.localId,
      testId: `home-attention-conversation-${dedupeKey}`,
    });
  };

  [...conversations]
    .filter((conversation) => conversation.lifecycleStatus === "active" && conversation.pendingRunIds.length > 0)
    .sort((a, b) => {
      const aTimestamp = a.messages.at(-1)?.timestamp ?? a.createdAt;
      const bTimestamp = b.messages.at(-1)?.timestamp ?? b.createdAt;
      return bTimestamp - aTimestamp;
    })
    .forEach((conversation) => {
      registerConversation(
        conversation,
        "running",
        `${currentSpaceName} · run in progress`,
        null,
        getConversationPreview(conversation),
      );
    });

  [...conversations]
    .filter(
      (conversation) =>
        conversation.lifecycleStatus === "active" &&
        conversation.pendingRunIds.length === 0 &&
        conversation.awaitingLeaseRunIds.length > 0,
    )
    .sort((a, b) => {
      const aTimestamp = a.messages.at(-1)?.timestamp ?? a.createdAt;
      const bTimestamp = b.messages.at(-1)?.timestamp ?? b.createdAt;
      return bTimestamp - aTimestamp;
    })
    .forEach((conversation) => {
      registerConversation(
        conversation,
        "queued",
        `${currentSpaceName} · waiting for a runtime`,
        null,
        getConversationPreview(conversation),
      );
    });

  [...conversations]
    .filter(
      (conversation) =>
        conversation.lifecycleStatus === "active" &&
        conversation.pendingRunIds.length === 0 &&
        conversation.awaitingLeaseRunIds.length === 0 &&
        conversation.unreadCount > 0,
    )
    .sort((a, b) => {
      if (b.unreadCount !== a.unreadCount) {
        return b.unreadCount - a.unreadCount;
      }
      const aTimestamp = a.messages.at(-1)?.timestamp ?? a.createdAt;
      const bTimestamp = b.messages.at(-1)?.timestamp ?? b.createdAt;
      return bTimestamp - aTimestamp;
    })
    .forEach((conversation) => {
      const unreadLabel = conversation.unreadCount === 1 ? "1 unread" : `${conversation.unreadCount} unread`;
      registerConversation(
        conversation,
        "reply",
        `${currentSpaceName} · ${unreadLabel}`,
        null,
        getConversationPreview(conversation),
      );
    });

  excludeVisibleConversationInboxItems(inboxItems, visibleControllerId).forEach((item) => {
    if (items.length >= maxEntries) {
      return;
    }
    const conversationId = normalizeConversationIdentity(item.conversationId);
    if (!conversationId || seenConversationIds.has(conversationId)) {
      return;
    }
    seenConversationIds.add(conversationId);
    const orgLabel = getOrgDisplayName(item.orgName ?? null);
    items.push({
      key: `inbox-${conversationId}`,
      title: item.conversationTitle?.trim() || "New reply",
      subtitle: [getSpaceLabel(item.projectName), orgLabel].filter(Boolean).join(" · "),
      meta: formatRelativeTimestamp(item.lastMessageAt),
      preview: item.lastMessagePreview?.trim() || null,
      kind: "reply",
      source: "inbox",
      inboxItem: item,
      testId: `home-attention-conversation-${conversationId}`,
    });
  });

  return items.slice(0, maxEntries);
}
