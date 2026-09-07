// @vitest-environment jsdom

import { act, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { useChatAutoScrollSync, useChatScrollController } from "../useChatScrollOrchestration";
import { collapseLifecycleMessages, shouldDisplayChatMessage } from "../chatMessagePresentation";

const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 200;

function message(id: string, content = id, timestamp = 1): ChatMessage {
  return { id, content, timestamp, role: "assistant" };
}

function history(prefix: string, count = 12): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => message(`${prefix}-${index}`, `Message ${index}`, index));
}

type HarnessProps = {
  conversationId: string;
  messages: ChatMessage[];
  initialLoading?: boolean;
  historyLoading?: boolean;
  loadOlderMessages?: () => Promise<unknown>;
  clientHeight?: number;
  trailingPreview?: ChatMessage;
};

// Both real hooks see the same geometry as the DOM. A real scroll event is
// the only way tests stop following; they never write to the hook's refs.
function Harness({
  conversationId,
  messages,
  initialLoading = false,
  historyLoading = false,
  loadOlderMessages,
  clientHeight = VIEWPORT_HEIGHT,
  trailingPreview,
}: HarnessProps) {
  const displayedMessages = useMemo(
    () => [...collapseLifecycleMessages(messages).filter(shouldDisplayChatMessage), ...(trailingPreview ? [trailingPreview] : [])],
    [messages, trailingPreview],
  );
  const metrics = useRef({ scrollHeight: displayedMessages.length * ROW_HEIGHT, clientHeight });
  metrics.current = { scrollHeight: displayedMessages.length * ROW_HEIGHT, clientHeight };
  const controller = useChatScrollController({
    activeConversationId: conversationId,
    messages,
    displayedMessages,
    isInitialHistoryLoading: initialLoading,
    isHistoryLoading: historyLoading,
    hasMoreHistory: Boolean(loadOlderMessages),
    loadOlderMessages: loadOlderMessages ?? (() => undefined),
  });
  useChatAutoScrollSync({
    ...controller,
    displayedMessages,
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
    <>
      <div data-testid="scroll" ref={(node) => {
        controller.scrollContainerRef.current = node;
        if (!node) return;
        Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => metrics.current.scrollHeight });
        Object.defineProperty(node, "clientHeight", { configurable: true, get: () => metrics.current.clientHeight });
        node.getBoundingClientRect = () => ({ top: 0, bottom: metrics.current.clientHeight, height: metrics.current.clientHeight } as DOMRect);
      }}>
        <div ref={controller.handleScrollContentRef}>
          {displayedMessages.map((entry, index) => (
            <div key={entry.id} data-chat-scroll-message-id={entry.id} ref={(node) => {
              if (!node) return;
              node.getBoundingClientRect = () => {
                const top = index * ROW_HEIGHT - (controller.scrollContainerRef.current?.scrollTop ?? 0);
                return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT } as DOMRect;
              };
            }}>{entry.content}</div>
          ))}
        </div>
      </div>
      {controller.showJumpToLatest ? (
        <button data-testid="jump" onClick={controller.jumpToLatest}>
          {controller.hasNewMessages ? "New messages" : "Jump to latest"}
        </button>
      ) : null}
      <button data-testid="older" onClick={controller.requestOlderMessages}>Older</button>
    </>
  );
}

