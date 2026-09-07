import { QueryClient, QueryObserver, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_HISTORY_GC_TIME_MS,
  removeOtherAccountsConversationHistory,
  retainConversationHistoryCache,
} from "../conversationHistoryCache";

type Page = {
  messages: { id: string; content: string }[];
  nextCursor: string | null;
  hasMore: boolean;
  notFound: boolean;
  accessDenied: boolean;
};

const historyKey = (id: string, user = "user-a") => ["conversation-messages", user, id] as const;
const latestKey = (id: string, user = "user-a") => ["conversation-messages-latest", user, id] as const;

function history(pages = 1, content = "Saved message"): InfiniteData<Page, string | null> {
  return {
    pages: Array.from({ length: pages }, (_, index) => ({
      messages: [{ id: `message-${index}`, content }],
      nextCursor: index < pages - 1 ? `cursor-${index + 1}` : null,
      hasMore: index < pages - 1,
      notFound: false,
      accessDenied: false,
    })),
    pageParams: Array.from({ length: pages }, (_, index) => index === 0 ? null : `cursor-${index}`),
  };
}

describe("conversation history cache retention", () => {
  let client: QueryClient;
  let release: () => void;
  const subscriptions: (() => void)[] = [];

  function observe(key: readonly string[]) {
    const observer = new QueryObserver(client, { queryKey: key, enabled: false });
    const unsubscribe = observer.subscribe(() => undefined);
    subscriptions.push(unsubscribe);
    return unsubscribe;
  }

  async function maintain() {
    await vi.advanceTimersByTimeAsync(1);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient({
      defaultOptions: { queries: { gcTime: CONVERSATION_HISTORY_GC_TIME_MS } },
    });
    release = retainConversationHistoryCache(client);
  });

  afterEach(() => {
    subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
    release();
    client.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps active history intact and trims only its inactive tail, preserving the reload cursor", async () => {
    const key = historyKey("long-chat");
    const unsubscribe = observe(key);
    client.setQueryData(key, history(23), { updatedAt: 123 });
    const active = client.getQueryData(key);

    await maintain();
    expect(client.getQueryData(key)).toBe(active);

    unsubscribe();
    await maintain();
    const retained = client.getQueryData<InfiniteData<Page>>(key)!;
    expect(retained.pages).toHaveLength(20);
    expect(retained.pageParams).toHaveLength(20);
    expect(retained.pages[19]).toMatchObject({ hasMore: true, nextCursor: "cursor-20" });
    expect(retained.pageParams[19]).toBe("cursor-19");
    expect(client.getQueryState(key)?.dataUpdatedAt).toBe(123);
  });

  it("preserves the history/latest pair while either query is observed", async () => {
    client.setQueryData(historyKey("pair"), history(23));
    client.setQueryData(latestKey("pair"), history().pages[0]);
    const unsubscribe = observe(latestKey("pair"));

    await maintain();
    expect(client.getQueryData<InfiniteData<Page>>(historyKey("pair"))?.pages).toHaveLength(23);

    unsubscribe();
    await maintain();
    expect(client.getQueryData<InfiniteData<Page>>(historyKey("pair"))?.pages).toHaveLength(20);
  });

  it("does not trim a transcript during an observer handoff in the same task", async () => {
    const key = historyKey("handoff");
    const unsubscribe = observe(key);
    client.setQueryData(key, history(23));
    unsubscribe();
    observe(key);

    await maintain();
    expect(client.getQueryData<InfiniteData<Page>>(key)?.pages).toHaveLength(23);
  });

  it("retains ten inactive conversations by last use and evicts both companion queries", async () => {
    for (let index = 0; index < 10; index += 1) {
      client.setQueryData(historyKey(`chat-${index}`), history());
      client.setQueryData(latestKey(`chat-${index}`), history().pages[0]);
    }
    const unsubscribe = observe(historyKey("chat-0"));
    unsubscribe();
    client.setQueryData(historyKey("chat-10"), history());

    await maintain();
    expect(client.getQueryData(historyKey("chat-0"))).toBeDefined();
    expect(client.getQueryData(historyKey("chat-1"))).toBeUndefined();
    expect(client.getQueryData(latestKey("chat-1"))).toBeUndefined();
    expect(client.getQueryData(historyKey("chat-10"))).toBeDefined();
  });

  it("bounds latest-only cache entries too", async () => {
    for (let index = 0; index < 11; index += 1) {
      client.setQueryData(latestKey(`chat-${index}`), history().pages[0]);
    }
    await maintain();
    expect(client.getQueryData(latestKey("chat-0"))).toBeUndefined();
    expect(client.getQueryData(latestKey("chat-10"))).toBeDefined();
    expect(client.getQueryCache().getAll()).toHaveLength(10);
  });

  it("budgets the combined serialized history and latest-page payload", async () => {
    const content = "x".repeat(700_000);
    for (let index = 0; index < 3; index += 1) {
      client.setQueryData(historyKey(`chat-${index}`), history(1, content));
      client.setQueryData(latestKey(`chat-${index}`), history(1, content).pages[0]);
    }
    await maintain();
    expect(client.getQueryData(historyKey("chat-0"))).toBeUndefined();
    expect(client.getQueryData(latestKey("chat-0"))).toBeUndefined();
    expect(client.getQueryData(historyKey("chat-1"))).toBeDefined();
    expect(client.getQueryData(historyKey("chat-2"))).toBeDefined();
  });

  it("evicts an oversized inactive conversation without truncating messages or discarding smaller chats", async () => {
    client.setQueryData(historyKey("small"), history());
    const oversizedKey = historyKey("oversized");
    const unsubscribe = observe(oversizedKey);
    client.setQueryData(oversizedKey, history(1, "x".repeat(4 * 1_024 * 1_024)));
    await maintain();
    expect(client.getQueryData(oversizedKey)).toBeDefined();

    unsubscribe();
    await maintain();
    expect(client.getQueryData(oversizedKey)).toBeUndefined();
    expect(client.getQueryData(historyKey("small"))).toBeDefined();
  });

  it("shares one subscription and releases it only after the final consumer", async () => {
    release();
    await maintain();
    const subscribe = vi.spyOn(client.getQueryCache(), "subscribe");
    const first = retainConversationHistoryCache(client);
    const second = retainConversationHistoryCache(client);
    expect(subscribe).toHaveBeenCalledTimes(1);
    first();
    first();
    client.setQueryData(historyKey("still-retained"), history(23));
    await maintain();
    expect(client.getQueryData<InfiniteData<Page>>(historyKey("still-retained"))?.pages).toHaveLength(20);

    second();
    await maintain();
    client.setQueryData(historyKey("not-retained"), history(23));
    await maintain();
    expect(client.getQueryData<InfiniteData<Page>>(historyKey("not-retained"))?.pages).toHaveLength(23);
  });

  it("clears previous accounts even when their disabled observers remain mounted", () => {
    client.setQueryData(historyKey("same-chat", "user-a"), history());
    client.setQueryData(latestKey("same-chat", "user-a"), history().pages[0]);
    client.setQueryData(historyKey("same-chat", "user-b"), history());
    client.setQueryData(["unrelated", "user-a"], { kept: true });
    observe(historyKey("same-chat", "user-a"));
    observe(latestKey("same-chat", "user-a"));

    removeOtherAccountsConversationHistory(client, "user-b");
    expect(client.getQueryData(historyKey("same-chat", "user-a"))).toBeUndefined();
    expect(client.getQueryData(latestKey("same-chat", "user-a"))).toBeUndefined();
    expect(client.getQueryData(historyKey("same-chat", "user-b"))).toBeDefined();
    expect(client.getQueryData(["unrelated", "user-a"])).toEqual({ kept: true });

    removeOtherAccountsConversationHistory(client, null);
    expect(client.getQueryData(historyKey("same-chat", "user-b"))).toBeUndefined();
  });

  it("keeps a revisitable history beyond five minutes and collects it after thirty", async () => {
    const key = historyKey("recent-chat");
    const unsubscribe = observe(key);
    client.setQueryData(key, history());
    unsubscribe();

    await vi.advanceTimersByTimeAsync(6 * 60 * 1_000);
    expect(client.getQueryData(key)).toBeDefined();

    await vi.advanceTimersByTimeAsync(CONVERSATION_HISTORY_GC_TIME_MS - 6 * 60 * 1_000);
    expect(client.getQueryData(key)).toBeUndefined();
  });
});
