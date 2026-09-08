import { useEffect, useMemo, useRef, useState } from "react";
import {
  isEmptyConversationPlaceholder,
  type ConversationState,
} from "../conversations/conversationState";

const MAX_VISITED_CONVERSATIONS = 50;
const DEFAULT_VISIBLE_CONVERSATIONS = 6;

export interface UseRecentConversationsOptions {
  conversations: ConversationState[];
  activeConversationId: string | null;
  userId: string | null;
  projectKey: string;
  historyResolved: boolean;
  limit?: number;
}

function readVisitedIds(storageKey: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0,
    ))].slice(0, MAX_VISITED_CONVERSATIONS);
  } catch {
    // Recents still work in memory when storage is unavailable.
    return [];
  }
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Recent visits are independent of open tabs; conversation content stays provider-owned. */
export function useRecentConversations({
  conversations,
  activeConversationId,
  userId,
  projectKey,
  historyResolved,
  limit = DEFAULT_VISIBLE_CONVERSATIONS,
}: UseRecentConversationsOptions): ConversationState[] {
  const storageKey = `instafy.workspace.recent-conversations:${JSON.stringify([userId, projectKey])}`;
  const persistedIds = useMemo(() => readVisitedIds(storageKey), [storageKey]);
  const [visits, setVisits] = useState(() => ({ storageKey, ids: persistedIds }));
  const [visibleOrder, setVisibleOrder] = useState<{ storageKey: string; ids: string[] } | null>(null);
  // Use the destination's state immediately, before effects, on account/space switches.
  const visitedIds = visits.storageKey === storageKey ? visits.ids : persistedIds;
  const previousActive = useRef<{
    storageKey: string;
    conversation: ConversationState | null;
  }>({ storageKey, conversation: null });
  const knownActive = previousActive.current.storageKey === storageKey
    && previousActive.current.conversation?.localId === activeConversationId
    ? previousActive.current.conversation
    : null;
  const byId = new Map(conversations.map((conversation) => [conversation.localId, conversation]));
  const available = conversations.filter((conversation) => (
    conversation.lifecycleStatus === "active"
    && (!isEmptyConversationPlaceholder(conversation)
      || (conversation.localId === activeConversationId && (historyResolved || knownActive !== null)))
  ));
  // A temporary history refresh must not make the currently visible chat disappear.
  // Explicit lifecycle changes and a resolved removal always take precedence.
  if (!historyResolved && knownActive && !byId.has(knownActive.localId)) {
    available.unshift(knownActive);
  }
  const availableById = new Map(available.map((conversation) => [conversation.localId, conversation]));
  const activeConversation = activeConversationId
    ? availableById.get(activeConversationId) ?? null
    : null;
  const nextVisitedIds = [...new Set([
    ...(activeConversation ? [activeConversation.localId] : []),
    ...visitedIds,
  ])].filter((id) => availableById.has(id) || (!historyResolved && !byId.has(id)))
    .slice(0, MAX_VISITED_CONVERSATIONS);

  const visibleLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(MAX_VISITED_CONVERSATIONS, Math.trunc(limit)))
    : DEFAULT_VISIBLE_CONVERSATIONS;
  const rankedIds = [...new Set([...nextVisitedIds, ...availableById.keys()])];
  // Keep the quick switcher's targets in place. MRU still chooses its initial
  // contents and which chat to replace when opening one outside the list.
  const previousVisibleIds = visibleOrder?.storageKey === storageKey
    ? visibleOrder.ids
    : rankedIds.slice(0, visibleLimit);
  const nextVisibleIds = previousVisibleIds
    .filter((id) => availableById.has(id) || (!historyResolved && !byId.has(id)))
    .slice(0, visibleLimit);
  if (activeConversation && visibleLimit > 0 && !nextVisibleIds.includes(activeConversation.localId)) {
    if (nextVisibleIds.length === visibleLimit) {
      let evictIndex = nextVisibleIds.length - 1;
      let oldestRank = -1;
      nextVisibleIds.forEach((id, index) => {
        const visitIndex = nextVisitedIds.indexOf(id);
        const rank = visitIndex < 0 ? Number.POSITIVE_INFINITY : visitIndex;
        if (rank >= oldestRank) {
          oldestRank = rank;
          evictIndex = index;
        }
      });
      nextVisibleIds.splice(evictIndex, 1);
    }
    nextVisibleIds.unshift(activeConversation.localId);
  }
  for (const id of rankedIds) {
    if (nextVisibleIds.length >= visibleLimit) break;
    if (availableById.has(id) && !nextVisibleIds.includes(id)) nextVisibleIds.push(id);
  }

  useEffect(() => {
    previousActive.current = { storageKey, conversation: activeConversation };
    setVisits((current) => current.storageKey === storageKey && sameIds(current.ids, nextVisitedIds)
      ? current
      : { storageKey, ids: nextVisitedIds });
    // Missing rows keep their slots until history resolves, so refreshing
    // cannot reshuffle the list when those conversations arrive again.
    setVisibleOrder((current) => current?.storageKey === storageKey && sameIds(current.ids, nextVisibleIds)
      ? current
      : { storageKey, ids: nextVisibleIds });
    if (sameIds(visitedIds, nextVisitedIds)) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(nextVisitedIds));
    } catch {
      // Private browsing and full storage must not prevent chat switching.
    }
  }, [activeConversation, nextVisibleIds, nextVisitedIds, storageKey, visitedIds]);

  return nextVisibleIds
    .flatMap((id) => availableById.get(id) ?? [])
    .slice(0, visibleLimit);
}
