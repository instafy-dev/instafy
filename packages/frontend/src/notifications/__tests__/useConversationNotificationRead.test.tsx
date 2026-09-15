// @vitest-environment jsdom
import { act, useRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
const native = vi.hoisted(() => ({ enabled: false, listener: null as ((event: { isActive: boolean }) => void) | null, remove: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => native.enabled } }));
vi.mock("@capacitor/app", () => ({ App: {
  addListener: async (_event: string, listener: (event: { isActive: boolean }) => void) => { native.listener = listener; return { remove: native.remove }; },
  getState: async () => ({ isActive: true }),
} }));
vi.mock("../../services/runtimeController/productNotifications", () => ({ readConversationProductNotifications: read }));
vi.mock("../notificationPresentation", () => ({ NOTIFICATION_RECEIVED_EVENT: "notification-read-test" }));
import { useConversationNotificationRead } from "../useConversationNotificationRead";
import { setNotificationSession } from "../notificationSession";
import { installNativeAppForegroundBridge } from "../../native/appForeground";
import { focusManager } from "@tanstack/react-query";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const id = (index: number) => `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`;
const rect = (top = 0, height = 2) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 300, width: 300, height, toJSON: () => ({}) }) as DOMRect;
const observers: FakeIntersectionObserver[] = [];
class FakeIntersectionObserver {
  readonly elements = new Set<Element>();
  readonly observe = vi.fn((element: Element) => this.elements.add(element));
  readonly unobserve = vi.fn((element: Element) => this.elements.delete(element));
  readonly disconnect = vi.fn(() => this.elements.clear());
  constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit) { observers.push(this); }
  emit(elements = [...this.elements], intersecting = true) {
    this.callback(elements.map((element) => ({ target: element, isIntersecting: intersecting, intersectionRect: element.getBoundingClientRect() })) as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}
function Harness({ userId = ACCOUNT, messages = [id(1)], enabled = true, hidden = false }: {
  userId?: string; messages?: string[]; enabled?: boolean; hidden?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useConversationNotificationRead({ currentUserId: userId, conversationId: CONVERSATION, rootRef: ref as RefObject<HTMLElement | null>, enabled });
  return <div ref={ref} data-testid="transcript" hidden={hidden}>
    {messages.map((messageId, index) => <div key={messageId} data-chat-message-id={messageId} data-top={index * 3}>{messageId}</div>)}
  </div>;
}

describe("reading only visible persisted conversation messages", () => {
  let root: Root;
  let container: HTMLDivElement;
  let visibility: DocumentVisibilityState;
  let covered: boolean;
  let disposeNative: (() => void) | undefined;
  const acknowledged = vi.fn();
  async function render(props: Parameters<typeof Harness>[0] = {}) {
    await act(async () => root.render(<Harness {...props} />));
  }
  async function advance(ms = 250) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  async function emit(elements?: Element[], intersecting = true) {
    await act(async () => observers.at(-1)!.emit(elements, intersecting));
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers(); read.mockReset(); read.mockResolvedValue(undefined); observers.length = 0;
    native.enabled = false; native.listener = null; native.remove.mockResolvedValue(undefined); disposeNative = undefined;
    visibility = "visible"; covered = false; acknowledged.mockReset();
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-chat-message-id") ? rect(Number(this.dataset.top), 2) : rect(0, 700);
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn((_x: number, y: number) => {
      if (covered) return document.body;
      return [...document.querySelectorAll("[data-chat-message-id]")].find((element) => {
        const box = element.getBoundingClientRect(); return box.top <= y && box.bottom >= y;
      }) ?? null;
    }) });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    setNotificationSession({ userId: ACCOUNT, accessToken: "token-a" });
    window.addEventListener("notification-read-test", acknowledged);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    disposeNative?.(); focusManager.setFocused(undefined);
    window.removeEventListener("notification-read-test", acknowledged);
    setNotificationSession(null); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not read on selection or hydration; sends only exact visible source UUIDs", async () => {
    await render({ messages: [id(1), id(2), "synthetic-thread-preview"] });
    await advance(5_000); expect(read).not.toHaveBeenCalled();
    expect(observers[0].options.root).toBeNull(); expect(observers[0].elements.size).toBe(2);
    const first = container.querySelector(`[data-chat-message-id="${id(1)}"]`)!;
    await emit([first]); await advance();
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][0]).toMatchObject({ conversationId: CONVERSATION, messageIds: [id(1)], expectedUserId: ACCOUNT, accessToken: "token-a" });
    await emit([first]); await advance(); expect(read).toHaveBeenCalledOnce();
    const second = container.querySelector(`[data-chat-message-id="${id(2)}"]`)!;
    await emit([second]); await advance();
    expect(read.mock.calls[1][0].messageIds).toEqual([id(2)]);
  });

  it("requires fresh viewport observation after a hidden document becomes visible", async () => {
    visibility = "hidden"; await render(); await emit(); await advance(); expect(read).not.toHaveBeenCalled();
    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(); expect(read).not.toHaveBeenCalled();
    await emit(); await advance(); expect(read).toHaveBeenCalledOnce();
  });

  it("cancels exposure while native activity is inactive despite visible DOM, and requires a fresh observation on resume", async () => {
    native.enabled = true;
    disposeNative = installNativeAppForegroundBridge(); await vi.dynamicImportSettled();
    await render(); await emit();
    await act(async () => native.listener?.({ isActive: false }));
    expect(document.visibilityState).toBe("visible");
    await advance(1_000); expect(read).not.toHaveBeenCalled();
    const message = container.querySelector("[data-chat-message-id]")!;
    await emit([message]); await advance(); expect(read).not.toHaveBeenCalled();
    await act(async () => native.listener?.({ isActive: true }));
    await advance(); expect(read).not.toHaveBeenCalled();
    await emit(); await advance(); expect(read).toHaveBeenCalledOnce();
  });

  it("reschedules freshly observed exposure after an old request spans native background and resume", async () => {
    native.enabled = true;
    disposeNative = installNativeAppForegroundBridge(); await vi.dynamicImportSettled();
    let complete!: () => void;
    read.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    await render(); await emit(); await advance();
    const oldRequest = read.mock.calls[0][0];
    expect(oldRequest.isCurrent()).toBe(true);
    await act(async () => native.listener?.({ isActive: false }));
    expect(oldRequest.isCurrent()).toBe(false);
    await act(async () => native.listener?.({ isActive: true }));
    expect(oldRequest.isCurrent()).toBe(false);
    await emit(); await advance(); expect(read).toHaveBeenCalledOnce();
    await act(async () => complete());
    expect(acknowledged).not.toHaveBeenCalled();
    await advance();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][0].messageIds).toEqual([id(1)]);
    expect(read.mock.calls[1][0].isCurrent()).toBe(true);
    expect(acknowledged).toHaveBeenCalledOnce();
    await advance(10_000); expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not read a hidden chat pane or messages covered by a modal", async () => {
    await render({ hidden: true }); await emit(); await advance(); expect(read).not.toHaveBeenCalled();
    await render(); covered = true; await emit(); await advance(); expect(read).not.toHaveBeenCalled();
    covered = false; await act(async () => window.dispatchEvent(new Event("focus")));
    await advance(); expect(read).not.toHaveBeenCalled();
    await emit(); await advance(); expect(read).toHaveBeenCalledOnce();
  });

  it("drops a pending acknowledgement when scrolling away or switching chat tabs", async () => {
    await render(); const elements = [...observers[0].elements]; await emit(elements); await emit(elements, false);
    await advance(); expect(read).not.toHaveBeenCalled();
    await emit(elements); await render({ enabled: false }); await advance(); expect(read).not.toHaveBeenCalled();
  });

  it("uses current hit-test geometry when scrolling without another intersection callback", async () => {
    covered = true; await render(); await emit(); await advance(); expect(read).not.toHaveBeenCalled();
    const message = container.querySelector<HTMLElement>("[data-chat-message-id]")!;
    message.dataset.top = "120";
    covered = false;
    await act(async () => container.querySelector('[data-testid="transcript"]')!.dispatchEvent(new Event("scroll")));
    await advance(); expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][0].messageIds).toEqual([id(1)]);
  });

  it("chunks exact visible IDs into bounded nonoverlapping requests", async () => {
    const messages = Array.from({ length: 205 }, (_, index) => id(index));
    await render({ messages }); await emit(); await advance(1_000);
    expect(read.mock.calls.map(([request]) => request.messageIds.length)).toEqual([100, 100, 5]);
    expect(read.mock.calls.flatMap(([request]) => request.messageIds)).toEqual(messages);
  });

  it("retries transient failures with the same captured account and stops after three attempts", async () => {
    read.mockRejectedValue(new Error("Offline")); await render(); await emit();
    await advance(250); await advance(1_000); await advance(2_000); await advance(20_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every(([request]) => request.accessToken === "token-a" && request.messageIds[0] === id(1))).toBe(true);
    read.mockResolvedValue(undefined);
    await act(async () => window.dispatchEvent(new Event("online"))); await emit(); await advance();
    expect(read).toHaveBeenCalledTimes(4); expect(acknowledged).toHaveBeenCalledOnce();
  });

  it("never retries or publishes late results after an account switch, including A→B→A", async () => {
    let reject!: (error: Error) => void;
    read.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    await render(); await emit(); await advance();
    const captured = read.mock.calls[0][0]; expect(captured.isCurrent()).toBe(true);
    await act(async () => setNotificationSession({ userId: OTHER, accessToken: "token-b" }));
    await render({ userId: OTHER, messages: [id(2)] });
    await act(async () => setNotificationSession({ userId: ACCOUNT, accessToken: "token-a" }));
    await render(); expect(captured.isCurrent()).toBe(false);
    await act(async () => reject(new Error("Late failure"))); await advance(20_000);
    expect(read).toHaveBeenCalledOnce(); expect(acknowledged).not.toHaveBeenCalled();
  });

  it("observes newly rendered source IDs without treating all hydrated messages as read", async () => {
    await render(); await emit(); await advance();
    await render({ messages: [id(1), id(2)] });
    await advance(); expect(read).toHaveBeenCalledOnce();
    await emit([container.querySelector(`[data-chat-message-id="${id(2)}"]`)!]); await advance();
    expect(read.mock.calls[1][0].messageIds).toEqual([id(2)]);
  });
});
