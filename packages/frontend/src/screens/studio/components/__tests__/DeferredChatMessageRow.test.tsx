// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { DeferredChatMessageRow, DeferredChatRows } from "../DeferredChatMessageRow";

class ControlledIntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit,
  ) {
    ControlledIntersectionObserver.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  emit(target: Element, isIntersecting: boolean) {
    if (!this.targets.has(target)) return;
    this.callback([{
      target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: this.options.root instanceof Element ? this.options.root.getBoundingClientRect() : null, time: 0,
    } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  emit(target: Element) {
    if (!this.targets.has(target)) return;
    this.callback([{
      target, contentRect: target.getBoundingClientRect(),
    } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function rect(width: number, height: number, top = 0): DOMRect {
  return { width, height, top, bottom: top + height, left: 0, right: width, x: 0, y: top, toJSON: () => ({}) };
}

describe("DeferredChatMessageRow", () => {
  let root: Root;
  let container: HTMLDivElement;
  let messages: ChatMessage[];
  let rowWidth: number;
  let rowHeight: number;
  let beforeMatchDescriptor: PropertyDescriptor | undefined;
  let animationFrames: Map<number, FrameRequestCallback>;
  let geometryEvents: string[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", ControlledIntersectionObserver);
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    animationFrames = new Map();
    let nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      animationFrames.set(++nextFrameId, callback);
      return nextFrameId;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => animationFrames.delete(id)));
    ControlledIntersectionObserver.instances = [];
    ControlledResizeObserver.instances = [];
    beforeMatchDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, "onbeforematch");
    Object.defineProperty(document.documentElement, "onbeforematch", { value: null, configurable: true });
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1_280);
    rowWidth = 640;
    rowHeight = 120;
    geometryEvents = [];
    messages = Array.from({ length: 3 }, (_, index) => ({
      id: `message-${index}`, role: "assistant", content: `Saved message ${index}`, timestamp: index,
    }));
    // The row's placeholder keeps the measured height. Its width follows the
    // actual chat column, which can resize independently of the viewport.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const row = this.closest<HTMLElement>('[data-testid="chat-message-row"]');
      if (row) {
        geometryEvents.push(`measure:${row.dataset.chatScrollMessageId}`);
        return rect(rowWidth, Number.parseFloat(row.style.height) || rowHeight, 2_000);
      }
      if (this.matches('[data-testid="chat-message-scroll"]')) return rect(800, 700);
      return rect(0, 0);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (beforeMatchDescriptor) Object.defineProperty(document.documentElement, "onbeforematch", beforeMatchDescriptor);
    else Reflect.deleteProperty(document.documentElement, "onbeforematch");
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(options: { eligible?: boolean; eager?: boolean; layoutKey?: string; messageCount?: number } = {}) {
    await act(async () => root.render(
      <div data-testid="chat-message-scroll">
        <DeferredChatRows messageCount={options.messageCount ?? 400}>
          {messages.map((message) => <DeferredChatMessageRow
            key={message.id}
            message={message}
            layoutKey={options.layoutKey ?? "assistant-layout"}
            eager={options.eager ?? false}
            eligible={options.eligible ?? true}
          >
            <article data-body={message.id}>
              <p>{message.content}</p>
              <button type="button">Actions for {message.id}</button>
            </article>
          </DeferredChatMessageRow>)}
        </DeferredChatRows>
      </div>,
    ));
  }

  function rows() {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="chat-message-row"]'));
  }

  it("remounts an already deferred row when it becomes an explicit eager message target", async () => {
    await render();
    await intersection(false);
    expect(rows().every((row) => row.dataset.chatRowDeferred === "true")).toBe(true);
    await render({ eager: true });
    expect(rows().every((row) => !row.dataset.chatRowDeferred)).toBe(true);
    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
  });

  async function intersection(visible: boolean, targets = rows()) {
    await act(async () => {
      for (const observer of ControlledIntersectionObserver.instances) {
        for (const target of targets) observer.emit(target, visible);
      }
    });
  }

  async function resize() {
    await act(async () => {
      for (const observer of ControlledResizeObserver.instances) {
        for (const target of rows()) observer.emit(target);
      }
    });
  }

  async function animationFrame() {
    await act(async () => {
      const pending = [...animationFrames.values()];
      animationFrames.clear();
      for (const callback of pending) callback(performance.now());
    });
  }

  it("renders unknown geometry eagerly until a usable height and width have been measured", async () => {
    rowHeight = 0;
    await render();
    await intersection(false);
    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
    expect(rows().every((row) => !row.hasAttribute("data-chat-row-deferred"))).toBe(true);

    rowHeight = 120;
    await resize();
    await intersection(true);
    await intersection(false);
    expect(container.querySelectorAll("[data-body]")).toHaveLength(0);
  });

  it("defers measured offscreen bodies while retaining every message-ID shell and its height", async () => {
    await render();
    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
    await intersection(false);

    expect(container.querySelectorAll("[data-body]")).toHaveLength(0);
    expect(rows().map((row) => row.dataset.chatScrollMessageId)).toEqual(messages.map((message) => message.id));
    expect(rows().map((row) => row.style.height)).toEqual(["120px", "120px", "120px"]);
    expect(rows()[0]?.getAttribute("aria-label")).toBe("Assistant: Saved message 0");
    expect(rows()[0]?.querySelector('[hidden="until-found"]')?.textContent).toBe("Saved message 0");
    expect(rows()[0]?.querySelector('[hidden="until-found"]')?.classList.contains("block")).toBe(true);
    expect(ControlledIntersectionObserver.instances).toHaveLength(1);
    expect(ControlledIntersectionObserver.instances[0]?.options).toEqual({
      root: container.querySelector('[data-testid="chat-message-scroll"]'), rootMargin: "1000px 0px",
    });

    await intersection(true, [rows()[1]!]);
    expect(container.querySelectorAll("[data-body]")).toHaveLength(1);
    expect(container.querySelector('[data-body="message-1"]')).not.toBeNull();
    expect(rows()).toHaveLength(3);
  });

  it("uses measurements on warm remount at the same layout width", async () => {
    await render();
    await act(async () => root.render(null));
    await render();

    expect(container.querySelectorAll("[data-body]")).toHaveLength(0);
    expect(rows().map((row) => row.style.height)).toEqual(["120px", "120px", "120px"]);
  });

  it("measures warm shells in one pass after all searchable hidden-text refs have committed", async () => {
    await render();
    await act(async () => root.render(null));
    geometryEvents.length = 0;
    const setAttribute = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (this: Element, name, value) {
      if (name === "hidden" && value === "until-found") {
        const id = this.closest<HTMLElement>('[data-chat-scroll-message-id]')?.dataset.chatScrollMessageId;
        geometryEvents.push(`hide:${id}`);
      }
      setAttribute.call(this, name, value);
    });

    await render();

    expect(geometryEvents).toEqual([
      ...messages.map((message) => `hide:${message.id}`),
      ...messages.map((message) => `measure:${message.id}`),
    ]);
    // The commit pass consumes the coalesced frame request. No extra layout
    // reads remain queued once all mounted children have been measured.
    expect(animationFrames.size).toBe(0);
    await animationFrame();
    expect(geometryEvents.filter((event) => event.startsWith("measure:"))).toHaveLength(messages.length);
  });

  it("renders the eager newest-message window immediately even with cached geometry", async () => {
    await render();
    await act(async () => root.render(null));
    await render({ eager: true });

    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
    expect(rows().every((row) => !row.hasAttribute("data-chat-row-deferred"))).toBe(true);
  });

  it("reveals and remeasures a warm transcript when the chat column width changes", async () => {
    await render();
    await intersection(false);
    rowWidth = 400;
    rowHeight = 220;
    await resize();

    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
    // Revealing the bodies changes each observed row's height from 120 to 220.
    // A real ResizeObserver delivers that layout change in its next batch.
    await resize();
    await intersection(false);
    expect(rows().map((row) => row.style.height)).toEqual(["220px", "220px", "220px"]);

    await act(async () => root.render(null));
    await render();
    expect(rows().map((row) => row.style.height)).toEqual(["220px", "220px", "220px"]);
  });

  it("remeasures after viewport width changes even when the centered chat column keeps its width", async () => {
    await render();
    await intersection(false);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1_000);
    rowHeight = 180;
    await act(async () => window.dispatchEvent(new Event("resize")));

    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
    expect(animationFrames.size).toBe(1);
    await animationFrame();
    await intersection(false);
    expect(rows().map((row) => row.style.height)).toEqual(["180px", "180px", "180px"]);
  });

  it("invalidates cached geometry when the message layout changes", async () => {
    await render();
    await intersection(false);
    rowHeight = 180;
    await render({ layoutKey: "assistant-layout-with-author" });

    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
  });

  it("keeps the body mounted while an offscreen message action owns focus", async () => {
    await render();
    const action = rows()[0]!.querySelector("button")!;
    action.focus();
    await intersection(false);

    expect(container.querySelectorAll("[data-body]")).toHaveLength(1);
    expect(document.activeElement).toBe(action);
    expect(action.isConnected).toBe(true);
    action.blur();
    await intersection(false);
    expect(container.querySelectorAll("[data-body]")).toHaveLength(0);
  });

  it.each(["keyboard find", "browser find", "selection", "read all button"])(
    "reveals every loaded body for %s",
    async (trigger) => {
      await render();
      await intersection(false);
      expect(container.querySelectorAll("[data-body]")).toHaveLength(0);
      await act(async () => {
        if (trigger === "keyboard find") document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
        else if (trigger === "browser find") rows()[0]?.querySelector("span")?.dispatchEvent(new Event("beforematch", { bubbles: true }));
        else if (trigger === "selection") {
          vi.spyOn(document, "getSelection").mockReturnValue({
            isCollapsed: false, anchorNode: rows()[0]?.querySelector("span")?.firstChild,
          } as Selection);
          document.dispatchEvent(new Event("selectionchange"));
        } else container.querySelector<HTMLButtonElement>("button")?.click();
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
      expect(container.textContent).not.toContain("Read all loaded messages");
      await intersection(false);
      expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
    },
  );

  it("never defers interactive ineligible rows", async () => {
    await render({ eligible: false });
    await intersection(false);
    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
    expect(rows().every((row) => !row.hasAttribute("data-chat-row-deferred"))).toBe(true);
  });

  it("keeps small transcripts eager", async () => {
    await render({ messageCount: 100 });
    await intersection(false);
    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
    expect(container.textContent).not.toContain("Read all loaded messages");
  });

  it("keeps eager rendering when intersection observation is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    await render();
    expect(container.querySelectorAll("[data-body]")).toHaveLength(3);
    expect(container.textContent).not.toContain("Read all loaded messages");
    expect(ControlledIntersectionObserver.instances).toHaveLength(0);
  });
});
