import type { InfiniteData, Query, QueryClient } from "@tanstack/react-query";

export const CONVERSATION_HISTORY_GC_TIME_MS = 30 * 60 * 1_000;

const MAX_INACTIVE_CONVERSATIONS = 10;
const MAX_INACTIVE_PAGES = 20;
const MAX_INACTIVE_PAYLOAD_BYTES = 8 * 1_024 * 1_024;
const HISTORY_QUERY = "conversation-messages";
const LATEST_QUERY = "conversation-messages-latest";

type CachedHistory = InfiniteData<{ messages: unknown[] }>;
type CacheRetention = { references: number; dispose: () => void };
const retainedClients = new WeakMap<QueryClient, CacheRetention>();

function isHistoryQuery(query: Query): boolean {
  return query.queryKey[0] === HISTORY_QUERY || query.queryKey[0] === LATEST_QUERY;
}

function conversationKey(query: Query): string | null {
  const [, userId, conversationId] = query.queryKey;
  return isHistoryQuery(query) && typeof userId === "string" && typeof conversationId === "string"
    ? JSON.stringify([userId, conversationId])
    : null;
}

/** Remove protected history on account changes, even if an old observer is still mounted. */
export function removeOtherAccountsConversationHistory(
  queryClient: QueryClient,
  currentUserId: string | null,
): void {
  queryClient.removeQueries({
    predicate: (query) => isHistoryQuery(query) && (
      currentUserId === null || query.queryKey[1] !== currentUserId
    ),
  });
}

function installRetention(queryClient: QueryClient): () => void {
  const cache = queryClient.getQueryCache();
  const lastUsed = new Map<string, number>();
  const payloadSizes = new WeakMap<object, number>();
  let useOrder = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pruning = false;

  function payloadSize(data: unknown): number {
    if (data === undefined) return 0;
    if (data !== null && typeof data === "object") {
      const cached = payloadSizes.get(data);
      if (cached !== undefined) return cached;
    }
    let bytes: number;
    try {
      // Conservatively count the serialized UTF-16 payload, not an exact JS heap size.
      bytes = (JSON.stringify(data)?.length ?? 0) * 2;
    } catch {
      bytes = Infinity;
    }
    if (data !== null && typeof data === "object") payloadSizes.set(data, bytes);
    return bytes;
  }

  function prune(): void {
    timer = undefined;
    pruning = true;
    try {
      const conversations = new Map<string, Query[]>();
      for (const query of cache.getAll()) {
        const key = conversationKey(query);
        if (key === null) continue;
        const queries = conversations.get(key) ?? [];
        queries.push(query);
        conversations.set(key, queries);
        if (!lastUsed.has(key)) lastUsed.set(key, ++useOrder);
      }
      for (const key of lastUsed.keys()) {
        if (!conversations.has(key)) lastUsed.delete(key);
      }

      const inactive: { key: string; queries: Query[]; bytes: number }[] = [];
      for (const [key, queries] of conversations) {
        // Both queries belong to one transcript. Disabled mounted observers can
        // still be displaying its data, so protect them as well as enabled ones.
        if (queries.some((query) => query.getObserversCount() > 0)) continue;
        for (const query of queries) {
          if (query.queryKey[0] !== HISTORY_QUERY) continue;
          const data = query.state.data as CachedHistory | undefined;
          if (data && Array.isArray(data.pages) && data.pages.length > MAX_INACTIVE_PAGES) {
            queryClient.setQueryData(query.queryKey, {
              ...data,
              pages: data.pages.slice(0, MAX_INACTIVE_PAGES),
              pageParams: data.pageParams.slice(0, MAX_INACTIVE_PAGES),
            }, { updatedAt: query.state.dataUpdatedAt });
          }
        }
        inactive.push({
          key,
          queries,
          bytes: queries.reduce((bytes, query) => bytes + payloadSize(query.state.data), 0),
        });
      }

      inactive.sort((a, b) => (lastUsed.get(a.key) ?? 0) - (lastUsed.get(b.key) ?? 0));
      const retained = inactive.filter((entry) => {
        // An individually oversized transcript cannot fit even after every
        // other entry is evicted. Keep the useful small entries in that case.
        if (entry.bytes <= MAX_INACTIVE_PAYLOAD_BYTES) return true;
        for (const query of entry.queries) cache.remove(query);
        lastUsed.delete(entry.key);
        return false;
      });
      let remainingCount = retained.length;
      let remainingBytes = retained.reduce((bytes, entry) => bytes + entry.bytes, 0);
      for (const entry of retained) {
        if (remainingCount <= MAX_INACTIVE_CONVERSATIONS && remainingBytes <= MAX_INACTIVE_PAYLOAD_BYTES) break;
        for (const query of entry.queries) cache.remove(query);
        lastUsed.delete(entry.key);
        remainingCount -= 1;
        remainingBytes -= entry.bytes;
      }
    } finally {
      pruning = false;
    }
  }

  function schedulePrune(): void {
    // Coalesce the history/latest observer handoff, and keep serialization out
    // of the synchronous tab-switch commit. The size cache only holds weak refs.
    if (timer === undefined) timer = setTimeout(prune, 0);
  }

  // Preserve the relative age of data that predates the first mounted consumer.
  for (const query of [...cache.getAll()].sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)) {
    const key = conversationKey(query);
    if (key !== null) lastUsed.set(key, ++useOrder);
  }
  const unsubscribe = cache.subscribe((event) => {
    if (pruning) return;
    const key = conversationKey(event.query);
    if (key === null) return;
    if (event.type === "observerResultsUpdated" || event.type === "observerOptionsUpdated") return;
    if (!lastUsed.has(key) || event.type === "observerAdded" || event.type === "observerRemoved") {
      lastUsed.set(key, ++useOrder);
    }
    schedulePrune();
  });
  schedulePrune();

  return () => {
    unsubscribe();
    // The final consumer may have just detached from a large transcript.
    schedulePrune();
  };
}

/** Share one bounded, in-memory history policy across all consumers of a client. */
export function retainConversationHistoryCache(queryClient: QueryClient): () => void {
  let retention = retainedClients.get(queryClient);
  if (!retention) {
    retention = { references: 0, dispose: installRetention(queryClient) };
    retainedClients.set(queryClient, retention);
  }
  retention.references += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retention.references -= 1;
    if (retention.references === 0) {
      retention.dispose();
      retainedClients.delete(queryClient);
    }
  };
}
