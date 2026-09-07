// @vitest-environment jsdom

import { useLayoutEffect, useRef, type MutableRefObject } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import {
  getConversationScrollAnchorMessageId,
  useChatAutoScrollSync,
  useChatScrollController,
} from "../useChatScrollOrchestration";

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
          View earlier messages
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
}: {
  conversationId: string;
  rows: AnchorRow[];
  scrollHeight: number;
  loading?: boolean;
}) {
  const messages = rows.map(({ id }) => createMessage(id));
  const controller = useChatScrollController({
    activeConversationId: conversationId,
    hasMoreHistory: false,
    isHistoryLoading: false,
    isInitialHistoryLoading: loading,
    loadOlderMessages: () => undefined,
    messages,
  });
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
    <div ref={(node) => {
      controller.scrollContainerRef.current = node;
      if (node) {
        Object.defineProperty(node, "scrollHeight", { get: () => scrollHeight, configurable: true });
        Object.defineProperty(node, "clientHeight", { get: () => 200, configurable: true });
        node.getBoundingClientRect = () => ({ top: 0, bottom: 200, height: 200 } as DOMRect);
      }
    }} data-testid="anchor-scroll">
      <div ref={controller.handleScrollContentRef}>
        {rows.map((row) => (
          <div key={row.id} data-chat-scroll-message-id={row.id} ref={(node) => {
            if (!node) return;
            node.getBoundingClientRect = () => {
              const top = row.top - (controller.scrollContainerRef.current?.scrollTop ?? 0);
              return { top, bottom: top + row.height, height: row.height } as DOMRect;
            };
          }} />
        ))}
      </div>
    </div>
  );
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
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    expect(getConversationScrollAnchorMessageId(conversationId)).toBe("reading");

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
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    await act(async () => root.render(null));
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} loading scrollHeight={200} rows={[]} />));
    await act(async () => { container.querySelector('[data-testid="anchor-scroll"]')?.dispatchEvent(new Event("scroll")); });
    expect(getConversationScrollAnchorMessageId(conversationId)).toBe("reading");
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
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    await act(async () => root.render(null));
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={800} rows={[
      { id: "retained", top: 0, height: 400 }, { id: "new", top: 400, height: 400 },
    ]} />));

    expect((container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement).scrollTop).toBe(0);
    expect(getConversationScrollAnchorMessageId(conversationId)).toBe("retained");
  });

  it("reanchors a visible conversation when its retained range changes and respects subsequent scrolling", async () => {
    const conversationId = "anchor-rebased-history";
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={[
      { id: "removed", top: 0, height: 400 }, { id: "reading", top: 400, height: 400 }, { id: "newest", top: 800, height: 400 },
    ]} />));
    const scroller = container.querySelector('[data-testid="anchor-scroll"]') as HTMLDivElement;
    scroller.scrollTop = 450;
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    const rows = [{ id: "reading", top: 0, height: 400 }, { id: "newest", top: 400, height: 400 }];
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={800} rows={rows} />));
    expect(scroller.scrollTop).toBe(50);
    scroller.scrollTop = 100;
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    rows[0].top = 20;
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(scroller.scrollTop).toBe(100);
  });

  it("continues following the bottom on revisits even when cached history shrank", async () => {
    const conversationId = "anchor-bottom-history";
    await act(async () => root.render(<AnchorHarness conversationId={conversationId} scrollHeight={1200} rows={[
      { id: "old", top: 0, height: 400 }, { id: "new", top: 400, height: 800 },
    ]} />));
    expect(getConversationScrollAnchorMessageId(conversationId)).toBeNull();
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
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });

    await act(async () => root.render(<AnchorHarness conversationId="anchor-switch-b" scrollHeight={1200} rows={rows} />));
    expect(scroller.scrollTop).toBe(1000);
    scroller.scrollTop = 70;
    await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
    await act(async () => root.render(<AnchorHarness conversationId="anchor-switch-a" scrollHeight={1200} rows={rows} />));
    expect(scroller.scrollTop).toBe(430);
    await act(async () => root.render(<AnchorHarness conversationId="anchor-switch-b" scrollHeight={1200} rows={rows} />));
    expect(scroller.scrollTop).toBe(70);
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
        (button) => button.textContent === "View earlier messages",
      ),
    ).toBeDefined();
  });

  it("keeps auto-filling a command-execution-heavy thread while pages still add height", async () => {
    const loadOlderMessages = vi.fn();
    const findLoadButton = () =>
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "View earlier messages",
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
        (button) => button.textContent === "View earlier messages",
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
        (button) => button.textContent === "View earlier messages",
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
