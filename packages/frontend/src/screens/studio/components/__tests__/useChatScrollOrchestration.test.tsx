// @vitest-environment jsdom

import { useLayoutEffect, useRef, type MutableRefObject } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { ChatMessage } from "../../types";
import {
  getConversationScrollAnchorMessageId,
  useChatAutoScrollSync,
  useChatScrollController,
} from "../useChatScrollOrchestration";
import { ChatScrollSnapshotBoundary } from "../ChatScrollSnapshotBoundary";
import { chatScrollSnapshotKey, resolveChatScrollHistoryVisit, type ChatScrollHistoryVisit } from "../chatScrollHistory";

function visit(conversationId: string, key = "test-visit", userId = "test-user", projectId = "test-project"): ChatScrollHistoryVisit {
  return { key, userId, projectId, conversationId };
}

function savedAnchor(conversationId: string): string | null {
  return getConversationScrollAnchorMessageId(chatScrollSnapshotKey(visit(conversationId)));
}

function createMessage(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content: id,
    timestamp: 0,
  };
}

function createCommandExecutionMessage(id: string): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp: 0,
    messageType: "command_execution",
    metadata: { messageType: "command_execution" },
  };
}

type HarnessProps = {
  autoScrollSuspended?: boolean;
  clientHeight?: number;
  hasMoreHistory?: boolean;
  isHistoryLoading?: boolean;
  loadOlderMessages: () => void;
  messages: ChatMessage[];
  scrollHeight: number;
};

function defineScrollMetrics(
  node: HTMLDivElement,
  metricsRef: MutableRefObject<{ scrollHeight: number; clientHeight: number }>,
) {
  Object.defineProperty(node, "scrollHeight", {
    configurable: true,
    get: () => metricsRef.current.scrollHeight,
  });
  Object.defineProperty(node, "clientHeight", {
    configurable: true,
    get: () => metricsRef.current.clientHeight,
  });
}

function ScrollHarness({
  autoScrollSuspended = false,
  clientHeight = 200,
  hasMoreHistory = true,
  isHistoryLoading = false,
  loadOlderMessages,
  messages,
  scrollHeight,
}: HarnessProps) {
  const metricsRef = useRef({ scrollHeight, clientHeight });
  metricsRef.current = { scrollHeight, clientHeight };
  const {
    handleScrollContentRef,
    historyWindowUnderfilled,
    requestOlderMessages,
    scrollContainerRef,
    scrollToBottom,
    setAutoScrollSuspended,
    showHistoryLoadButton,
  } = useChatScrollController({
    activeConversationId: "conv-test",
    historyVisit: visit("conv-test"),
    hasMoreHistory,
    isHistoryLoading,
    loadOlderMessages,
    messages,
  });
  useLayoutEffect(() => {
    setAutoScrollSuspended(autoScrollSuspended);
  }, [autoScrollSuspended, setAutoScrollSuspended]);

  return (
    <div>
      <div
        data-testid="scroll-container"
        ref={(node) => {
          scrollContainerRef.current = node;
          if (node) {
            defineScrollMetrics(node, metricsRef);
          }
        }}
      >
        <div ref={handleScrollContentRef} />
      </div>
      {showHistoryLoadButton ? (
        <button type="button" onClick={requestOlderMessages}>
          Load older messages
        </button>
      ) : null}
      <button type="button" data-testid="scroll-bottom" onClick={() => scrollToBottom()}>
        Scroll to bottom
      </button>
      <span data-testid="history-underfilled">{historyWindowUnderfilled ? "underfilled" : "filled"}</span>
    </div>
  );
}

type AnchorRow = { id: string; top: number; height: number };

