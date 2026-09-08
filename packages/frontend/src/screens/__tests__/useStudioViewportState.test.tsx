// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioViewportState } from "../useStudioViewportState";

class TestViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
}

describe("Studio viewport and software-keyboard state", () => {
  let root: Root;
  let container: HTMLDivElement;
  let viewport: TestViewport;
  let frames: Map<number, FrameRequestCallback>;
  let state: ReturnType<typeof useStudioViewportState>;
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Editor() {
    useEffect(() => { mounted(); return unmounted; }, []);
    return <input aria-label="Inert draft" defaultValue="kept draft" />;
  }
  function Harness({ trackKeyboard = true }: { trackKeyboard?: boolean }) {
    state = useStudioViewportState({ trackKeyboard });
    return <><Editor /><button>Navigation</button></>;
  }
  const render = async (trackKeyboard = true) => {
    await act(async () => root.render(<Harness trackKeyboard={trackKeyboard} />));
    await flush();
  };
  const flush = async () => act(async () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
  });
  const resize = async (height: number, layoutHeight = window.innerHeight, offsetTop = 0) => {
    viewport.height = height; viewport.offsetTop = offsetTop;
    vi.stubGlobal("innerHeight", layoutHeight);
    window.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("resize"));
    await flush();
  };
  const focus = async (element: HTMLElement = container.querySelector("input")!) => {
    element.focus(); await flush();
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted.mockClear(); unmounted.mockClear(); frames = new Map(); viewport = new TestViewport();
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 800); vi.stubGlobal("innerWidth", 400);
    vi.stubGlobal("screen", { orientation: { type: "portrait-primary", angle: 0 } });
    vi.stubGlobal("scrollX", 0); vi.stubGlobal("scrollY", 0); vi.stubGlobal("scrollTo", vi.fn());
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrame; frames.set(id, callback); return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("preserves the existing rounded Studio height and page-pan correction", async () => {
    viewport.height = 449.14;
    vi.stubGlobal("scrollX", 12); vi.stubGlobal("scrollY", 376);
    await render(false);
    expect(state).toEqual({ viewportHeightPx: 449, keyboardOpen: false });
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("does not hide navigation for focus or hardware-keyboard typing alone", async () => {
    await render(); await focus();
    const input = container.querySelector("input")!;
    input.value = "inert hardware-keyboard draft"; input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.keyboardOpen).toBe(false);
    expect(document.activeElement).toBe(input);
    await resize(755);
    expect(state.keyboardOpen).toBe(false); // normal browser/status chrome, not IME
  });

  it("detects iOS visual-only shrink and restores while the editor stays focused", async () => {
    await render(); await focus();
    const input = container.querySelector("input")!;
    await resize(430);
    expect(state).toEqual({ viewportHeightPx: 430, keyboardOpen: true });
    expect(window.innerHeight).toBe(800);
    await resize(800);
    expect(state.keyboardOpen).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("kept draft");
    expect(container.querySelector("input")).toBe(input);
    expect(mounted).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled();
  });

  it("detects Android layout+visual resize without mistaking the short height for landscape", async () => {
    await render(); await focus();
    await resize(330, 330);
    expect(window.innerWidth).toBeGreaterThan(window.innerHeight);
    expect(state.keyboardOpen).toBe(true);
    await resize(800, 800);
    expect(state.keyboardOpen).toBe(false);
  });

  it("does not ratchet the closed baseline down through individually small IME animation frames", async () => {
    await render(); await focus();
    for (const height of [770, 730, 690, 650, 600, 500]) await resize(height, height);
    expect(state.keyboardOpen).toBe(true);
    container.querySelector("input")!.blur(); await flush();
    await resize(700, 700); // closing animation drops below the open threshold
    expect(state.keyboardOpen).toBe(false);
    await focus(); await resize(620, 620);
    expect(state.keyboardOpen).toBe(true); // the true closed800 baseline survives
    await resize(800, 800);
    expect(state.keyboardOpen).toBe(false);
  });

  it("does not overwrite the closed baseline when blur precedes the IME close animation", async () => {
    await render(); await focus(); await resize(430, 430);
    container.querySelector("input")!.blur(); await flush();
    expect(state.keyboardOpen).toBe(true);
    await resize(500, 500);
    expect(state.keyboardOpen).toBe(true);
    await resize(800, 800);
    expect(state.keyboardOpen).toBe(false);
    await focus(); await resize(430, 430);
    expect(state.keyboardOpen).toBe(true);
  });

  it("ignores viewport shrink without a focused text editor", async () => {
    await render(); await focus(container.querySelector("button")!);
    await resize(430);
    expect(state.keyboardOpen).toBe(false);
  });

  it.each(["checkbox", "button", "range", "date"])("does not treat %s inputs as software text keyboards", async type => {
    await render(); const input = container.querySelector("input")!; input.type = type;
    await focus(input); await resize(430);
    expect(state.keyboardOpen).toBe(false);
  });

  it("does not treat a read-only editor as an opening keyboard", async () => {
    await render(); const input = container.querySelector("input")!; input.readOnly = true;
    await focus(input); await resize(430);
    expect(state.keyboardOpen).toBe(false);
  });

  it("recognizes editable focus in a portal without reading its value", async () => {
    await render();
    const input = document.createElement("textarea"); document.body.append(input);
    Object.defineProperty(input, "value", { get: () => { throw Error("must not read field value"); } });
    try { await focus(input); await resize(430); expect(state.keyboardOpen).toBe(true); }
    finally { input.remove(); }
  });

  it("recognizes contenteditable focus inside an open shadow root", async () => {
    await render(); const host = document.createElement("div"); container.append(host);
    const editor = document.createElement("div"); editor.tabIndex = 0;
    Object.defineProperty(editor, "isContentEditable", { value: true });
    host.attachShadow({ mode: "open" }).append(editor);
    await focus(editor); await resize(430);
    expect(state.keyboardOpen).toBe(true);
  });

  it("does not mistake pinch zoom for a keyboard or poison the unzoomed baseline", async () => {
    await render(); await focus(); viewport.scale = 2; await resize(400);
    expect(state).toEqual({ viewportHeightPx: 400, keyboardOpen: false });
    viewport.scale = 1; await resize(800);
    expect(state.keyboardOpen).toBe(false);
    await resize(430);
    expect(state.keyboardOpen).toBe(true);
  });

  it("accounts for visual-viewport pan instead of counting its offset as additional occlusion", async () => {
    await render(); await focus(); await resize(430, 800, 370);
    expect(state.keyboardOpen).toBe(false);
    await resize(430, 800, 20);
    expect(state.keyboardOpen).toBe(true);
  });

  it("uses an independent baseline after a width/orientation change", async () => {
    await render(); await focus(); await resize(430, 430);
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("screen", { orientation: { type: "landscape-primary", angle: 90 } });
    window.dispatchEvent(new Event("orientationchange")); await resize(390, 390);
    expect(state.keyboardOpen).toBe(false);
    await resize(220, 220);
    expect(state.keyboardOpen).toBe(true);
    await resize(390, 390);
    expect(state.keyboardOpen).toBe(false);
  });

  it("does not use the full physical display as the split-screen baseline", async () => {
    vi.stubGlobal("innerHeight", 500); viewport.height = 500;
    await render(); await focus();
    expect(state.keyboardOpen).toBe(false);
    await resize(300, 300); expect(state.keyboardOpen).toBe(true);
  });

  it("keeps desktop viewport updates but never reports keyboard visibility when tracking is disabled", async () => {
    await render(false); await focus(); await resize(430, 430);
    expect(state).toEqual({ viewportHeightPx: 430, keyboardOpen: false });
    await resize(800, 800); await render(); await resize(430, 430);
    expect(state.keyboardOpen).toBe(true);
    await render(false);
    expect(state.keyboardOpen).toBe(false);
  });

  it("falls back to layout viewport resize when VisualViewport is unavailable", async () => {
    vi.stubGlobal("visualViewport", undefined);
    await render(); await focus(); await resize(430, 430);
    expect(state).toEqual({ viewportHeightPx: 430, keyboardOpen: true });
    await resize(800, 800); expect(state.keyboardOpen).toBe(false);
  });

  it("rejects invalid geometry and recovers on the next usable viewport", async () => {
    await render(); await focus(); await resize(Number.NaN);
    expect(state).toEqual({ viewportHeightPx: null, keyboardOpen: false });
    await resize(430); expect(state.keyboardOpen).toBe(true);
  });

  it("coalesces event bursts and removes its only viewport listener set and pending RAF on unmount", async () => {
    const add = vi.spyOn(viewport, "addEventListener");
    const remove = vi.spyOn(viewport, "removeEventListener");
    await render();
    expect(add.mock.calls.map(([event]) => event)).toEqual(["resize", "scroll"]);
    window.dispatchEvent(new Event("focusin")); window.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    await act(async () => root.render(null));
    expect(frames.size).toBe(0);
    expect(remove.mock.calls.map(([event]) => event)).toEqual(["resize", "scroll"]);
    window.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(0);
  });
});
