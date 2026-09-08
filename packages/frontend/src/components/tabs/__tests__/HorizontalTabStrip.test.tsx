// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HorizontalTabStrip } from "../HorizontalTabStrip";

describe("HorizontalTabStrip active visibility", () => {
  let container: HTMLDivElement;
  let root: Root;
  let availableWidth: number;
  let activeStart: number;
  let contentWidth: number;
  let observeResize: (() => void) | null;
  const activeWidth = 200;

  const viewport = () => container.querySelector<HTMLDivElement>(".test-viewport")!;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    availableWidth = 1600;
    activeStart = 1000;
    contentWidth = 1200;
    observeResize = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("test-viewport")) return 0;
      return Math.max(0, availableWidth - container.querySelectorAll("[data-scroll-control]").length * 40);
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("test-viewport") && availableWidth > 0 ? contentWidth : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("test-viewport")) return new DOMRect(0, 0, this.clientWidth, 40);
      if (this.getAttribute("data-tab-id") === "preview") return new DOMRect(activeStart - viewport().scrollLeft, 0, activeWidth, 40);
      return new DOMRect();
    });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        observeResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() { observeResize = null; }
      unobserve() {}
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render({ includeActive = true, label = "Preview" } = {}) {
    await act(async () => root.render(
      <HorizontalTabStrip
        activeItemId="preview"
        viewportClassName="test-viewport"
        renderScrollControl={({ direction, scrollByDirection }) => (
          <button data-scroll-control={direction} onClick={() => scrollByDirection(direction)}>Scroll</button>
        )}
      >
        <span data-tab-id="kept">Kept chat</span>
        {includeActive ? <span data-tab-id="preview">{label}</span> : null}
      </HorizontalTabStrip>,
    ));
  }

  function expectActiveVisible() {
    expect(viewport().scrollLeft).toBeLessThanOrEqual(activeStart);
    expect(viewport().scrollLeft + viewport().clientWidth).toBeGreaterThanOrEqual(activeStart + activeWidth);
  }

  it("reveals the unchanged active tab after hidden navigation becomes visible and controls take space", async () => {
    availableWidth = 0;
    await render();
    expect(viewport().scrollLeft).toBe(0);
    availableWidth = 550;
    await act(async () => observeResize?.());
    expect(container.querySelectorAll("[data-scroll-control]")).toHaveLength(2);
    expect(viewport().clientWidth).toBe(470);
    expectActiveVisible();
  });

  it("reveals the active tab when the window or preceding content changes size", async () => {
    await render();
    availableWidth = 550;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expectActiveVisible();

    activeStart = 1300;
    contentWidth = 1500;
    await act(async () => observeResize?.());
    expectActiveVisible();
  });

  it("reveals a restored active tab inserted after its ID without needing a content resize", async () => {
    availableWidth = 550;
    await render({ includeActive: false });
    expect(viewport().scrollLeft).toBe(0);
    await render();
    expectActiveVisible();
  });

  it("preserves manual wheel, scroll-control and native scrolling through ordinary rerenders", async () => {
    availableWidth = 550;
    await render();
    const node = viewport();
    const originalLeft = node.scrollLeft;
    await act(async () => node.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true })));
    expect(node.scrollLeft).toBe(originalLeft - 100);

    node.scrollBy = vi.fn((options?: ScrollToOptions | number) => {
      node.scrollLeft += typeof options === "number" ? options : options?.left ?? 0;
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-scroll-control="-1"]')?.click());
    expect(node.scrollBy).toHaveBeenCalledWith({ left: -329, behavior: "smooth" });
    const manualLeft = node.scrollLeft;
    await act(async () => node.dispatchEvent(new Event("scroll")));
    await render({ label: "Updated preview title" });
    expect(node.scrollLeft).toBe(manualLeft);
  });
});
