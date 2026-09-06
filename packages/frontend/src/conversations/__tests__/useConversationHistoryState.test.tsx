// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerConversationMessagesPage } from "../../services/runtimeController/conversations";
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

let latestHistoryState: ReturnType<typeof useConversationHistoryState>;

function Probe({
  conversationId,
  currentUserId,
  localContent,
}: {
  conversationId: string;
  currentUserId: string | null;
  localContent?: string;
}) {
  latestHistoryState = useConversationHistoryState({
    activeConversation: {
      ...createInitialConversation({ localId: `local-${conversationId}` }),
      controllerId: conversationId,
      messages: localContent
        ? [{ id: "local-message", role: "assistant", content: localContent, timestamp: 1 }]
        : [],
    },
    currentUserId,
    runs: {},
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

  async function select(conversationId: string, currentUserId: string | null = "user-1", localContent?: string) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe conversationId={conversationId} currentUserId={currentUserId} localContent={localContent} />
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
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("true");
    expect(queryClient.getQueryData(["conversation-messages", "user-1", "conversation-a"])).toBeUndefined();

    await advance(1_001);

    expect(mocks.listMessages).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("Recovered history");
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(mocks.setConversationControllerId).not.toHaveBeenCalled();
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
    await select("conversation-a");

    expect(container.textContent).toBe("First conversation");
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    await advance(1_001);

    expect(mocks.listMessages).toHaveBeenCalledTimes(4);
    expect(queryClient.getQueryState(["conversation-messages", "user-1", "conversation-a"])?.status).toBe("error");
    expect(queryClient.getQueryData(["conversation-messages", "user-1", "conversation-a"])).toBe(cachedHistory);
    expect(container.textContent).toBe("First conversation");
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    expect(latestHistoryState.initialHistoryError).toBeNull();
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
    expect(queryClient.getQueryState(["conversation-messages", "user-1", "conversation-a"])?.status).toBe("error");
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
    await act(async () => {
      window.dispatchEvent(new Event("instafy:controller-stream-reconnected"));
    });
    await advance(1);

    expect(container.textContent).toBe("");
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
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);

    await select("conversation-a", "user-2");
    await advance(1_001);
    expect(container.textContent).toBe("");
    expect(queryClient.getQueryData(["conversation-messages", "user-2", "conversation-a"])).toBeUndefined();
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
});
