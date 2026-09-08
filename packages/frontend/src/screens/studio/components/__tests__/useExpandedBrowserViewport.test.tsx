// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExpandedBrowserViewport } from "../useExpandedBrowserViewport";

class TestViewport extends EventTarget {
  height = 749;
  offsetTop = 0;
  scale = 1;
}

describe("expanded browser visual viewport", () => {
  let root: Root;
  let container: HTMLDivElement;
  let viewport: TestViewport;
  let frames: Map<number, FrameRequestCallback>;
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Content() {
    useEffect(() => { mounted(); return unmounted; }, []);
    return <input aria-label="Remote keyboard fixture" />;
  }
  function Harness({ active }: { active: boolean }) {
    return <section style={useExpandedBrowserViewport(active)}><Content /></section>;
  }
  const render = async (active = true) => act(async () => root.render(<Harness active={active} />));
  const flush = async () => act(async () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach((callback) => callback(0));
  });
  const style = () => container.querySelector("section")!.style;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted.mockClear(); unmounted.mockClear(); frames = new Map(); viewport = new TestViewport();
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 749);
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

  it("fits IME-only shrink and restoration without changing the layout viewport or remounting input", async () => {
    await render();
    const input = container.querySelector("input")!;
    input.focus();
    expect(style().height).toBe("749px");
    viewport.height = 386.2857;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    await flush();
    expect(window.innerHeight).toBe(749);
    expect(style().height).toBe("386px");
    expect(style().top).toBe("0px");
    expect(style().bottom).toBe("auto");
    expect(container.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(mounted).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled();
    viewport.height = 749;
    viewport.dispatchEvent(new Event("resize")); await flush();
    expect(style().height).toBe("749px");
  });

  it("uses CSS-pixel offset and height directly after visual-viewport pan or zoom", async () => {
    await render();
    viewport.height = 320; viewport.offsetTop = 54; viewport.scale = 2;
    viewport.dispatchEvent(new Event("scroll")); await flush();
    expect(style().height).toBe("320px");
    expect(style().top).toBe("54px");
    expect(style().width).toBe("");
  });

  it("falls back to layout height without VisualViewport and updates on orientation", async () => {
    vi.stubGlobal("visualViewport", undefined);
    await render(); expect(style().height).toBe("749px");
    vi.stubGlobal("innerHeight", 390);
    window.dispatchEvent(new Event("orientationchange")); await flush();
    expect(style().height).toBe("390px"); expect(style().top).toBe("0px");
  });

  it("rejects unusable visual measurements", async () => {
    viewport.height = Number.NaN; viewport.offsetTop = Number.NaN;
    await render(); expect(style().height).toBe("749px"); expect(style().top).toBe("0px");
    viewport.height = 0; viewport.offsetTop = -10;
    window.dispatchEvent(new Event("resize")); await flush();
    expect(style().height).toBe("749px"); expect(style().top).toBe("0px");
  });

  it("does not bind inactive viewers and cancels listeners and queued frames on collapse", async () => {
    const add = vi.spyOn(viewport, "addEventListener");
    const remove = vi.spyOn(viewport, "removeEventListener");
    await render(false); expect(add).not.toHaveBeenCalled(); expect(style().height).toBe("");
    await render(); expect(add.mock.calls.map(([event]) => event)).toEqual(["resize", "scroll"]);
    viewport.dispatchEvent(new Event("resize")); expect(frames.size).toBe(1);
    await render(false); expect(frames.size).toBe(0); expect(style().height).toBe("");
    expect(remove.mock.calls.map(([event]) => event)).toEqual(["resize", "scroll"]);
    viewport.dispatchEvent(new Event("resize")); expect(frames.size).toBe(0);
    await render(); viewport.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(null));
    expect(frames.size).toBe(0); expect(unmounted).toHaveBeenCalledOnce();
  });
});