describe("chat latest-message indicator", () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: Map<number, FrameRequestCallback>;
  let observers: Set<ResizeObserverCallback>;
  let nextFrameId: number;
  let conversationNumber = 0;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    frames = new Map();
    observers = new Set();
    nextFrameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) { observers.add(callback); }
      observe() { /* Delivery is explicit, after the DOM commit. */ }
      unobserve() { /* The controller disconnects its one observed node. */ }
      disconnect() { observers.delete(this.callback); }
    });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    expect(frames.size).toBe(0);
    expect(observers.size).toBe(0);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function scope(): string { return `latest-indicator-${++conversationNumber}`; }
  function scroller(): HTMLDivElement { return container.querySelector('[data-testid="scroll"]')!; }
  function indicator(): string | null { return container.querySelector('[data-testid="jump"]')?.textContent ?? null; }
  function visibleAnchor() {
    const row = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-scroll-message-id]"))
      .find((node) => node.getBoundingClientRect().bottom > 0);
    return { id: row?.dataset.chatScrollMessageId, offset: row?.getBoundingClientRect().top };
  }
  async function flushResize() {
    await act(async () => {
      for (const observer of observers) observer([], {} as ResizeObserver);
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(performance.now());
    });
  }
  async function render(props: HarnessProps) {
    await act(async () => { root.render(<Harness {...props} />); });
    await flushResize();
  }
  async function scroll(top: number) {
    await act(async () => {
      scroller().scrollTop = top;
      scroller().dispatchEvent(new Event("scroll"));
    });
  }
  async function click(testId: string) {
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(); });
  }

  it("preserves the visible message and offset on arrivals while up, then jumps and follows", async () => {
    const conversationId = scope();
    let messages = history(conversationId);
    await render({ conversationId, messages });
    expect(scroller().scrollTop).toBe(1000);
    expect(indicator()).toBeNull();
    await scroll(430);
    const anchor = visibleAnchor();
    expect(indicator()).toBe("Jump to latest");

    messages = [...messages, message("incoming", "A new reply", 20)];
    await render({ conversationId, messages });
    expect(scroller().scrollTop).toBe(430);
    expect(visibleAnchor()).toEqual(anchor);
    expect(indicator()).toBe("New messages");

    await click("jump");
    expect(scroller().scrollTop).toBe(1100);
    expect(indicator()).toBeNull();
    await render({ conversationId, messages: [...messages, message("following", "Next reply", 21)] });
    expect(scroller().scrollTop).toBe(1200);
    expect(indicator()).toBeNull();
  });

  it("follows arrivals at the bottom and clears the notice when manually returning", async () => {
    const conversationId = scope();
    let messages = history(conversationId);
    await render({ conversationId, messages });
    messages = [...messages, message("at-bottom", "Reply", 20)];
    await render({ conversationId, messages });
    expect(scroller().scrollTop).toBe(1100);
    expect(indicator()).toBeNull();

    await scroll(430);
    messages = [...messages, message("while-away", "Reply", 21)];
    await render({ conversationId, messages });
    expect(indicator()).toBe("New messages");
    await scroll(1200);
    expect(indicator()).toBeNull();
    await scroll(430);
    expect(indicator()).toBe("Jump to latest");
  });

  it("notices streaming text even with a newer activity row, and ignores activity alone", async () => {
    const conversationId = scope();
    const messages = history(conversationId);
    await render({ conversationId, messages });
    await scroll(430);
    const activity: ChatMessage = { ...message("activity", "", 20), messageType: "command_execution", metadata: { messageType: "command_execution" } };
    await render({ conversationId, messages: [...messages, activity] });
    expect(indicator()).toBe("Jump to latest");
    const streamed = messages.map((entry, index) => index === messages.length - 1 ? { ...entry, content: `${entry.content} more text` } : entry);
    await render({ conversationId, messages: [...streamed, activity] });
    expect(scroller().scrollTop).toBe(430);
    expect(indicator()).toBe("New messages");
  });

  it.each([
    { messageType: "status" },
    { metadata: { presentation: { hidden: true } } },
    { metadata: { multiAgentPlan: { role: "worker", parentJobId: "plan-job" } } },
  ] satisfies Partial<ChatMessage>[])("ignores hidden rows %j without masking a visible reply's streaming text", async (hiddenFields) => {
    const conversationId = scope();
    const messages = history(conversationId);
    await render({ conversationId, messages });
    await scroll(430);
    const anchor = visibleAnchor();
    const hidden = { ...message("hidden", "Internal update", 20), ...hiddenFields };
    await render({ conversationId, messages: [...messages, hidden] });
    expect(scroller().scrollHeight).toBe(1200);
    expect(indicator()).toBe("Jump to latest");
    const streamed = messages.map((entry, index) => index === messages.length - 1 ? { ...entry, content: `${entry.content} more text` } : entry);
    await render({ conversationId, messages: [...streamed, hidden] });
    expect(visibleAnchor()).toEqual(anchor);
    expect(indicator()).toBe("New messages");
  });

  it("uses the existing collapsed presentation without treating redundant setup text as an arrival", async () => {
    const conversationId = scope();
    const plan: ChatMessage = { ...message("plan", "Team plan", 0), messageType: "multi_agent_plan", metadata: { jobId: "plan-job" } };
    const messages = [plan, ...history(conversationId)];
    await render({ conversationId, messages });
    await scroll(430);
    const setup: ChatMessage = { ...message("setup", "The team is ready", 20), metadata: { jobId: "plan-job", outcome: "succeeded" } };
    // This row passes the individual visibility predicate, but the full chat
    // presentation collapses it into the existing plan. The hook must use the
    // caller's already-computed displayed messages, not raw history.
    expect(shouldDisplayChatMessage(setup)).toBe(true);
    await render({ conversationId, messages: [...messages, setup] });
    expect(container.querySelector('[data-chat-scroll-message-id="setup"]')).toBeNull();
    expect(indicator()).toBe("Jump to latest");
  });

  it.each([
    { id: "conversation-thread-preview:child", messageType: "conversation_thread" },
    { id: "conversation-thread-run-thread:child", messageType: "agent_job_thread" },
  ])("keeps parent arrivals and streaming visible with a trailing $messageType preview", async ({ id, messageType }) => {
    const conversationId = scope();
    const messages = history(conversationId);
    const trailingPreview: ChatMessage = {
      ...message(id, "", 0), messageType,
      metadata: { threadLocalId: "child", linkedThreadId: "child" },
    };
    await render({ conversationId, messages, trailingPreview });
    await scroll(430);
    const anchor = visibleAnchor();
    const reply = message("new-parent-reply", "New reply", 20);
    await render({ conversationId, messages: [...messages, reply], trailingPreview });
    expect(container.querySelectorAll("[data-chat-scroll-message-id]").item(13).getAttribute("data-chat-scroll-message-id")).toBe(id);
    expect(visibleAnchor()).toEqual(anchor);
    expect(indicator()).toBe("New messages");
    await click("jump");
    await scroll(430);
    expect(indicator()).toBe("Jump to latest");
    await render({ conversationId, messages: [...messages, { ...reply, content: `${reply.content} continues streaming` }], trailingPreview });
    expect(visibleAnchor()).toEqual(anchor);
    expect(indicator()).toBe("New messages");
  });

  it.each([
    { role: "user", metadata: { attachments: [{ kind: "image", workspacePath: "image.png", mimeType: "image/png" }] } },
    { messageType: "file_change", files: [{ path: "file.txt", workspacePath: "file.txt", label: "file.txt", changeType: "created", lineRanges: [] }] },
  ] satisfies Partial<ChatMessage>[])("notices visible attachment-only arrivals %j", async (attachmentFields) => {
    const conversationId = scope();
    const messages = history(conversationId);
    await render({ conversationId, messages });
    await scroll(430);
    const anchor = visibleAnchor();
    await render({ conversationId, messages: [...messages, { ...message("attachment", "", 20), ...attachmentFields }] });
    expect(container.querySelector('[data-chat-scroll-message-id="attachment"]')).not.toBeNull();
    expect(visibleAnchor()).toEqual(anchor);
    expect(indicator()).toBe("New messages");
  });

  it("retains the reading anchor through older-page prepends without a new-message notice", async () => {
    const conversationId = scope();
    const messages = history(conversationId);
    const loadOlderMessages = vi.fn(() => Promise.resolve());
    await render({ conversationId, messages, loadOlderMessages });
    await scroll(430);
    const anchor = visibleAnchor();
    await click("older");
    await render({ conversationId, messages, loadOlderMessages, historyLoading: true });
    await render({ conversationId, messages: [...history("old", 3), ...messages], loadOlderMessages });
    expect(scroller().scrollTop).toBe(730);
    expect(visibleAnchor()).toEqual(anchor);
    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
    expect(indicator()).toBe("Jump to latest");
  });

  it("establishes a fresh arrival baseline on cold hydration and a warm remount", async () => {
    const conversationId = scope();
    const messages = history(conversationId);
    await render({ conversationId, messages: [], initialLoading: true });
    expect(indicator()).toBeNull();
    await render({ conversationId, messages });
    expect(indicator()).toBeNull();
    await scroll(430);
    await render({ conversationId, messages: [...messages, message("arrived", "Reply", 20)] });
    expect(indicator()).toBe("New messages");
    const anchor = visibleAnchor();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render({ conversationId, messages: [...messages, message("while-unmounted", "Reply", 21)] });
    expect(visibleAnchor()).toEqual(anchor);
    expect(indicator()).toBe("Jump to latest");
  });

  it("scopes pending resize and older-history completion to the current chat", async () => {
    const conversationId = scope();
    const messages = history(conversationId);
    let rejectRead!: (error: Error) => void;
    const loadOlderMessages = () => new Promise<void>((_, reject) => { rejectRead = reject; });
    await render({ conversationId, messages, loadOlderMessages });
    await scroll(430);
    await render({ conversationId, messages: [...messages, message("incoming", "Reply", 20)], loadOlderMessages });
    expect(indicator()).toBe("New messages");
    await click("older");
    await act(async () => { for (const observer of observers) observer([], {} as ResizeObserver); });
    expect(frames.size).toBeGreaterThan(0);
    const otherId = scope();
    await render({ conversationId: otherId, messages: history(otherId, 8) });
    await act(async () => { rejectRead(new Error("The old read was cancelled")); });
    await flushResize();
    expect(scroller().scrollTop).toBe(600);
    expect(indicator()).toBeNull();
    await scroll(200);
    expect(indicator()).toBe("Jump to latest");
  });

  it("does not scroll a reader away when the keyboard changes viewport height", async () => {
    const conversationId = scope();
    const messages = history(conversationId);
    await render({ conversationId, messages });
    await scroll(430);
    const anchor = visibleAnchor();
    await render({ conversationId, messages, clientHeight: 120 });
    expect(visibleAnchor()).toEqual(anchor);
    expect(indicator()).toBe("Jump to latest");
    await render({ conversationId, messages, clientHeight: VIEWPORT_HEIGHT });
    expect(visibleAnchor()).toEqual(anchor);
    expect(indicator()).toBe("Jump to latest");
  });
});
