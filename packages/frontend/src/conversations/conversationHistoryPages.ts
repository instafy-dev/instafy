import type { InfiniteData } from "@tanstack/react-query";
import type { ChatMessage } from "../screens/studio/types";

export const CONVERSATION_HISTORY_PAGE_SIZE = 50;

export type ConversationHistoryPage = {
  messages: ChatMessage[];
  nextCursor: string | null;
  hasMore: boolean;
  notFound: boolean;
  accessDenied: boolean;
  readVersion: number;
};

export type ConversationHistoryData = InfiniteData<ConversationHistoryPage, string | null>;

/** Retain a contiguous range of server history while refreshing only its newest page. */
export function reconcileConversationHistory(
  cached: ConversationHistoryData | undefined,
  latest: ConversationHistoryPage,
): ConversationHistoryData {
  const first = cached?.pages[0];
  if (first && first.readVersion >= latest.readVersion) {
    return cached;
  }
  const replacement = { pages: [latest], pageParams: [null] };
  if (!cached || latest.accessDenied || latest.notFound || !latest.hasMore || !latest.messages.length) {
    return replacement;
  }

  const ids = new Set(latest.messages.map((message) => message.id));
  const retained = cached.pages.flatMap((page) => page.messages);
  const oldestFreshId = latest.messages[latest.messages.length - 1].id;
  const overlap = retained.findIndex((message) => message.id === oldestFreshId);
  if (overlap < 0) {
    // More than a page arrived while away. Start pagination at the new page's
    // cursor instead of joining two ranges with an unseen gap between them.
    return replacement;
  }

  // Preserve server order. Chat timestamps have only millisecond precision;
  // rebuilding cursor order from them can skip rows created microseconds apart.
  // The fresh range is authoritative, including edits and removals in it.
  const messages = [...latest.messages, ...retained.slice(overlap + 1).filter((message) => !ids.has(message.id))];
  const hasOlder = cached.pages[cached.pages.length - 1]?.hasMore ?? latest.hasMore;
  const pages: ConversationHistoryPage[] = [];
  const pageParams: Array<string | null> = [];
  for (let offset = 0; offset < messages.length; offset += CONVERSATION_HISTORY_PAGE_SIZE) {
    const slice = messages.slice(offset, offset + CONVERSATION_HISTORY_PAGE_SIZE);
    const hasMore = offset + slice.length < messages.length || hasOlder;
    pageParams.push(pages[pages.length - 1]?.nextCursor ?? null);
    pages.push({
      ...latest,
      messages: slice,
      nextCursor: hasMore ? slice[slice.length - 1].id : null,
      hasMore,
    });
  }
  return { pages, pageParams };
}
