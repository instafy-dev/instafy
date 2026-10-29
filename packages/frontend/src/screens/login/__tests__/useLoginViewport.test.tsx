// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLoginViewport } from "../useLoginViewport";

class TestViewport extends EventTarget {
  height = 844;
  width = 390;
  offsetTop = 0;
  offsetLeft = 0;
}

describe("login document keyboard layout", () => {
  let root: Root;
  let container: HTMLDivElement;
  let viewport: TestViewport;
  let frames: Map<number, FrameRequestCallback>;
  const scrollBy = vi.fn();
  function Harness({ error = null }: { error?: string | null }) {
    const layout = useLoginViewport(true, "email", error);
    return <div ref={layout.pageRef} data-compact={layout.compact}
      style={{ minHeight: layout.visibleHeight, paddingBottom: layout.obscuredHeight }}>
      <form>
        {error ? <div role="alert">{error}</div> : null}
        <input defaultValue="kept@example.com" />
        <button type="submit">Continue</button>
      </form>
    </div>;
  }
  const render = async (error?: string) => act(async () => root.render(<Harness error={error} />));
  const flush = async () => act(async () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
  });
  const measure = (element: Element, top: number, height: number) => vi.spyOn(element, "getBoundingClientRect")
    .mockReturnValue({ x: 0, y: top, top, bottom: top + height, left: 0, right: 320, width: 320, height, toJSON: () => ({}) });
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    viewport = new TestViewport(); frames = new Map(); scrollBy.mockReset();
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 844);
    vi.stubGlobal("scrollBy", scrollBy);
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame; frames.set(id, callback); return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    for (const side of ["top", "right", "bottom", "left"]) document.documentElement.style.removeProperty(`--instafy-safe-area-inset-${side}`);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([false, true])("reveals the field and Continue without remounting or clearing the draft (layout resize: %s)", async resizeLayout => {
    await render();
    const input = container.querySelector("input")!;
    measure(input, 362, 46); measure(container.querySelector("button")!, 428, 44);
    input.focus(); await flush(); scrollBy.mockClear();
    viewport.height = 438;
    if (resizeLayout) vi.stubGlobal("innerHeight", 438);
    viewport.dispatchEvent(new Event("resize")); await flush();
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, 46);
    expect(container.firstElementChild?.getAttribute("data-compact")).toBe("true");
    expect((container.firstElementChild as HTMLElement).style.paddingBottom).toBe(resizeLayout ? "0px" : "406px");
    expect(container.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("kept@example.com");
    viewport.height = 844; vi.stubGlobal("innerHeight", 844);
    viewport.dispatchEvent(new Event("resize")); await flush();
    expect((container.firstElementChild as HTMLElement).style.paddingBottom).toBe("0px");
  });

  it("reveals controls inside native system-bar insets", async () => {
    viewport.height = 438;
    for (const [side, value] of Object.entries({ top: 24, right: 0, bottom: 16, left: 0 })) {
      document.documentElement.style.setProperty(`--instafy-safe-area-inset-${side}`, `${value}px`);
    }
    await render();
    const input = container.querySelector("input")!;
    measure(input, 362, 46); measure(container.querySelector("button")!, 428, 44);
    input.focus(); await flush();
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, 62);
    expect(document.activeElement).toBe(input);
  });

  it("prioritizes the field in a landscape viewport too short for both field and action", async () => {
    viewport.height = 140;
    await render();
    const input = container.querySelector("input")!;
    measure(input, 160, 46); measure(container.querySelector("button")!, 290, 44);
    input.focus(); await flush();
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, 78);
    expect(document.activeElement).toBe(input);
  });

  it("keeps an oversized field top-aligned instead of alternating edges on resize", async () => {
    viewport.height = 80;
    await render();
    const input = container.querySelector("input")!;
    let fieldTop = 50;
    vi.spyOn(input, "getBoundingClientRect").mockImplementation(() => ({
      x: 0, y: fieldTop, top: fieldTop, bottom: fieldTop + 80,
      left: 0, right: 320, width: 320, height: 80, toJSON: () => ({}),
    }));
    measure(container.querySelector("button")!, 200, 44);
    scrollBy.mockImplementation((_x: number, y: number) => { fieldTop -= y; });
    input.focus(); await flush();
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, 38);
    expect(fieldTop).toBe(12);
    for (const height of [81, 80, 81]) {
      viewport.height = height; viewport.dispatchEvent(new Event("resize")); await flush();
    }
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(fieldTop).toBe(12);
  });

  it("reveals an inserted form error together with its field and action when they fit", async () => {
    viewport.height = 438;
    await render();
    const input = container.querySelector("input")!;
    const button = container.querySelector("button")!;
    measure(input, 132, 46); measure(button, 200, 44);
    input.focus(); await flush(); scrollBy.mockClear();
    const readRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // The alert is measured by the layout effect as soon as React inserts it.
      return this.getAttribute("role") === "alert" ? new DOMRect(0, 4, 320, 112) : readRect.call(this);
    });
    await render("Try again");
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith(0, -8);
    const scrollOffset = scrollBy.mock.calls[0][1];
    for (const element of [container.querySelector('[role="alert"]')!, input, button]) {
      const rect = element.getBoundingClientRect();
      expect(rect.top - scrollOffset).toBeGreaterThanOrEqual(12);
      expect(rect.bottom - scrollOffset).toBeLessThanOrEqual(viewport.height - 12);
    }
    expect(document.activeElement).toBe(input);
  });

  it("does not move an already visible form or turn ordinary document scrolling into focus recovery", async () => {
    viewport.height = 438;
    await render();
    const input = container.querySelector("input")!;
    measure(input, 100, 46); measure(container.querySelector("button")!, 170, 44);
    input.focus(); await flush();
    window.dispatchEvent(new Event("scroll")); await flush();
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
