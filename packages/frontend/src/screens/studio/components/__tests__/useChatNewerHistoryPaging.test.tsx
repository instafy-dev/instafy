// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatNewerHistoryPaging } from "../useChatNewerHistoryPaging";

type PagingOptions = Parameters<typeof useChatNewerHistoryPaging>[0];

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe("intent-gated newer history paging", () => {
  let root: Root;
  let container: HTMLDivElement;
  let options: PagingOptions;
  let metrics: { scrollTop: number; scrollHeight: number; clientHeight: number; clientWidth: number; offsetWidth: number };
  let loadNewer: ReturnType<typeof vi.fn>;
  let isReadingReady: ReturnType<typeof vi.fn>;
  const viewport = () => options.scrollContainerRef.current!;

  function Harness() {
    useChatNewerHistoryPaging(options);
    return <div data-testid="ancestor"><div
      tabIndex={0}
      data-testid="viewport"
      ref={node => {
        options.scrollContainerRef.current = node;
        if (!node) return;
        Object.defineProperties(node, {
          scrollTop: { configurable: true, get: () => metrics.scrollTop, set: value => { metrics.scrollTop = Number(value); } },
          scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
          clientHeight: { configurable: true, get: () => metrics.clientHeight },
          clientWidth: { configurable: true, get: () => metrics.clientWidth },
          offsetWidth: { configurable: true, get: () => metrics.offsetWidth },
        });
        node.getBoundingClientRect = () => ({
          x: 0, y: 0, top: 0, left: 0, right: metrics.offsetWidth, bottom: metrics.clientHeight,
          width: metrics.offsetWidth, height: metrics.clientHeight, toJSON: () => ({}),
        });
      }}
    >
      <textarea data-testid="textarea" />
      <div contentEditable suppressContentEditableWarning data-testid="editable"><span>Draft text</span></div>
      <p data-testid="message">A historical message</p>
    </div></div>;
  }

  const render = async () => { await act(async () => root.render(<Harness />)); };
  const emit = async (event: Event, target: EventTarget = viewport()) => {
    await act(async () => { target.dispatchEvent(event); });
  };
  const wheel = (deltaY = 60, target?: EventTarget) => emit(new WheelEvent("wheel", { bubbles: true, deltaY }), target);
  const scroll = () => emit(new Event("scroll", { bubbles: true }));
  const key = (value: string, target?: EventTarget, init: KeyboardEventInit = {}) =>
    emit(new KeyboardEvent("keydown", { bubbles: true, key: value, ...init }), target);
  const touch = (type: "touchstart" | "touchmove" | "touchend" | "touchcancel", clientY: number) => {
    const event = new Event(type, { bubbles: true });
    const point = { identifier: 1, clientX: 70, clientY, pageX: 70, pageY: clientY };
    Object.defineProperties(event, {
      touches: { value: type === "touchend" || type === "touchcancel" ? [] : [point] },
      changedTouches: { value: [point] },
    });
    return emit(event);
  };
  const pointer = (type: string, clientX: number, clientY: number, pointerType = "mouse") => {
    const event = new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0, buttons: type === "pointerup" ? 0 : 1 });
    Object.defineProperties(event, { pointerType: { value: pointerType }, pointerId: { value: 7 } });
    return emit(event);
  };
  const setRoute = (routeKey: string) => {
    window.history.replaceState({ idx: 0, key: routeKey, usr: null }, "", "/studio?projectId=space-a&conversationId=chat-a&messageId=old-message");
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    metrics = { scrollTop: 760, scrollHeight: 1000, clientHeight: 200, clientWidth: 280, offsetWidth: 300 };
    loadNewer = vi.fn();
    isReadingReady = vi.fn(() => true);
    options = {
      visitKey: "viewer-a:space-a:chat-a:visit-a", routeKey: "route-a", enabled: true,
      hasNewer: true, loading: false, error: null, scrollContainerRef: createRef<HTMLDivElement>(),
      isReadingReady, loadNewer,
    };
    setRoute(options.routeKey);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("never loads from reveal, programmatic scrolling, resizing or rerendering alone", async () => {
    metrics.scrollTop = 100;
    await scroll();
    metrics.scrollTop = 799;
    await scroll();
    await emit(new Event("resize"), window);
    metrics.scrollHeight = 1100;
    metrics.scrollTop = 890;
    await render();
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it("consumes one near-bottom wheel intent and does not chain pages from subsequent scrolls", async () => {
    await wheel();
    expect(loadNewer).toHaveBeenCalledTimes(1);
    await scroll();
    await scroll();
    await render();
    await scroll();
    expect(loadNewer).toHaveBeenCalledTimes(1);
    await wheel();
    expect(loadNewer).toHaveBeenCalledTimes(2);
  });

  it("loads an underfilled transcript from a fresh downward wheel without requiring a scroll event", async () => {
    metrics.scrollTop = 0;
    metrics.scrollHeight = 150;
    await render();
    expect(loadNewer).not.toHaveBeenCalled();
    await wheel();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it("waits until a downward gesture reaches the bottom threshold", async () => {
    metrics.scrollTop = 200;
    await wheel();
    expect(loadNewer).not.toHaveBeenCalled();
    metrics.scrollTop = 675;
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
    metrics.scrollTop = 685;
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it("expires unused input intent after 750ms", async () => {
    vi.useFakeTimers();
    metrics.scrollTop = 200;
    await wheel();
    await act(async () => { vi.advanceTimersByTime(751); });
    metrics.scrollTop = 780;
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
    await wheel();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it.each(["loading", "error"] as const)("clears an armed gesture across a %s state", async state => {
    metrics.scrollTop = 200;
    await wheel();
    options = { ...options, ...(state === "loading" ? { loading: true } : { error: "Unable to load newer history" }) };
    await render();
    metrics.scrollTop = 780;
    await wheel();
    expect(loadNewer).not.toHaveBeenCalled();
    options = { ...options, loading: false, error: null };
    await render();
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
    await wheel();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "exhausted", "unresolved", "reading"] as const)("requires readiness when %s", async state => {
    options = { ...options,
      enabled: state !== "disabled", hasNewer: state !== "exhausted",
      visitKey: state === "unresolved" ? null : options.visitKey,
    };
    isReadingReady.mockReturnValue(state !== "reading");
    await render();
    await wheel();
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it.each(["disabled", "exhausted", "unresolved", "loading", "error"] as const)("does not attach input listeners or ancestor observers when %s", async state => {
    const addListener = vi.spyOn(viewport(), "addEventListener");
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    options = { ...options,
      enabled: state !== "disabled", hasNewer: state !== "exhausted",
      visitKey: state === "unresolved" ? null : options.visitKey,
      loading: state === "loading", error: state === "error" ? "Newer history unavailable" : null,
    };
    await render();
    expect(addListener).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    await wheel();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it.each(["hidden", "inert", "aria-hidden"])("ignores a transcript beneath a %s ancestor", async attribute => {
    container.querySelector('[data-testid="ancestor"]')!.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
    await wheel();
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it("ignores hidden documents and zero-height viewports", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await wheel();
    expect(loadNewer).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    metrics.clientHeight = 0;
    await wheel();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it("does not act on a newer browser visit before the rendered route catches up", async () => {
    setRoute("unrendered-route");
    await wheel();
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
    setRoute("route-a");
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
    await wheel();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it.each(["textarea", "editable"])("ignores wheel and keyboard input within %s", async testId => {
    const control = container.querySelector(`[data-testid="${testId}"]`)!;
    const target = control.querySelector("span") ?? control;
    await wheel(60, target);
    await key("PageDown", target);
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it.each(["PageDown", "End", " ", "ArrowDown"])("accepts %s as downward reading intent", async value => {
    await key(value);
    expect(loadNewer).toHaveBeenCalledOnce();
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it("ignores upward wheels, horizontal wheels, upward keys and Shift+Space", async () => {
    await wheel(-60);
    await emit(new WheelEvent("wheel", { bubbles: true, deltaY: 0, deltaX: 60 }));
    for (const value of ["ArrowUp", "PageUp", "Home"]) await key(value);
    await key(" ", undefined, { shiftKey: true });
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it("recognizes a finger moving upward as downward reading intent", async () => {
    await touch("touchstart", 160);
    await touch("touchmove", 100);
    expect(loadNewer).toHaveBeenCalledOnce();
    await touch("touchend", 100);
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it("keeps one downward touch intent for inertia after the finger leaves the screen", async () => {
    metrics.scrollTop = 200;
    await touch("touchstart", 160);
    await touch("touchmove", 100);
    await touch("touchend", 100);
    expect(loadNewer).not.toHaveBeenCalled();
    // Inertial movement reaches the prefetch boundary after touchend.
    metrics.scrollTop = 685;
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
    metrics.scrollTop = 780;
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it("keeps a continuing long inertial gesture armed without chaining another page", async () => {
    vi.useFakeTimers();
    metrics.scrollTop = 200;
    await touch("touchstart", 160);
    await touch("touchmove", 100);
    await touch("touchend", 100);
    for (const top of [350, 500]) {
      await act(async () => { vi.advanceTimersByTime(600); });
      metrics.scrollTop = top;
      await scroll();
      expect(loadNewer).not.toHaveBeenCalled();
    }
    await act(async () => { vi.advanceTimersByTime(600); });
    metrics.scrollTop = 685;
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
    await act(async () => { vi.advanceTimersByTime(600); });
    metrics.scrollTop = 780;
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "pointerup"])("keeps touch inertia when the parallel pointer stream emits %s", async completion => {
    metrics.scrollTop = 200;
    await pointer("pointerdown", 70, 160, "touch");
    await touch("touchstart", 160);
    // Browsers may cancel the pointer stream as native touch scrolling starts.
    if (completion === "pointercancel") await pointer(completion, 70, 160, "touch");
    await touch("touchmove", 100);
    await touch("touchend", 100);
    if (completion === "pointerup") await pointer(completion, 70, 100, "touch");
    metrics.scrollTop = 685;
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
    metrics.scrollTop = 780;
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "expired"] as const)("does not retain %s touch intent for later scrolls", async state => {
    vi.useFakeTimers();
    metrics.scrollTop = 200;
    await touch("touchstart", 160);
    await touch("touchmove", 100);
    await touch(state === "cancelled" ? "touchcancel" : "touchend", 100);
    if (state === "expired") await act(async () => { vi.advanceTimersByTime(751); });
    metrics.scrollTop = 780;
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it("ignores a finger moving downward", async () => {
    await touch("touchstart", 100);
    await touch("touchmove", 160);
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it("recognizes downward dragging in the scrollbar gutter", async () => {
    await pointer("pointerdown", 295, 160);
    await pointer("pointermove", 295, 185);
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
    await pointer("pointerup", 295, 185);
    await scroll();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it("does not treat message selection or upward scrollbar dragging as downward intent", async () => {
    await pointer("pointerdown", 100, 100);
    await pointer("pointermove", 100, 160);
    await pointer("pointerup", 100, 160);
    await pointer("pointerdown", 295, 160);
    await pointer("pointermove", 295, 100);
    await pointer("pointerup", 295, 100);
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it("uses the latest callback after rerendering", async () => {
    const latestLoad = vi.fn();
    options = { ...options, loadNewer: latestLoad };
    await render();
    await wheel();
    expect(latestLoad).toHaveBeenCalledOnce();
    expect(loadNewer).not.toHaveBeenCalled();
  });

  it("does not transfer armed input across account/visit changes", async () => {
    metrics.scrollTop = 200;
    await wheel();
    options = { ...options, visitKey: "viewer-b:space-b:chat-b:visit-b", routeKey: "route-b" };
    setRoute(options.routeKey);
    await render();
    metrics.scrollTop = 780;
    await scroll();
    expect(loadNewer).not.toHaveBeenCalled();
    await wheel();
    expect(loadNewer).toHaveBeenCalledOnce();
  });

  it("a departed visit's completion cannot unlock another visit's pending request", async () => {
    const first = deferred();
    loadNewer.mockReturnValue(first.promise);
    await wheel();
    expect(loadNewer).toHaveBeenCalledOnce();
    const second = deferred();
    const nextLoad = vi.fn(() => second.promise);
    options = { ...options, visitKey: "viewer-b:space-b:chat-b:visit-b", routeKey: "route-b", loadNewer: nextLoad };
    setRoute(options.routeKey);
    await render();
    await wheel();
    expect(nextLoad).toHaveBeenCalledOnce();
    await act(async () => { first.resolve(); await first.promise; });
    await wheel();
    await scroll();
    expect(nextLoad).toHaveBeenCalledOnce();
    await act(async () => { second.resolve(); await second.promise; });
    await scroll();
    expect(nextLoad).toHaveBeenCalledOnce();
    await wheel();
    expect(nextLoad).toHaveBeenCalledTimes(2);
  });
});
