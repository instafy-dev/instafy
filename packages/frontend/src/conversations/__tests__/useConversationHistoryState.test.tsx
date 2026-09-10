// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerConversationMessagesPage } from "../../services/runtimeController/conversations";
import type { RunRecord } from "../../types";
import type { ConversationHistoryData } from "../conversationHistoryPages";
import { createInitialConversation } from "../conversationState";
import { useConversationHistoryState } from "../useConversationHistoryState";

const mocks = vi.hoisted(() => ({
  listMessages: vi.fn(),
  setConversationControllerId: vi.fn(),
  replaceMessages: vi.fn(),
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    core: { enabled: true },
    conversations: { listMessages: mocks.listMessages },
  },
}));

function historyPage(conversationId: string, content: string): ControllerConversationMessagesPage {
  return {
    messages: [{
      id: `message-${conversationId}`,
      conversationId,
      projectId: "project-1",
      sessionId: null,
      promptId: null,
      runId: null,
      role: "assistant",
      content,
      metadata: null,
      createdAt: "2026-09-05T12:00:00.000Z",
    }],
    nextCursor: null,
    hasMore: false,
  };
}

function historyRange(conversationId: string, newest: number, oldest: number): ControllerConversationMessagesPage {
  return {
    messages: Array.from({ length: newest - oldest + 1 }, (_, index) => {
      const number = newest - index;
      return {
        ...historyPage(conversationId, `${conversationId} message ${number}`).messages[0],
        id: `${conversationId}-${number}`,
        createdAt: new Date(Date.UTC(2026, 8, 5, 12, 0, number)).toISOString(),
      };
    }),
    nextCursor: oldest > 1 ? `${conversationId}-${oldest}` : null,
    hasMore: oldest > 1,
  };
}

function promptRun(conversationId: string, status: RunRecord["status"]): RunRecord {
  return {
    id: `run-${conversationId}`, conversationId, status, runType: "prompt",
    projectId: "project-1", sessionId: null, promptId: null, progress: 0,
    progressStage: null, previewUrl: null, lastMessage: null, metadata: null,
    createdAt: null, updatedAt: null,
  };
}

function deferredPage() {
  let resolve!: (page: ControllerConversationMessagesPage) => void;
  const promise = new Promise<ControllerConversationMessagesPage>((settle) => { resolve = settle; });
  return { promise, resolve };
}

let latestHistoryState: ReturnType<typeof useConversationHistoryState>;

function Probe({
  conversationId,
  controllerId = conversationId,
  currentUserId,
  localContent,
  runs = {},
}: {
  conversationId: string;
  controllerId?: string | null;
  currentUserId: string | null;
  localContent?: string;
  runs?: Record<string, RunRecord>;
}) {
  latestHistoryState = useConversationHistoryState({
    activeConversation: {
      ...createInitialConversation({ localId: `local-${conversationId}` }),
      controllerId,
      messages: localContent
        ? [{ id: "local-message", role: "assistant", content: localContent, timestamp: 1 }]
        : [],
    },
    currentUserId,
    runs,
    setConversationControllerId: mocks.setConversationControllerId,
    replaceMessages: mocks.replaceMessages,
  });
  const { messages, isInitialHistoryLoading, initialHistoryError } = latestHistoryState;
  return (
    <div data-loading={String(isInitialHistoryLoading)} data-error={initialHistoryError ?? undefined}>
      {messages.map((message) => message.content).join("|")}
    </div>
  );
}