function AnchorHarness({
  conversationId,
  rows,
  scrollHeight,
  loading = false,
  historyVisit = visit(conversationId),
  clientHeight = 200,
  mobileAnchor = false,
  scrollPaddingTop = 0,
  hasMoreHistory = false,
  isHistoryLoading = false,
  loadOlderMessages = () => undefined,
  onController,
}: {
  conversationId: string;
  rows: AnchorRow[];
  scrollHeight: number;
  loading?: boolean;
  historyVisit?: ChatScrollHistoryVisit | null;
  clientHeight?: number | (() => number);
  mobileAnchor?: boolean;
  scrollPaddingTop?: number;
  hasMoreHistory?: boolean;
  isHistoryLoading?: boolean;
  loadOlderMessages?: () => void;
  onController?: (controller: ReturnType<typeof useChatScrollController>) => void;
}) {
  const messages = rows.map(({ id }) => createMessage(id));
  const controller = useChatScrollController({
    activeConversationId: conversationId,
    historyVisit,
    hasMoreHistory,
    isHistoryLoading,
    isInitialHistoryLoading: loading,
    loadOlderMessages,
    messages,
  });
  onController?.(controller);
  const wasMobileAnchored = useRef(false);
  useLayoutEffect(() => {
    controller.setAutoScrollSuspended(mobileAnchor);
    if (mobileAnchor) {
      wasMobileAnchored.current = true;
    } else if (wasMobileAnchored.current) {
      wasMobileAnchored.current = false;
      controller.shouldAutoScrollRef.current = true;
      controller.scrollToBottom({ behavior: "auto" });
    }
  }, [mobileAnchor, controller.setAutoScrollSuspended, controller.shouldAutoScrollRef, controller.scrollToBottom]);
  useChatAutoScrollSync({
    ...controller,
    displayedMessages: messages,
    aiOnboardingOpen: false,
    composerAutoHidden: false,
    composerOverlayHeight: 0,
    credentialGateStateForBubble: null,
    isAssistantTyping: false,
    notificationsNudgeAnchorTimestamp: null,
    notificationsNudgeOpen: false,
    peerTypingLabel: null,
  });
  return (
    <ChatScrollSnapshotBoundary identity={JSON.stringify([historyVisit, conversationId])} messages={messages} capture={controller.recordScrollPosition}>
    <div style={{ scrollPaddingTop }} ref={(node) => {
      controller.scrollContainerRef.current = node;
      if (node) {
        Object.defineProperty(node, "scrollHeight", { get: () => scrollHeight, configurable: true });
        const height = () => typeof clientHeight === "function" ? clientHeight() : clientHeight;
        Object.defineProperty(node, "clientHeight", { get: height, configurable: true });
        node.getBoundingClientRect = () => ({ top: 0, bottom: height(), height: height() } as DOMRect);
      }
    }} data-testid="anchor-scroll" data-highlighted-message={controller.highlightedMessageId ?? undefined}>
      <div ref={controller.handleScrollContentRef}>
        {rows.map((row) => (
          <div key={row.id} tabIndex={historyVisit?.messageId === row.id ? -1 : undefined} data-chat-scroll-message-id={row.id} ref={(node) => {
            if (!node) return;
            node.getBoundingClientRect = () => {
              const top = row.top - (controller.scrollContainerRef.current?.scrollTop ?? 0);
              return { top, bottom: top + row.height, height: row.height } as DOMRect;
            };
          }} />
        ))}
      </div>
    </div>
    </ChatScrollSnapshotBoundary>
  );
}

function RouterHistoryHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  const conversationId = new URLSearchParams(location.search).get("conversationId")!;
  const historyVisit = resolveChatScrollHistoryVisit({
    location, userId: "router-user", projectId: "router-project", conversationsProjectKey: "router-project",
    conversationId, conversationControllerId: null,
  });
  return <>
    <button onClick={() => navigate("/studio?projectId=router-project&conversationId=a&panel=chat")}>Visit A</button>
    <button onClick={() => navigate("/studio?projectId=router-project&conversationId=b&panel=chat")}>Visit B</button>
    <button onClick={() => navigate(-1)}>Back</button>
    <button onClick={() => navigate(1)}>Forward</button>
    <AnchorHarness conversationId={conversationId} historyVisit={historyVisit} scrollHeight={1200} rows={[
      { id: `${conversationId}-first`, top: 0, height: 400 },
      { id: `${conversationId}-second`, top: 400, height: 400 },
      { id: `${conversationId}-third`, top: 800, height: 400 },
    ]} />
  </>;
}

