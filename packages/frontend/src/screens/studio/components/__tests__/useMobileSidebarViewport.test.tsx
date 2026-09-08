// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileSidebarViewport } from "../useMobileSidebarViewport";

class TestViewport extends EventTarget {
  height = 762;
  offsetTop = 0;
  scale = 1;
}

describe("mobile sidebar visible controls", () => {
  let root: Root;
  let container: HTMLDivElement;
  let viewport: TestViewport;
  let frames: Map<number, FrameRequestCallback>;
  function Harness() {
    const { controlsRef, style } = useMobileSidebarViewport();
    return <div ref={controlsRef} style={style}>
      <div data-sidebar-scrollport><input type="search" defaultValue="local marker" /><button>Back</button></div>
    </div>;
  }
  const render = async () => act(async () => root.render(<Harness />));
  const flush = async () => act(async () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach((callback) => callback(0));
  });
  const field = () => container.querySelector("input")!;
  const port = () => container.querySelector<HTMLElement>("[data-sidebar-scrollport]")!;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frames = new Map(); viewport = new TestViewport();
    vi.stubGlobal("visualViewport", viewport); vi.stubGlobal("innerHeight", 762);
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
  function installGeometry() {
    vi.spyOn(port(), "getBoundingClientRect").mockImplementation(() => ({ top: 60, height: 300 }) as DOMRect);
    vi.spyOn(field(), "getBoundingClientRect").mockImplementation(() => ({ top: 520 - port().scrollTop, height: 40 }) as DOMRect);
  }

  it("uses CSS-pixel visual bounds without changing the painted parent or applying zoom twice", async () => {
    await render();
    const controls = container.firstElementChild as HTMLElement;
    viewport.height = 360.5; viewport.offsetTop = 54.25; viewport.scale = 2;
    viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    await flush();
    expect(controls.style.top).toContain("54.25px");
    expect(controls.style.height).toContain("414.75px");
    expect(controls.style.width).toBe("");
    expect(container.style.height).toBe("");
    expect(window.innerHeight).toBe(762);
  });

  it("centers only the focused search with measured trailing space, preserving focus and value", async () => {
    await render(); installGeometry();
    const input = field(); input.focus(); await flush();
    expect(port().style.getPropertyValue("--sidebar-focused-search-space")).toBe("130px");
    expect(port().scrollTop).toBe(330);
    expect(document.activeElement).toBe(input); expect(input.value).toBe("local marker");
    viewport.height = 350; viewport.dispatchEvent(new Event("resize")); await flush();
    expect(port().scrollTop).toBe(330);
    expect(field()).toBe(input);
    input.blur(); await flush();
    expect(port().style.getPropertyValue("--sidebar-focused-search-space")).toBe("");
  });

  it("rechecks focus after a queued resize instead of moving a stale search", async () => {
    await render(); installGeometry(); field().focus(); await flush();
    port().scrollTop = 10;
    viewport.dispatchEvent(new Event("resize"));
    container.querySelector("button")!.focus(); await flush();
    expect(port().scrollTop).toBe(10);
    expect(port().style.getPropertyValue("--sidebar-focused-search-space")).toBe("");
  });

  it("leaves focused controls outside the drawer and non-scrollport inputs alone", async () => {
    await render(); installGeometry();
    const external = document.createElement("input"); external.type = "search"; document.body.append(external);
    external.focus(); viewport.dispatchEvent(new Event("resize")); await flush();
    expect(port().scrollTop).toBe(0);
    expect(port().style.getPropertyValue("--sidebar-focused-search-space")).toBe("");
    external.remove();
    port().removeAttribute("data-sidebar-scrollport"); field().focus(); await flush();
    expect(container.querySelector("input")!.parentElement!.scrollTop).toBe(0);
  });

  it("falls back to the layout height without a valid visual viewport", async () => {
    viewport.height = Number.NaN; viewport.offsetTop = Number.NaN;
    await render();
    const controls = container.firstElementChild as HTMLElement;
    expect(controls.style.height).toContain("762px"); expect(controls.style.top).toContain("0px");
  });

  it("clears spacing if a focused search is removed without a focusout event", async () => {
    await render(); installGeometry(); field().focus(); await flush();
    const scrollport = port();
    await act(async () => field().remove());
    await flush();
    expect(scrollport.style.getPropertyValue("--sidebar-focused-search-space")).toBe("");
  });

  it("clears scoped spacing, listeners and pending frames when closed", async () => {
    await render(); installGeometry(); field().focus(); await flush();
    const scrollport = port();
    viewport.dispatchEvent(new Event("resize")); expect(frames.size).toBe(1);
    await act(async () => root.render(null));
    expect(frames.size).toBe(0);
    expect(scrollport.style.getPropertyValue("--sidebar-focused-search-space")).toBe("");
    viewport.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("orientationchange"));
    expect(frames.size).toBe(0);
  });
});