describe("useConversationHistoryState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  async function advance(milliseconds: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  }

  async function select(
    conversationId: string,
    currentUserId: string | null = "user-1",
    localContent?: string,
    options: { copies?: number; runs?: Record<string, RunRecord>; controllerId?: string | null } = {},
  ) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          {Array.from({ length: options.copies ?? 1 }, (_, index) => (
            <Probe key={index} conversationId={conversationId} currentUserId={currentUserId}
              controllerId={options.controllerId} localContent={localContent} runs={options.runs} />
          ))}
        </QueryClientProvider>,
      );
    });
    await advance(1);
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    mocks.listMessages.mockReset();
    mocks.setConversationControllerId.mockReset();
    mocks.replaceMessages.mockReset();
    // Match the app's retry policy without shortening its default retry delay.
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("retries an initial transient failure without waiting for the ten-second poll", async () => {
    mocks.listMessages
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(historyPage("conversation-a", "Recovered history"));

    await select("conversation-a");
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);
    expect(latestHistoryState.hasResolvedHistory).toBe(false);
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("true");
    expect(queryClient.getQueryData(["conversation-messages", "user-1", "conversation-a"])).toBeUndefined();

    await advance(1_001);

    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("Recovered history");
    expect(latestHistoryState.hasResolvedHistory).toBe(true);
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(mocks.setConversationControllerId).not.toHaveBeenCalled();
  });

  it("waits for the first controller page even when local and SSE messages are already visible", async () => {
    const firstPage = deferredPage();
    mocks.listMessages.mockImplementation(() => firstPage.promise);

    await select("conversation-a", "user-1", "Local message before history");
    expect(container.textContent).toBe("Local message before history");
    expect(latestHistoryState.latestArrivalMessages.map(message => message.content)).toEqual(["Local message before history"]);
    expect(latestHistoryState.isInitialHistoryLoading).toBe(false);
    expect(latestHistoryState.hasResolvedHistory).toBe(false);

    await select("conversation-a", "user-1", "SSE update before history");
    expect(container.textContent).toBe("SSE update before history");
    expect(latestHistoryState.latestArrivalMessages.map(message => message.content)).toEqual(["SSE update before history"]);
    expect(latestHistoryState.hasResolvedHistory).toBe(false);
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);

    await act(async () => { firstPage.resolve({ messages: [], nextCursor: null, hasMore: false }); });
    await advance(1);
    expect(latestHistoryState.hasResolvedHistory).toBe(true);
    expect(container.textContent).toBe("SSE update before history");
  });

  it("does not resolve a controller-backed conversation before its controller identity is known", async () => {
    await select("conversation-a", "user-1", "Local draft", { controllerId: null });
    expect(container.textContent).toBe("Local draft");
    expect(latestHistoryState.hasResolvedHistory).toBe(false);
    expect(mocks.listMessages).not.toHaveBeenCalled();
  });

  it("keeps equally timestamped older pages out of arrival candidates while accepting a newest-page arrival", async () => {
    const initialMessage = historyPage("conversation-a", "Original newest message").messages[0];
    const olderMessage = { ...initialMessage, id: "older-message", content: "Older pagination row" };
    const arrivedMessage = { ...initialMessage, id: "arrived-message", content: "Newly arrived message" };
    mocks.listMessages
      .mockResolvedValueOnce({ messages: [initialMessage], nextCursor: initialMessage.id, hasMore: true })
      .mockResolvedValueOnce({ messages: [olderMessage], nextCursor: null, hasMore: false })
      .mockResolvedValueOnce({ messages: [arrivedMessage, initialMessage], nextCursor: initialMessage.id, hasMore: true });

    await select("conversation-a");
    expect(latestHistoryState.latestArrivalMessages.map(message => message.id)).toEqual([initialMessage.id]);
    await act(async () => { await latestHistoryState.loadOlderMessages(); });
    await advance(1);
    expect(latestHistoryState.messages.map(message => message.id)).toContain(olderMessage.id);
    expect(latestHistoryState.latestArrivalMessages.map(message => message.id)).toEqual([initialMessage.id]);

    await act(async () => { window.dispatchEvent(new Event("instafy:controller-stream-reconnected")); });
    await advance(1);
    expect(latestHistoryState.messages.map(message => message.id)).toContain(olderMessage.id);
    expect(latestHistoryState.latestArrivalMessages.map(message => message.id)).toEqual([arrivedMessage.id, initialMessage.id]);
    expect(new Set(latestHistoryState.messages.map(message => message.timestamp)).size).toBe(1);
    expect(mocks.listMessages).toHaveBeenCalledTimes(3);
  });

  it("keeps warm history visible when switching back triggers a failed refresh", async () => {
    mocks.listMessages
      .mockResolvedValueOnce(historyPage("conversation-a", "First conversation"))
      .mockResolvedValueOnce(historyPage("conversation-b", "Second conversation"))
      .mockResolvedValue(null);

    await select("conversation-a");
    expect(container.textContent).toBe("First conversation");
    const cachedHistory = queryClient.getQueryData(["conversation-messages", "user-1", "conversation-a"]);
    await select("conversation-b");
    expect(container.textContent).toBe("Second conversation");
    vi.setSystemTime(Date.now() + 11_000);
    await select("conversation-a");

    expect(container.textContent).toBe("First conversation");
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    await advance(1_001);

    expect(mocks.listMessages).toHaveBeenCalledTimes(4);
    expect(queryClient.getQueryState(["conversation-messages-latest", "user-1", "conversation-a"])?.status).toBe("error");
    expect(queryClient.getQueryData(["conversation-messages", "user-1", "conversation-a"])).toBe(cachedHistory);
    expect(container.textContent).toBe("First conversation");
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(latestHistoryState.initialHistoryError).toBeNull();
    expect(latestHistoryState.hasResolvedHistory).toBe(true);
    expect(mocks.setConversationControllerId).not.toHaveBeenCalled();
  });

  it("exposes exhausted cold-history failures and retries immediately on request", async () => {
    mocks.listMessages.mockResolvedValue(null);

    await select("conversation-a");
    expect(latestHistoryState.isInitialHistoryLoading).toBe(true);
    expect(latestHistoryState.initialHistoryError).toBeNull();
    await advance(1_001);

    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
    expect(latestHistoryState.isInitialHistoryLoading).toBe(false);
    expect(latestHistoryState.initialHistoryError).toBe("Couldn't load messages.");
    expect(latestHistoryState.hasResolvedHistory).toBe(false);
    expect(mocks.setConversationControllerId).not.toHaveBeenCalled();

    let resolveRetry!: (page: ControllerConversationMessagesPage) => void;
    mocks.listMessages.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    await act(async () => { void latestHistoryState.retryInitialHistory(); });
    await advance(1);

    expect(mocks.listMessages).toHaveBeenCalledTimes(3);
    expect(latestHistoryState.isInitialHistoryLoading).toBe(true);
    expect(latestHistoryState.initialHistoryError).toBeNull();
    await act(async () => { void latestHistoryState.retryInitialHistory(); });
    expect(mocks.listMessages).toHaveBeenCalledTimes(3);

    await act(async () => { resolveRetry(historyPage("conversation-a", "Restored messages")); });
    await advance(1);

    expect(container.textContent).toBe("Restored messages");
    expect(latestHistoryState.isInitialHistoryLoading).toBe(false);
    expect(latestHistoryState.initialHistoryError).toBeNull();
  });

  it("does not report a failed refresh as an initial failure after an empty page loaded", async () => {
    mocks.listMessages
      .mockResolvedValueOnce({ messages: [], nextCursor: null, hasMore: false })
      .mockResolvedValue(null);
    await select("conversation-a");

    await act(async () => {
      window.dispatchEvent(new Event("instafy:controller-stream-reconnected"));
    });
    await advance(1_001);

    expect(mocks.listMessages).toHaveBeenCalledTimes(3);
    expect(queryClient.getQueryState(["conversation-messages-latest", "user-1", "conversation-a"])?.status).toBe("error");
    expect(latestHistoryState.messages).toEqual([]);
    expect(latestHistoryState.isInitialHistoryLoading).toBe(false);
    expect(latestHistoryState.initialHistoryError).toBeNull();
  });

  it("accepts a genuinely empty page without retrying or detaching the conversation", async () => {
    mocks.listMessages.mockResolvedValue({ messages: [], nextCursor: null, hasMore: false });

    await select("conversation-a");
    await advance(1_001);

    expect(mocks.listMessages).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(["conversation-messages", "user-1", "conversation-a"])?.status).toBe("success");
    expect(latestHistoryState.hasResolvedHistory).toBe(true);
    expect(container.textContent).toBe("");
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(mocks.setConversationControllerId).not.toHaveBeenCalled();
  });

  it("still detaches a conversation explicitly reported as not found", async () => {
    mocks.listMessages.mockResolvedValue("not_found");

    await select("conversation-a");
    await advance(1_001);

    expect(mocks.listMessages).toHaveBeenCalledTimes(1);
    expect(mocks.setConversationControllerId).toHaveBeenCalledWith("local-conversation-a", null);
    expect(latestHistoryState.hasResolvedHistory).toBe(false);
    expect(latestHistoryState.latestArrivalMessages).toEqual([]);
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(latestHistoryState.initialHistoryError).toBeNull();
    await act(async () => { await latestHistoryState.retryInitialHistory(); });
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);
  });

  it("purges warm history and local message copies after an explicit access denial", async () => {
    mocks.listMessages
      .mockResolvedValueOnce(historyPage("conversation-a", "Private server history"))
      .mockResolvedValue("access_denied");

    await select("conversation-a", "user-1", "Private SSE message");
    expect(container.textContent).toContain("Private server history");
    expect(container.textContent).toContain("Private SSE message");
    expect(latestHistoryState.hasResolvedHistory).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event("instafy:controller-stream-reconnected"));
    });
    await advance(1);

    expect(container.textContent).toBe("");
    expect(latestHistoryState.hasResolvedHistory).toBe(false);
    expect(latestHistoryState.latestArrivalMessages).toEqual([]);
    expect(queryClient.getQueryData(["conversation-messages", "user-1", "conversation-a"])).toBeUndefined();
    expect(mocks.replaceMessages).toHaveBeenCalledWith("local-conversation-a", []);
    expect(mocks.setConversationControllerId).toHaveBeenCalledWith("local-conversation-a", null);
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(latestHistoryState.initialHistoryError).toBeNull();
    await act(async () => { await latestHistoryState.retryInitialHistory(); });
    await advance(1_001);
    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a previous user's cached conversation after sign-out and sign-in", async () => {
    mocks.listMessages
      .mockResolvedValueOnce(historyPage("conversation-a", "User one's private history"))
      .mockResolvedValue(null);

    await select("conversation-a");
    expect(container.textContent).toBe("User one's private history");
    await select("conversation-a", null);
    expect(container.textContent).toBe("");
    expect(latestHistoryState.hasResolvedHistory).toBe(false);
    expect(latestHistoryState.latestArrivalMessages).toEqual([]);
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);

    await select("conversation-a", "user-2");
    await advance(1_001);
    expect(container.textContent).toBe("");
    expect(queryClient.getQueryData(["conversation-messages", "user-2", "conversation-a"])).toBeUndefined();
    expect(latestHistoryState.hasResolvedHistory).toBe(false);
    expect(mocks.listMessages).toHaveBeenCalledTimes(3);
  });

  it("keeps an earlier user's late response out of the next user's history", async () => {
    let resolveFirstRequest!: (page: ControllerConversationMessagesPage) => void;
    mocks.listMessages
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstRequest = resolve; }))
      .mockResolvedValue(null);

    await select("conversation-a");
    await select("conversation-a", "user-2");
    await act(async () => {
      resolveFirstRequest(historyPage("conversation-a", "Late private response for user one"));
    });
    await advance(1);

    expect(container.textContent).toBe("");
    expect(queryClient.getQueryData(["conversation-messages", "user-2", "conversation-a"])).toBeUndefined();
    expect(mocks.setConversationControllerId).not.toHaveBeenCalled();
  });

  it("switches between warm conversations without fetching or showing initial loading", async () => {
    mocks.listMessages.mockImplementation(({ conversationId }: { conversationId: string }) =>
      Promise.resolve(historyPage(conversationId, `Saved ${conversationId}`)));
    await select("conversation-a");
    await select("conversation-b");

    for (const conversationId of ["conversation-a", "conversation-b", "conversation-a"]) {
      await select(conversationId);
      expect(container.textContent).toBe(`Saved ${conversationId}`);
      expect(latestHistoryState.isInitialHistoryLoading).toBe(false);
    }

    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
  });

  it("retains a conversation past five inactive minutes while refreshing it in the background on return", async () => {
    mocks.listMessages.mockImplementation(({ conversationId }: { conversationId: string }) =>
      Promise.resolve(historyPage(conversationId, `Saved ${conversationId}`)));
    await select("conversation-a");
    await select("conversation-b");
    const cacheKey = ["conversation-messages", "user-1", "conversation-a"];
    const cachedHistory = queryClient.getQueryData(cacheKey);

    await advance(5 * 60_000 + 1);

    expect(queryClient.getQueryData(cacheKey)).toBe(cachedHistory);
    expect(mocks.listMessages.mock.calls.filter(([request]) => request.conversationId === "conversation-a")).toHaveLength(1);
    const refresh = deferredPage();
    mocks.listMessages.mockImplementationOnce(() => refresh.promise);
    await select("conversation-a");

    expect(container.textContent).toBe("Saved conversation-a");
    expect(latestHistoryState.isInitialHistoryLoading).toBe(false);
    expect(latestHistoryState.initialHistoryError).toBeNull();
    expect(queryClient.getQueryData(cacheKey)).toBe(cachedHistory);
    await act(async () => { refresh.resolve(historyPage("conversation-a", "Updated conversation-a")); });
    await advance(1);
    expect(container.textContent).toBe("Updated conversation-a");
  });

  it("refreshes only the newest page of a multipage history on a stale revisit and poll", async () => {
    mocks.listMessages
      .mockResolvedValueOnce(historyRange("conversation-a", 150, 101))
      .mockResolvedValueOnce(historyRange("conversation-a", 100, 51))
      .mockResolvedValueOnce(historyRange("conversation-a", 50, 1))
      .mockResolvedValueOnce(historyPage("conversation-b", "Other conversation"))
      .mockResolvedValue(historyRange("conversation-a", 151, 102));
    await select("conversation-a");
    await act(async () => { await latestHistoryState.loadOlderMessages(); });
    await advance(1);
    await act(async () => { await latestHistoryState.loadOlderMessages(); });
    await advance(1);
    expect(latestHistoryState.messages).toHaveLength(150);
    await select("conversation-b");
    vi.setSystemTime(Date.now() + 11_000);

    await select("conversation-a");
    await advance(1);

    expect(mocks.listMessages).toHaveBeenCalledTimes(5);
    expect(mocks.listMessages.mock.calls[4]?.[0]).toMatchObject({
      conversationId: "conversation-a", cursor: undefined, limit: 50,
    });
    expect(latestHistoryState.messages).toHaveLength(151);
    expect(latestHistoryState.messages[0]?.id).toBe("conversation-a-1");
    expect(latestHistoryState.messages.at(-1)?.id).toBe("conversation-a-151");
    expect(latestHistoryState.isInitialHistoryLoading).toBe(false);

    await advance(10_001);

    expect(mocks.listMessages).toHaveBeenCalledTimes(6);
    expect(mocks.listMessages.mock.calls[5]?.[0]).toMatchObject({
      conversationId: "conversation-a", cursor: undefined, limit: 50,
    });
    expect(latestHistoryState.messages).toHaveLength(151);
  });

  it("coalesces reconnect refreshes from multiple observers into one pending read", async () => {
    const refresh = deferredPage();
    mocks.listMessages
      .mockResolvedValueOnce(historyPage("conversation-a", "Saved history"))
      .mockImplementation(() => refresh.promise);
    await select("conversation-a", "user-1", undefined, { copies: 5 });
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("instafy:controller-stream-reconnected"));
      window.dispatchEvent(new Event("instafy:controller-stream-reconnected"));
    });
    await advance(1);

    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
    const signal = mocks.listMessages.mock.calls[1]?.[0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => { refresh.resolve(historyPage("conversation-a", "Recovered history")); });
    await advance(1);
    expect(latestHistoryState.messages[0]?.content).toBe("Recovered history");
    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
  });

  it.each(["initial", "older", "latest"])("cancels a pending %s read on selection and ignores its late response", async (stage) => {
    const pending = deferredPage();
    const cacheKey = ["conversation-messages", "user-1", "conversation-a"];
    mocks.listMessages.mockImplementation(({ conversationId }: { conversationId: string }) =>
      Promise.resolve(historyRange(conversationId, 100, 51)));
    if (stage === "initial") {
      mocks.listMessages.mockImplementationOnce(() => pending.promise);
    }
    await select("conversation-a");
    const cachedHistory = queryClient.getQueryData(cacheKey);
    if (stage !== "initial") {
      mocks.listMessages.mockImplementationOnce(() => pending.promise);
      await act(async () => {
        if (stage === "older") void latestHistoryState.loadOlderMessages();
        else window.dispatchEvent(new Event("instafy:controller-stream-reconnected"));
      });
      await advance(1);
    }
    const pendingSignal = mocks.listMessages.mock.calls.at(-1)?.[0].signal as AbortSignal;
    expect(pendingSignal.aborted).toBe(false);
    expect(latestHistoryState.hasResolvedHistory).toBe(stage !== "initial");

    await select("conversation-b");

    expect(pendingSignal.aborted).toBe(true);
    await act(async () => { pending.resolve(historyRange("conversation-a", 200, 151)); });
    await advance(1);
    expect(queryClient.getQueryData(cacheKey)).toBe(cachedHistory);
    expect(latestHistoryState.messages.every((message) => message.id.startsWith("conversation-b-"))).toBe(true);
    expect(container.textContent).not.toContain("conversation-a");
    expect(latestHistoryState.isInitialHistoryLoading).toBe(false);
    expect(latestHistoryState.initialHistoryError).toBeNull();
    if (stage === "initial") {
      expect(queryClient.getQueryData(["conversation-messages-latest", "user-1", "conversation-a"])).toBeUndefined();
    }
    expect(mocks.setConversationControllerId).not.toHaveBeenCalled();
  });

  it("does not refresh merely because completed runs are present on mount or revisit", async () => {
    const runs = { completed: promptRun("conversation-a", "success") };
    mocks.listMessages.mockImplementation(({ conversationId }: { conversationId: string }) =>
      Promise.resolve(historyPage(conversationId, `Saved ${conversationId}`)));

    await select("conversation-a", "user-1", undefined, { runs, copies: 5 });
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);
    await select("conversation-b", "user-1", undefined, { runs, copies: 5 });
    await select("conversation-a", "user-1", undefined, { runs, copies: 5 });

    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
    expect(latestHistoryState.messages[0]?.content).toBe("Saved conversation-a");
  });

  it("does not recreate the companion cache after account cleanup cancels a just-resolved initial page", async () => {
    const pending = deferredPage();
    mocks.listMessages.mockImplementation(() => pending.promise);
    await select("conversation-a");
    const signal = mocks.listMessages.mock.calls[0]?.[0].signal as AbortSignal;

    await act(async () => {
      pending.resolve(historyPage("conversation-a", "Private response from the old account"));
      // fetchPage resumes first; account cleanup then runs before its caller
      // can seed the companion recent-page cache in the following microtask.
      await Promise.resolve();
      queryClient.removeQueries({ predicate: (query) => query.queryKey[1] === "user-1" });
    });
    await advance(1);

    expect(signal.aborted).toBe(true);
    expect(queryClient.getQueryData(["conversation-messages", "user-1", "conversation-a"])).toBeUndefined();
    expect(queryClient.getQueryData(["conversation-messages-latest", "user-1", "conversation-a"])).toBeUndefined();
    expect(container.textContent).not.toContain("Private response");
  });

  it("refreshes once when a live run becomes terminal across multiple observers", async () => {
    const refresh = deferredPage();
    mocks.listMessages
      .mockResolvedValueOnce(historyPage("conversation-a", "Saved history"))
      .mockImplementation(() => refresh.promise);
    await select("conversation-a", "user-1", undefined, {
      copies: 5, runs: { active: promptRun("conversation-a", "in_progress") },
    });
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);

    await select("conversation-a", "user-1", undefined, {
      copies: 5, runs: { active: promptRun("conversation-a", "success") },
    });
    await select("conversation-a", "user-1", undefined, {
      copies: 5, runs: { active: promptRun("conversation-a", "success") },
    });

    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
    expect(mocks.listMessages.mock.calls[1]?.[0].signal.aborted).toBe(false);
    await act(async () => { refresh.resolve(historyPage("conversation-a", "Completed reply")); });
    await advance(1);
    expect(latestHistoryState.messages[0]?.content).toBe("Completed reply");
    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
  });

  it.each(["latest", "older"])("preserves new and older messages when the %s response wins a refresh/pagination race", async (first) => {
    const older = deferredPage();
    const latest = deferredPage();
    mocks.listMessages
      .mockResolvedValueOnce(historyRange("conversation-a", 100, 51))
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => latest.promise);
    await select("conversation-a");
    await act(async () => { void latestHistoryState.loadOlderMessages(); });
    await advance(1);
    await act(async () => {
      window.dispatchEvent(new Event("instafy:controller-stream-reconnected"));
    });
    await advance(1);
    expect(mocks.listMessages).toHaveBeenCalledTimes(3);
    expect(mocks.listMessages.mock.calls[1]?.[0].cursor).toBe("conversation-a-51");
    expect(mocks.listMessages.mock.calls[2]?.[0].cursor).toBeUndefined();

    await act(async () => {
      if (first === "latest") latest.resolve(historyRange("conversation-a", 101, 52));
      else older.resolve(historyRange("conversation-a", 50, 1));
    });
    await advance(1);
    await act(async () => {
      if (first === "latest") older.resolve(historyRange("conversation-a", 50, 1));
      else latest.resolve(historyRange("conversation-a", 101, 52));
    });
    await advance(1);

    expect(latestHistoryState.messages).toHaveLength(101);
    expect(latestHistoryState.messages[0]?.id).toBe("conversation-a-1");
    expect(latestHistoryState.messages.at(-1)?.id).toBe("conversation-a-101");
    expect(latestHistoryState.hasMoreHistory).toBe(false);
    expect(latestHistoryState.isHistoryLoading).toBe(false);
    const cached = queryClient.getQueryData<ConversationHistoryData>([
      "conversation-messages", "user-1", "conversation-a",
    ]);
    expect(new Set(cached?.pages.flatMap((page) => page.messages.map((message) => message.id))).size).toBe(101);
    expect(mocks.listMessages).toHaveBeenCalledTimes(3);
  });
});
