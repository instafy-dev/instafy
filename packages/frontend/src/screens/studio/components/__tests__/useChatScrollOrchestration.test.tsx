// @vitest-environment jsdom

import { useLayoutEffect, useRef, type MutableRefObject } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { useChatScrollController } from "../useChatScrollOrchestration";

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
  hasMoreHistory = true,
  isHistoryLoading = false,
  loadOlderMessages,
  messages,
  scrollHeight,
}: HarnessProps) {
  const metricsRef = useRef({ scrollHeight, clientHeight: 200 });
  metricsRef.current = { scrollHeight, clientHeight: 200 };
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

  it("caps automatic underfill history loading", async () => {
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

    await act(async () => {
      root.render(
        <ScrollHarness
          loadOlderMessages={loadOlderMessages}
          messages={[createMessage("older-1"), createMessage("newest")]}
          scrollHeight={200}
        />,
      );
    });

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

    expect(loadOlderMessages).toHaveBeenCalledTimes(3);
  });

  it("offers the manual history affordance once auto-fill exhausts on a command-execution-heavy thread", async () => {
    const loadOlderMessages = vi.fn();
    const findLoadButton = () =>
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "View earlier messages",
      ) ?? null;

    // An automation thread's pages are dominated by command_execution run
    // updates that collapse to almost no rendered height, so the viewport
    // stays underfilled no matter how many pages auto-fill loads.
    const pages: ChatMessage[][] = [
      [createCommandExecutionMessage("run-4"), createMessage("newest")],
      [createCommandExecutionMessage("run-3")],
      [createCommandExecutionMessage("run-2")],
      [createCommandExecutionMessage("run-1")],
    ];
    let messages: ChatMessage[] = pages[0];

    await act(async () => {
      root.render(
        <ScrollHarness loadOlderMessages={loadOlderMessages} messages={messages} scrollHeight={200} />,
      );
    });
    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
    expect(findLoadButton()).toBeNull();

    for (const page of pages.slice(1)) {
      messages = [...page, ...messages];
      await act(async () => {
        root.render(
          <ScrollHarness loadOlderMessages={loadOlderMessages} messages={messages} scrollHeight={200} />,
        );
      });
    }

    // Auto-fill has spent its page budget, the window is still underfilled and
    // the server still reports more history: the manual button must appear.
    expect(loadOlderMessages).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-testid="history-underfilled"]')?.textContent).toBe("underfilled");
    const loadButton = findLoadButton();
    expect(loadButton).not.toBeNull();

    await act(async () => {
      loadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(loadOlderMessages).toHaveBeenCalledTimes(4);
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