describe("useChatScrollController", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resizeCallback: ResizeObserverCallback | null;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resizeCallback = null;
    originalResizeObserver = globalThis.ResizeObserver;

    class MockResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }

    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
    vi.restoreAllMocks();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([0, 48])("reveals the exact target below a %ipx header and clears its highlight without moving it", async (scrollPaddingTop) => {
    vi.useFakeTimers();
    try {
      const historyVisit = { ...visit("target-chat", `target-visit-${scrollPaddingTop}`), messageId: "old-message" };
      await act(async () => root.render(<AnchorHarness conversationId="target-chat" scrollPaddingTop={scrollPaddingTop} historyVisit={historyVisit} loading rows={[]} scrollHeight={200} />));
      const node = () => container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
      expect(node().scrollTop).toBe(0);
      expect(node().dataset.highlightedMessage).toBeUndefined();
      const rows = [{ id: "old-message", top: 600, height: 200 }, { id: "recent", top: 1000, height: 200 }];
      await act(async () => root.render(<AnchorHarness conversationId="target-chat" scrollPaddingTop={scrollPaddingTop} historyVisit={historyVisit} rows={rows} scrollHeight={1400} />));
      expect(node().scrollTop).toBe(576 - scrollPaddingTop);
      expect(node().dataset.highlightedMessage).toBe("old-message");
      await act(async () => vi.advanceTimersByTime(3001));
      expect(node().dataset.highlightedMessage).toBeUndefined();
      expect(node().scrollTop).toBe(576 - scrollPaddingTop);
    } finally { vi.useRealTimers(); }
  });

  it("does not reveal a departed message target when another visit becomes active", async () => {
    const targetVisit = { ...visit("target-leave", "old-target-visit"), messageId: "old-message" };
    await act(async () => root.render(<AnchorHarness conversationId="target-leave" historyVisit={targetVisit} loading rows={[]} scrollHeight={200} />));
    await act(async () => root.render(<AnchorHarness conversationId="other-chat" historyVisit={visit("other-chat", "new-visit")} rows={[
      { id: "other-first", top: 0, height: 300 }, { id: "other-last", top: 900, height: 300 },
    ]} scrollHeight={1200} />));
    const node = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    expect(node.scrollTop).toBe(1000);
    expect(node.dataset.highlightedMessage).toBeUndefined();
  });

  it("preserves the reader's current position when newer history appends at the old bottom", async () => {
    const historyVisit = { ...visit("append-target", "append-target-visit"), messageId: "matched" };
    const rows = [{ id: "first", top: 0, height: 400 }, { id: "matched", top: 400, height: 200 }, { id: "last", top: 600, height: 200 }];
    let controller: ReturnType<typeof useChatScrollController> | null = null;
    const onController = (value: ReturnType<typeof useChatScrollController>) => { controller = value; };
    const render = async (nextRows = rows, scrollHeight = 800, isHistoryLoading = false) => {
      await act(async () => root.render(<AnchorHarness conversationId="append-target" historyVisit={historyVisit}
        rows={nextRows} scrollHeight={scrollHeight} isHistoryLoading={isHistoryLoading} onController={onController} />));
    };
    await render();
    const node = container.querySelector<HTMLDivElement>('[data-testid="anchor-scroll"]')!;
    node.scrollTop = 600;
    await act(async () => node.dispatchEvent(new Event("scroll")));
    await render(rows, 800, true);
    // The reader moves back while the network request is pending. No scroll
    // event is needed: the snapshot boundary reads the position before commit.
    node.scrollTop = 520;
    await render([...rows, { id: "newer", top: 800, height: 500 }], 1300);
    expect(node.scrollTop).toBe(520);
    expect(node.querySelector('[data-chat-scroll-message-id="matched"]')!.getBoundingClientRect().top).toBe(-120);
    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver);
      controller!.shouldAutoScrollRef.current = true;
      controller!.scrollToBottom();
    });
    expect(node.scrollTop).toBe(520);
    expect(controller!.isHistoryReadingReady()).toBe(true);
  });

  it("does not reinterpret a newer append as prepend settling after loading older history", async () => {
    const historyVisit = { ...visit("both-directions", "both-directions-visit"), messageId: "matched" };
    const originalRows = [{ id: "matched", top: 0, height: 300 }, { id: "later", top: 300, height: 300 }];
    const loadOlder = vi.fn();
    let controller: ReturnType<typeof useChatScrollController> | null = null;
    const onController = (value: ReturnType<typeof useChatScrollController>) => { controller = value; };
    const render = async (rows: AnchorRow[], scrollHeight: number, isHistoryLoading = false) => {
      await act(async () => root.render(<AnchorHarness conversationId="both-directions" historyVisit={historyVisit}
        rows={rows} scrollHeight={scrollHeight} hasMoreHistory isHistoryLoading={isHistoryLoading}
        loadOlderMessages={loadOlder} onController={onController} />));
    };
    await render(originalRows, 600);
    const node = container.querySelector<HTMLDivElement>('[data-testid="anchor-scroll"]')!;
    node.scrollTop = 100;
    await act(async () => controller!.requestOlderMessages());
    expect(loadOlder).toHaveBeenCalledOnce();
    await render(originalRows, 600, true);
    const olderRows = [{ id: "older", top: 0, height: 400 }, ...originalRows.map(row => ({ ...row, top: row.top + 400 }))];
    await render(olderRows, 1000);
    expect(node.scrollTop).toBe(500);
    // Append before the older-page settle timeout expires; the message under
    // the reader stays put instead of receiving another full-height delta.
    await render([...olderRows, { id: "newer", top: 1000, height: 500 }], 1500);
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(node.scrollTop).toBe(500);
  });

  it("focuses the revealed target without scrolling again after its search result unmounts", async () => {
    const historyVisit = { ...visit("focus-target", "focus-visit"), messageId: "matched" };
    await act(async () => root.render(<>
      <button type="button" data-testid="search-result">Open matched message</button>
      <AnchorHarness conversationId="focus-target" historyVisit={historyVisit} loading rows={[]} scrollHeight={200} />
    </>));
    (container.querySelector('[data-testid="search-result"]') as HTMLButtonElement).focus();
    await act(async () => root.render(<>
      {null}
      <AnchorHarness conversationId="focus-target" historyVisit={historyVisit} loading rows={[]} scrollHeight={200} />
    </>));
    expect(document.activeElement).toBe(document.body);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await act(async () => root.render(<>
      {null}
      <AnchorHarness conversationId="focus-target" historyVisit={historyVisit} rows={[
        { id: "before", top: 0, height: 600 }, { id: "matched", top: 600, height: 200 }, { id: "after", top: 800, height: 600 },
      ]} scrollHeight={1400} />
    </>));
    const target = container.querySelector('[data-chat-scroll-message-id="matched"]');
    expect(document.activeElement).toBe(target);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect((container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement).scrollTop).toBe(576);
  });

  it.each(["textarea", "button"] as const)("preserves a %s focused while the exact message is loading", async (tag) => {
    const control = document.createElement(tag);
    document.body.appendChild(control);
    try {
      const historyVisit = { ...visit(`focused-${tag}`, `focus-${tag}-visit`), messageId: "matched" };
      await act(async () => root.render(<AnchorHarness conversationId={`focused-${tag}`} historyVisit={historyVisit} loading rows={[]} scrollHeight={200} />));
      control.focus();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      await act(async () => root.render(<AnchorHarness conversationId={`focused-${tag}`} historyVisit={historyVisit} rows={[
        { id: "before", top: 0, height: 600 }, { id: "matched", top: 600, height: 200 }, { id: "after", top: 800, height: 600 },
      ]} scrollHeight={1400} />));
      expect(document.activeElement).toBe(control);
      expect(focus).not.toHaveBeenCalled();
      const node = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
      expect(node.scrollTop).toBe(576);
      expect(node.dataset.highlightedMessage).toBe("matched");
    } finally {
      control.remove();
    }
  });

  it("restores a previously revealed message visit after mobile onboarding releases its loading placeholder", async () => {
    const conversationId = "mobile-return-target";
    const historyVisit = { ...visit(conversationId), messageId: "matched" };
    const rows = [{ id: "older", top: 0, height: 400 }, { id: "matched", top: 400, height: 400 }, { id: "later", top: 800, height: 400 }];
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} historyVisit={historyVisit} rows={rows} scrollHeight={1200} />));
    const scroller = container.querySelector<HTMLDivElement>('[data-testid="anchor-scroll"]')!;
    scroller.scrollTop = 520;
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    await act(async () => root.render(null));

    await act(async () => root.render(<AnchorHarness conversationId={conversationId} historyVisit={historyVisit} mobileAnchor loading rows={[]} scrollHeight={200} />));
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} historyVisit={historyVisit} rows={rows} scrollHeight={1200} />));
    const restored = container.querySelector<HTMLDivElement>('[data-testid="anchor-scroll"]')!;
    expect(restored.scrollTop).toBe(520);
    expect(restored.dataset.highlightedMessage).toBeUndefined();
  });

  it("does not let mobile onboarding release capture placeholder bottom geometry before a cross-space target loads", async () => {
    const historyVisit = { ...visit("mobile-target", "mobile-target-visit", "user", "next-space"), messageId: "matched" };
    await act(async () => root.render(<AnchorHarness conversationId="previous-chat" historyVisit={null} mobileAnchor loading rows={[]} scrollHeight={200} />));
    await act(async () => root.render(<AnchorHarness conversationId="mobile-target" historyVisit={historyVisit} mobileAnchor loading rows={[]} scrollHeight={200} />));
    // The old mobile getting-started surface releases its top anchor while
    // the new conversation's around-message request is still pending.
    await act(async () => root.render(<AnchorHarness conversationId="mobile-target" historyVisit={historyVisit} loading rows={[]} scrollHeight={200} />));
    await act(async () => root.render(<AnchorHarness conversationId="mobile-target" historyVisit={historyVisit} rows={[
      { id: "before", top: 0, height: 600 }, { id: "matched", top: 600, height: 200 }, { id: "after", top: 800, height: 600 },
    ]} scrollHeight={1400} />));
    const node = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    expect(node.scrollTop).toBe(576);
    expect(node.dataset.highlightedMessage).toBe("matched");
  });

  it("auto-loads older history while the loaded transcript underfills the viewport", async () => {
    const loadOlderMessages = vi.fn();

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newest")]}
          scrollHeight={200}
        />,
      );
    });

    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="history-underfilled"]')?.textContent).toBe("underfilled");

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older-1"), createMessage("newest")]}
          scrollHeight={200}
        />,
      );
    });

    expect(loadOlderMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older-2"), createMessage("older-1"), createMessage("newest")]}
          scrollHeight={500}
        />,
      );
    });

    expect(loadOlderMessages).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="history-underfilled"]')?.textContent).toBe("filled");
  });

  it("restores the visible message after older cached rows are trimmed on a tab revisit", async () => {
    const conversationId = "anchor-trimmed-history";
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={[
      { id: "oldest", top: 0, height: 400 },
      { id: "reading", top: 400, height: 400 },
      { id: "newest", top: 800, height: 400 },
    ]} />));
    const scroller = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    scroller.scrollTop = 450;
    scroller.dispatchEvent(new Event("scroll"));
    expect(savedAnchor(conversationId)).toBe("reading");

    await act(async () => root.render(null));
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={800} rows={[
      { id: "reading", top: 0, height: 400 },
      { id: "newest", top: 400, height: 400 },
    ]} />));

    expect((container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement).scrollTop).toBe(50);
  });

  it("keeps the reading anchor through a loading placeholder and later row measurement", async () => {
    const conversationId = "anchor-loading-history";
    const rows = [{ id: "older", top: 0, height: 400 }, { id: "reading", top: 400, height: 400 }, { id: "later", top: 800, height: 400 }];
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={rows} />));
    const scroller = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    scroller.scrollTop = 430;
    scroller.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(null));
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} loading scrollHeight={200} rows={[]} />));
    container.querySelector('[data-testid="anchor-scroll"]')?.dispatchEvent(new Event("scroll"));
    expect(savedAnchor(conversationId)).toBe("reading");
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={rows} />));
    const restored = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    expect(restored.scrollTop).toBe(430);

    rows[0].height = 450;
    rows[1].top = 450;
    rows[2].top = 850;
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(restored.scrollTop).toBe(480);
  });

  it("starts at the oldest retained row when the saved anchor was evicted", async () => {
    const conversationId = "anchor-evicted-history";
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={[
      { id: "evicted", top: 0, height: 800 }, { id: "retained", top: 800, height: 400 },
    ]} />));
    const scroller = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    scroller.scrollTop = 300;
    scroller.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(null));
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={800} rows={[
      { id: "retained", top: 0, height: 400 }, { id: "new", top: 400, height: 400 },
    ]} />));

    expect((container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement).scrollTop).toBe(0);
    expect(savedAnchor(conversationId)).toBe("retained");
  });

  it("reanchors a visible conversation when its retained range changes and respects subsequent scrolling", async () => {
    const conversationId = "anchor-rebased-history";
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={[
      { id: "removed", top: 0, height: 400 }, { id: "reading", top: 400, height: 400 }, { id: "newest", top: 800, height: 400 },
    ]} />));
    const scroller = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    scroller.scrollTop = 450;
    scroller.dispatchEvent(new Event("scroll"));
    const rows = [{ id: "reading", top: 0, height: 400 }, { id: "newest", top: 400, height: 400 }];
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={800} rows={rows} />));
    expect(scroller.scrollTop).toBe(50);
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event("scroll"));
    rows[0].top = 20;
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(scroller.scrollTop).toBe(100);
  });

  it("continues following the bottom on revisits even when cached history shrank", async () => {
    const conversationId = "anchor-bottom-history";
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={[
      { id: "old", top: 0, height: 400 }, { id: "new", top: 400, height: 800 },
    ]} />));
    expect(savedAnchor(conversationId)).toBeNull();
    await act(async () => root.render(null));
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={800} rows={[
      { id: "new", top: 0, height: 800 },
    ]} />));
    expect((container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement).scrollTop).toBe(600);
  });

  it("keeps separate message anchors when conversations switch within the same mounted panel", async () => {
    const rows = [{ id: "first", top: 0, height: 400 }, { id: "second", top: 400, height: 400 }, { id: "third", top: 800, height: 400 }];
    await act(async () => root.render(<AnchorHarness conversationId="anchor-switch-a" scrollHeight={1200} rows={rows} />));
    const scroller = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    scroller.scrollTop = 430;
    scroller.dispatchEvent(new Event("scroll"));

    await act(async () => root.render(<AnchorHarness conversationId="anchor-switch-b" scrollHeight={1200} rows={rows} />));
    expect(scroller.scrollTop).toBe(1000);
    scroller.scrollTop = 70;
    scroller.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(<AnchorHarness conversationId="anchor-switch-a" scrollHeight={1200} rows={rows} />));
    expect(scroller.scrollTop).toBe(430);
    await act(async () => root.render(<AnchorHarness conversationId="anchor-switch-b" scrollHeight={1200} rows={rows} />));
    expect(scroller.scrollTop).toBe(70);
  });

  it("restores each A → B → A history visit independently on Back and Forward", async () => {
    await act(async () => root.render(<MemoryRouter initialEntries={["/studio?projectId=router-project&conversationId=a&panel=chat"]}>
      <RouterHistoryHarness />
    </MemoryRouter>));
    const scroller = () => container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    const navigate = async (label: string) => {
      await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === label)!.click());
    };
    // No scroll event or interval gets a chance to run: the boundary must read
    // A's rows before the synchronous navigation replaces them with B's rows.
    scroller().scrollTop = 430;
    await navigate("Visit B");
    expect(scroller().scrollTop).toBe(1000);
    scroller().scrollTop = 70;
    await navigate("Visit A");
    expect(scroller().scrollTop).toBe(1000);
    scroller().scrollTop = 850;
    await navigate("Back");
    expect(scroller().scrollTop).toBe(70);
    await navigate("Back");
    expect(scroller().scrollTop).toBe(430);
    await navigate("Forward");
    expect(scroller().scrollTop).toBe(70);
    await navigate("Forward");
    expect(scroller().scrollTop).toBe(850);
  });

  it.each(["route-first", "transcript-first"])("does not assign stale transcript geometry during %s hydration", async (order) => {
    const a = visit(`hydrate-a-${order}`, "entry-a");
    const b = visit(`hydrate-b-${order}`, "entry-b");
    const rows = (id: string) => [
      { id: `${id}-first`, top: 0, height: 400 },
      { id: `${id}-reading`, top: 400, height: 400 },
      { id: `${id}-last`, top: 800, height: 400 },
    ];
    const render = async (rendered: ChatScrollHistoryVisit, requested: ChatScrollHistoryVisit) => {
      await act(async () => root.render(<AnchorHarness conversationId={rendered.conversationId} historyVisit={requested}
        scrollHeight={1200} rows={rows(rendered.conversationId)} />));
    };
    await render(a, a);
    const scroller = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    scroller.scrollTop = 435;
    await render(order === "route-first" ? a : b, order === "route-first" ? b : a);
    scroller.scrollTop = 25;
    scroller.dispatchEvent(new Event("scroll"));
    expect(getConversationScrollAnchorMessageId(chatScrollSnapshotKey(b))).toBeNull();
    await render(b, b);
    expect(scroller.scrollTop).toBe(1000);
    await render(a, a);
    expect(scroller.scrollTop).toBe(435);
  });

  it("captures the outgoing visit before unmount even without a scroll event", async () => {
    const conversationId = "history-unmount";
    const rows = [{ id: "unmount-old", top: 0, height: 400 }, { id: "unmount-reading", top: 400, height: 800 }];
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={rows} />));
    (container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement).scrollTop = 455;
    await act(async () => root.render(null));
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={rows} />));
    expect((container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement).scrollTop).toBe(455);
  });

  it("isolates equal history and conversation IDs across authenticated users, projects and job views", async () => {
    const a = visit("scope-chat", "shared-key", "user-a", "project-a");
    const b = { ...a, userId: "user-b" };
    const c = { ...a, projectId: "project-b" };
    const d = { ...a, jobId: "job-a" };
    const rows = [{ id: "scope-first", top: 0, height: 400 }, { id: "scope-reading", top: 400, height: 800 }];
    const render = async (historyVisit: ChatScrollHistoryVisit) => {
      await act(async () => root.render(<AnchorHarness conversationId="scope-chat" historyVisit={historyVisit} scrollHeight={1200} rows={rows} />));
    };
    await render(a);
    const scroller = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    scroller.scrollTop = 435;
    for (const other of [b, c, d]) {
      await render(other);
      expect(scroller.scrollTop).toBe(1000);
      scroller.scrollTop = 85;
      await render(a);
      expect(scroller.scrollTop).toBe(435);
    }
  });

  it("waits for a visible layout before restoring an exact visit", async () => {
    const conversationId = "history-hidden";
    const rows = [{ id: "hidden-first", top: 0, height: 400 }, { id: "hidden-last", top: 400, height: 800 }];
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={rows} />));
    const scroller = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    scroller.scrollTop = 445;
    await act(async () => root.render(null));
    let height = 0;
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} clientHeight={() => height} scrollHeight={1200} rows={rows} />));
    const hidden = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    expect(hidden.scrollTop).toBe(0);
    hidden.dispatchEvent(new Event("scroll"));
    height = 200;
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(hidden.scrollTop).toBe(445);
  });

  it("stops automatic underfill loading after two consecutive pages add no height", async () => {
    const loadOlderMessages = vi.fn();

    // Every page leaves the rendered content exactly as tall as it was, so the
    // second page in a row that fails to make progress ends the auto-fill loop.
    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newest")]}
          scrollHeight={200}
        />,
      );
    });
    expect(loadOlderMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older-1"), createMessage("newest")]}
          scrollHeight={200}
        />,
      );
    });
    // One stalled page is not enough to give up.
    expect(loadOlderMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older-2"), createMessage("older-1"), createMessage("newest")]}
          scrollHeight={200}
        />,
      );
    });

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[
            createMessage("older-3"),
            createMessage("older-2"),
            createMessage("older-1"),
            createMessage("newest"),
          ]}
          scrollHeight={200}
        />,
      );
    });

    expect(loadOlderMessages).toHaveBeenCalledTimes(2);
    expect(
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Load older messages",
      ),
    ).toBeDefined();
  });

  it("keeps auto-filling a command-execution-heavy thread while pages still add height", async () => {
    const loadOlderMessages = vi.fn();
    const findLoadButton = () =>
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Load older messages",
      ) ?? null;

    // An automation thread's pages are dominated by command_execution run
    // updates that collapse to a sliver of rendered height each. They do make
    // progress, just slowly, so auto-fill has to keep going well past the three
    // pages the old page-count cap allowed — and only stop once the growth does.
    const growingHeights = [120, 150, 180, 210, 240, 270, 300];
    const stalledHeights = [300, 300];
    let messages: ChatMessage[] = [createMessage("newest")];

    for (const [index, scrollHeight] of growingHeights.entries()) {
      if (index > 0) {
        messages = [createCommandExecutionMessage(`run-${index}`), ...messages];
      }
      await act(async () => {
        root.render(
          <ScrollHarness
            clientHeight={800}
            loadOlderMessages={loadOlderMessages}
            messages={messages}
            scrollHeight={scrollHeight}
          />,
        );
      });
      // Each page grew the content, so auto-fill asked for the next one.
      expect(loadOlderMessages).toHaveBeenCalledTimes(index + 1);
      expect(findLoadButton()).toBeNull();
    }

    for (const [index, scrollHeight] of stalledHeights.entries()) {
      messages = [
        createCommandExecutionMessage(`stalled-${index}`),
        ...messages,
      ];
      await act(async () => {
        root.render(
          <ScrollHarness
            clientHeight={800}
            loadOlderMessages={loadOlderMessages}
            messages={messages}
            scrollHeight={scrollHeight}
          />,
        );
      });
    }

    // Growth stopped for two pages running, the window is still underfilled and
    // the server still reports more history: the manual button must appear.
    expect(loadOlderMessages).toHaveBeenCalledTimes(growingHeights.length + 1);
    expect(container.querySelector('[data-testid="history-underfilled"]')?.textContent).toBe("underfilled");
    const loadButton = findLoadButton();
    expect(loadButton).not.toBeNull();

    await act(async () => {
      loadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(loadOlderMessages).toHaveBeenCalledTimes(growingHeights.length + 2);
  });

  it("bounds auto-fill with an absolute page cap when every page keeps inching forward", async () => {
    const loadOlderMessages = vi.fn();

    // A pathological thread whose pages each add just enough height to count as
    // progress must still not page itself in forever: the safety cap stops the
    // loop at fifteen pages and hands over to the manual button.
    let messages: ChatMessage[] = [createMessage("newest")];
    for (let index = 0; index < 20; index += 1) {
      if (index > 0) {
        messages = [createCommandExecutionMessage(`run-${index}`), ...messages];
      }
      const scrollHeight = 100 + index * 20;
      await act(async () => {
        root.render(
          <ScrollHarness
            clientHeight={5000}
            loadOlderMessages={loadOlderMessages}
            messages={messages}
            scrollHeight={scrollHeight}
          />,
        );
      });
    }

    expect(loadOlderMessages).toHaveBeenCalledTimes(15);
    expect(container.querySelector('[data-testid="history-underfilled"]')?.textContent).toBe("underfilled");
    expect(
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Load older messages",
      ),
    ).toBeDefined();
  });

  it("hides the manual history affordance while a filled window has no more history", async () => {
    const loadOlderMessages = vi.fn();

    await act(async () => {
      root.render(
        <ScrollHarness
          hasMoreHistory={false}
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newest")]}
          scrollHeight={500}
        />,
      );
    });

    expect(loadOlderMessages).not.toHaveBeenCalled();
    expect(
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Load older messages",
      ),
    ).toBeUndefined();
  });

  it("keeps automatic bottom scrolling suspended through late content growth", async () => {
    const loadOlderMessages = vi.fn();

    await act(async () => {
      root.render(
        <ScrollHarness
          autoScrollSuspended
          hasMoreHistory={false}
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newest")]}
          scrollHeight={220}
        />,
      );
    });

    const scrollContainer = container.querySelector('[data-testid="scroll-container"]') as HTMLDivElement;
    scrollContainer.scrollTop = 0;

    await act(async () => {
      root.render(
        <ScrollHarness
          autoScrollSuspended
          hasMoreHistory={false}
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newest")]}
          scrollHeight={500}
        />,
      );
      resizeCallback?.([], {} as ResizeObserver);
      await Promise.resolve();
    });

    expect(scrollContainer.scrollTop).toBe(0);

    await act(async () => {
      container
        .querySelector('[data-testid="scroll-bottom"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(scrollContainer.scrollTop).toBe(0);

    await act(async () => {
      root.render(
        <ScrollHarness
          autoScrollSuspended={false}
          hasMoreHistory={false}
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newest")]}
          scrollHeight={500}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector('[data-testid="scroll-bottom"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(scrollContainer.scrollTop).toBe(300);
  });

  it("keeps the same viewport anchored when older history causes late layout growth", async () => {
    const loadOlderMessages = vi.fn();

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newer")]}
          scrollHeight={500}
        />,
      );
    });

    const scrollContainer = container.querySelector('[data-testid="scroll-container"]') as HTMLDivElement;
    scrollContainer.scrollTop = 120;

    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(loadOlderMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older"), createMessage("newer")]}
          scrollHeight={700}
        />,
      );
    });
    expect(scrollContainer.scrollTop).toBe(320);

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older"), createMessage("newer")]}
          scrollHeight={760}
        />,
      );
    });
    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver);
      await Promise.resolve();
    });

    expect(scrollContainer.scrollTop).toBe(380);
  });

  it("keeps the user's live position when they scroll while an older page is in flight", async () => {
    const loadOlderMessages = vi.fn();

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newer")]}
          scrollHeight={500}
        />,
      );
    });

    const scrollContainer = container.querySelector('[data-testid="scroll-container"]') as HTMLDivElement;
    // The scroll handler asks for the next page as soon as the user crosses the
    // top threshold, so the request fires at 40px...
    scrollContainer.scrollTop = 40;

    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(loadOlderMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <ScrollHarness
          isHistoryLoading
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newer")]}
          scrollHeight={500}
        />,
      );
    });

    // ...but trackpad momentum keeps carrying the user to the very top while
    // the page is loading.
    scrollContainer.scrollTop = 0;

    await act(async () => {
      root.render(
        <ScrollHarness
          isHistoryLoading={false}
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older"), createMessage("newer")]}
          scrollHeight={1248}
        />,
      );
    });

    // The prepend must offset where the user actually is (0 + 748), not snap
    // them back to where they were when the request went out (40 + 748).
    expect(scrollContainer.scrollTop).toBe(748);
  });

  it("does not fight the user if they scroll after older history loads", async () => {
    const loadOlderMessages = vi.fn();

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("newer")]}
          scrollHeight={500}
        />,
      );
    });

    const scrollContainer = container.querySelector('[data-testid="scroll-container"]') as HTMLDivElement;
    scrollContainer.scrollTop = 120;

    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older"), createMessage("newer")]}
          scrollHeight={700}
        />,
      );
    });
    expect(scrollContainer.scrollTop).toBe(320);

    scrollContainer.scrollTop = 300;

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older"), createMessage("newer")]}
          scrollHeight={760}
        />,
      );
    });
    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver);
      await Promise.resolve();
    });

    expect(scrollContainer.scrollTop).toBe(300);
  });
});
