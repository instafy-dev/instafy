// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatImageViewport } from "../useChatImageViewport";

describe("local image viewport interactions", () => {
  let root: Root;
  let host: HTMLDivElement;
  let canvas: HTMLDivElement;
  let image: HTMLImageElement;
  let viewport: ReturnType<typeof useChatImageViewport>;
  let immersive: boolean;
  let size: { width: number; height: number };
  let observer: () => void;
  let visualViewport: EventTarget & { scale: number };
  let now: number;
  const dismiss = vi.fn();
  const imageTap = vi.fn();

  function Harness() {
    viewport = useChatImageViewport({ immersive, onDismiss: dismiss, onImageTap: imageTap });
    return <div ref={viewport.viewportRef} data-canvas tabIndex={0} {...viewport.handlers}>
      <img onLoad={viewport.onImageLoad} style={viewport.imageStyle} alt="Preview" />
      <button>Other control</button>
    </div>;
  }
  async function mount(width = 1000, height = 1000) {
    await act(async () => root.render(<Harness />));
    canvas = host.querySelector("[data-canvas]")!;
    image = host.querySelector("img")!;
    Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    await act(async () => image.dispatchEvent(new Event("load")));
    expect(viewport.ready).toBe(true);
  }
  async function pointer(type: string, id: number, x: number, y: number, pointerType = "touch", target?: Element) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } });
    await act(async () => (target ?? canvas).dispatchEvent(event));
  }
  async function click(x: number, y: number) {
    await act(async () => canvas.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y })));
  }
  function xy() {
    const result = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(String(viewport.imageStyle.transform))!;
    return { x: Number(result[1]), y: Number(result[2]) };
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    immersive = true;
    size = { width: 400, height: 400 };
    now = 1000;
    dismiss.mockReset();
    imageTap.mockReset();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ ...size, left: 0, top: 0, right: size.width, bottom: size.height, x: 0, y: 0, toJSON() {} }));
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observer = callback; } observe() {} disconnect() {} });
    visualViewport = Object.assign(new EventTarget(), { scale: 1 });
    vi.stubGlobal("visualViewport", visualViewport);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("ignores image-origin compatibility clicks retargeted to canvas and supports double tap", async () => {
    await mount();
    await pointer("pointerdown", 1, 200, 200);
    await pointer("pointerup", 1, 200, 200);
    await click(200, 200);
    expect(dismiss).not.toHaveBeenCalled();
    now += 150;
    await pointer("pointerdown", 2, 200, 200);
    await pointer("pointerup", 2, 200, 200);
    await click(200, 200);
    expect(viewport.scale).toBe(0.4);
    expect(viewport.mode).toBe("width");
    await act(async () => canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 200, clientY: 200 })));
    expect(viewport.mode).toBe("width"); // Do not also toggle the touch compatibility dblclick.
    expect(dismiss).not.toHaveBeenCalled();
  });

  it.each([[1200, 7200, 400 / 7200], [1200, 600, 400 / 1200]])(
    "double-taps a %s by %s image to width and back, including equal-scale fits",
    async (width, height, overviewScale) => {
      await mount(width, height);
      expect(viewport.scale).toBeCloseTo(overviewScale);
      const doubleTap = async (firstId: number) => {
        for (const id of [firstId, firstId + 1]) {
          await pointer("pointerdown", id, 200, 200);
          await pointer("pointerup", id, 200, 200);
          await click(200, 200);
          now += 150;
        }
      };
      await doubleTap(1);
      expect(viewport.mode).toBe("width");
      expect(viewport.scale).toBeCloseTo(400 / width);
      expect(xy()).toEqual({ x: 0, y: height > width ? 0 : 100 });
      const doubleTapped = viewport.imageStyle.transform;
      await act(async () => viewport.fitOverview());
      await act(async () => viewport.fitWidth());
      expect(viewport.imageStyle.transform).toBe(doubleTapped);
      now += 500;
      await doubleTap(3);
      expect(viewport.mode).toBe("overview");
      expect(viewport.scale).toBeCloseTo(overviewScale);
      expect(dismiss).not.toHaveBeenCalled();
      expect(imageTap).not.toHaveBeenCalled();
    },
  );

  it("keeps desktop double-click zoom anchored at the clicked point", async () => {
    immersive = false;
    await mount();
    await act(async () => canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 100, clientY: 150 })));
    expect(viewport.mode).toBe("manual");
    expect(viewport.scale).toBe(1);
    expect(xy()).toEqual({ x: -150, y: -225 });
    await act(async () => canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 100, clientY: 150 })));
    expect(viewport.mode).toBe("overview");
    expect(viewport.scale).toBe(0.4);
  });

  it("pinches around the midpoint and rebases the remaining finger to pan without dismissing", async () => {
    await mount();
    await pointer("pointerdown", 1, 100, 200);
    await pointer("pointerdown", 2, 300, 200);
    await pointer("pointermove", 1, 50, 200);
    await pointer("pointermove", 2, 350, 200);
    expect(viewport.scale).toBeCloseTo(0.6);
    expect(xy()).toEqual({ x: -100, y: -100 });
    await pointer("pointerup", 1, 50, 200);
    await pointer("pointermove", 2, 400, 250);
    expect(xy()).toEqual({ x: -50, y: -50 });
    await pointer("pointerup", 2, 400, 350);
    await click(400, 350);
    expect(dismiss).not.toHaveBeenCalled();
    expect(viewport.isInteracting).toBe(false);
  });

  it("allows only a downward overview touch swipe to dismiss", async () => {
    await mount();
    for (const [id, dx, dy, type] of [[1, 100, 100, "touch"], [2, 0, -100, "touch"], [3, 0, 100, "mouse"]] as const) {
      await pointer("pointerdown", id, 100, 100, type);
      await pointer("pointermove", id, 100 + dx, 100 + dy, type);
      await pointer("pointerup", id, 100 + dx, 100 + dy, type);
      await click(100 + dx, 100 + dy);
    }
    expect(dismiss).not.toHaveBeenCalled();
    await pointer("pointerdown", 4, 200, 100);
    await pointer("pointermove", 4, 205, 190);
    expect(viewport.dismissOffset).toBe(90);
    await pointer("pointerup", 4, 205, 190);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps fit width separate from overview even if both have the same scale", async () => {
    await mount(1000, 500);
    await act(async () => viewport.fitWidth());
    expect(viewport.scale).toBe(0.4);
    expect(viewport.mode).toBe("width");
    await pointer("pointerdown", 1, 200, 100);
    await pointer("pointermove", 1, 200, 200);
    await pointer("pointerup", 1, 200, 200);
    await click(10, 10);
    expect(dismiss).not.toHaveBeenCalled();
    await act(async () => viewport.zoomOut());
    expect(viewport.mode).toBe("overview");
  });

  it("suppresses cancelled, lost-capture and rotation-interrupted gestures until held pointers end", async () => {
    await mount();
    await pointer("pointerdown", 1, 200, 100);
    await pointer("pointermove", 1, 200, 150);
    await act(async () => { size = { width: 500, height: 300 }; observer(); });
    await pointer("pointerdown", 2, 200, 100); // First finger is still down after rotation.
    await pointer("pointermove", 2, 200, 250);
    await pointer("pointerup", 2, 200, 250);
    await pointer("pointerup", 1, 200, 150);
    await click(10, 10);
    expect(dismiss).not.toHaveBeenCalled();
    for (const [id, cancelType] of [[3, "pointercancel"], [4, "lostpointercapture"]] as const) {
      await pointer("pointerdown", id, 200, 100);
      await pointer("pointermove", id, 200, 200);
      await pointer(cancelType, id, 200, 200);
      await pointer("pointerup", id, 200, 200);
      await click(10, 10);
      expect(viewport.isInteracting).toBe(false);
    }
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("handles modifier wheel zoom, ordinary wheel pan and keyboard controls only on the canvas", async () => {
    immersive = false;
    await mount();
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 200, clientY: 200, deltaY: -100, ctrlKey: true });
    await act(async () => canvas.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(viewport.scale).toBeGreaterThan(0.4);
    const before = xy().y;
    await act(async () => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 25 })));
    expect(xy().y).toBeLessThan(before);
    const modifier = new KeyboardEvent("keydown", { key: "+", ctrlKey: true, bubbles: true, cancelable: true });
    const scale = viewport.scale;
    await act(async () => canvas.dispatchEvent(modifier));
    expect(modifier.defaultPrevented).toBe(false);
    expect(viewport.scale).toBe(scale);
    await act(async () => host.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true })));
    expect(viewport.scale).toBe(scale);
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true })));
    expect(viewport.mode).toBe("overview");
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true })));
    expect(viewport.scale).toBe(1);
    await pointer("pointerdown", 1, 200, 200, "pen");
    const position = xy();
    await pointer("pointermove", 1, 225, 230, "pen");
    expect(xy()).toEqual({ x: position.x + 25, y: position.y + 30 });
  });

  it("allows a clean blank tap only in immersive overview and yields while the browser page is zoomed", async () => {
    await mount(100, 200);
    visualViewport.scale = 2;
    await act(async () => visualViewport.dispatchEvent(new Event("resize")));
    expect(viewport.pageZoomed).toBe(true);
    await pointer("pointerdown", 1, 10, 10);
    await pointer("pointerup", 1, 10, 10);
    await click(10, 10);
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, ctrlKey: true });
    await act(async () => canvas.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(false);
    expect(dismiss).not.toHaveBeenCalled();
    visualViewport.scale = 1;
    await act(async () => visualViewport.dispatchEvent(new Event("resize")));
    await pointer("pointerdown", 2, 10, 10, "mouse");
    await pointer("pointerup", 2, 10, 10, "mouse");
    await click(10, 10);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  describe("deliberate single image taps", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));

    async function advance(ms: number) {
      now += ms;
      await act(async () => vi.advanceTimersByTime(ms));
    }
    async function tap(id: number, pointerType = "touch") {
      await pointer("pointerdown", id, 200, 200, pointerType, image);
      await pointer("pointerup", id, 200, 200, pointerType);
      // Even a compatibility click with detail zero must not duplicate or
      // prematurely deliver the pointer-up action.
      await act(async () => image.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 200 })));
    }

    it("delivers one touch tap after the double-tap window, then allows a separate next tap", async () => {
      await mount();
      await tap(1);
      expect(imageTap).not.toHaveBeenCalled();
      await advance(299);
      expect(imageTap).not.toHaveBeenCalled();
      await advance(1);
      expect(imageTap).toHaveBeenCalledTimes(1);
      await tap(2);
      await advance(300);
      expect(imageTap).toHaveBeenCalledTimes(2);
      expect(viewport.mode).toBe("overview");
      expect(dismiss).not.toHaveBeenCalled();
    });

    it("preserves two deliberate touch taps when the browser also sends a compatibility double-click", async () => {
      await mount();
      await tap(1);
      await advance(400);
      expect(imageTap).toHaveBeenCalledTimes(1);
      await tap(2);
      // Browser double-click timing can be longer than the image's 300ms
      // double-tap window. That compatibility event must not cancel this tap.
      await act(async () => canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 200, clientY: 200 })));
      await advance(300);
      expect(imageTap).toHaveBeenCalledTimes(2);
      expect(viewport.mode).toBe("overview");
      expect(dismiss).not.toHaveBeenCalled();
    });

    it("never delivers the first or second touch tap of double-tap zoom", async () => {
      await mount();
      await tap(1);
      await advance(150);
      await tap(2);
      expect(viewport.mode).toBe("width");
      await advance(1000);
      expect(imageTap).not.toHaveBeenCalled();
    });

    it.each(["touch", "mouse", "pen"])("moves retained toolbar focus to the image region on a %s press", async (pointerType) => {
      await mount();
      host.querySelector("button")!.focus();
      expect(document.activeElement).not.toBe(canvas);
      await pointer("pointerdown", 1, 200, 200, pointerType, image);
      expect(document.activeElement).toBe(canvas);
      await pointer("pointerup", 1, 200, 200, pointerType);
      await advance(pointerType === "touch" ? 300 : 500);
      expect(imageTap).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(canvas);
    });

    it("delays mouse and pen taps and cancels native double-click zoom", async () => {
      immersive = false;
      await mount();
      await tap(0);
      await advance(300);
      expect(imageTap).toHaveBeenCalledTimes(1);
      imageTap.mockClear();
      await tap(1, "mouse");
      await advance(499);
      expect(imageTap).not.toHaveBeenCalled();
      await advance(1);
      expect(imageTap).toHaveBeenCalledTimes(1);
      imageTap.mockClear();
      await tap(2, "mouse");
      await advance(150);
      await tap(3, "mouse");
      await act(async () => canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 200, clientY: 200 })));
      await advance(1000);
      expect(imageTap).not.toHaveBeenCalled();
      expect(viewport.scale).toBe(1);
      await tap(4, "pen");
      await advance(500);
      expect(imageTap).toHaveBeenCalledTimes(1);
    });

    it.each(["movement", "pinch", "cancel", "capture", "resize", "key", "fit", "zoom", "wheel", "unmount"])("cancels a pending tap when %s begins", async (action) => {
      await mount();
      await tap(1);
      await advance(100);
      if (action === "movement" || action === "pinch") {
        await pointer("pointerdown", 2, 100, 200);
        if (action === "pinch") await pointer("pointerdown", 3, 300, 200);
        await pointer("pointermove", 2, 50, 200);
        await pointer("pointerup", 2, 50, 200);
        if (action === "pinch") {
          await pointer("pointermove", 3, 300, 300);
          await pointer("pointerup", 3, 300, 300);
        }
      } else if (action === "cancel" || action === "capture") {
        await pointer("pointerdown", 2, 200, 200);
        await pointer(action === "cancel" ? "pointercancel" : "lostpointercapture", 2, 200, 200);
        await pointer("pointerup", 2, 200, 200);
      } else if (action === "resize") await act(async () => { size = { width: 500, height: 300 }; observer(); });
      else if (action === "key") await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" })));
      else if (action === "fit") await act(async () => viewport.fitWidth());
      else if (action === "zoom") await act(async () => viewport.zoomIn());
      else if (action === "wheel") await act(async () => canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 10 })));
      else await act(async () => root.render(null));
      await advance(1000);
      expect(imageTap).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
    });

    it("supports standalone assistive image activation but keeps blank overview taps as dismissal", async () => {
      await mount(100, 200);
      await act(async () => image.click());
      expect(imageTap).toHaveBeenCalledTimes(1);
      await pointer("pointerdown", 1, 10, 10);
      await pointer("pointerup", 1, 10, 10);
      await click(10, 10);
      await advance(1000);
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(imageTap).toHaveBeenCalledTimes(1);
    });

    it.each(["cancel", "drag", "pinch"])("accepts assistive activation after a %s sequence that produced no click", async (action) => {
      await mount();
      await pointer("pointerdown", 1, 200, 200);
      if (action === "cancel") await pointer("pointercancel", 1, 200, 200);
      else if (action === "drag") {
        await pointer("pointermove", 1, 250, 200);
        await pointer("pointerup", 1, 250, 200);
      } else {
        await pointer("pointerdown", 2, 300, 200);
        await pointer("pointermove", 2, 350, 200);
        await pointer("pointerup", 2, 350, 200);
        await pointer("pointerup", 1, 200, 200);
      }
      await act(async () => image.click());
      expect(imageTap).toHaveBeenCalledTimes(1);
      await advance(1000);
      expect(imageTap).toHaveBeenCalledTimes(1);
    });
  });
});
