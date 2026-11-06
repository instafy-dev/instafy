// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatImageLightboxOverlay } from "../ChatImageLightbox";
import { STUDIO_MEDIA_IMMERSIVE_QUERY } from "../../../../components/aria/studioMediaLayout";

describe("image inspection controls", () => {
  let root: Root;
  let container: HTMLDivElement;
  let immersive: boolean;
  let mediaListeners: Set<() => void>;
  const onClose = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    immersive = true;
    mediaListeners = new Set();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query === STUDIO_MEDIA_IMMERSIVE_QUERY && immersive; },
      media: query,
      addEventListener: (_: string, listener: () => void) => { if (query === STUDIO_MEDIA_IMMERSIVE_QUERY) mediaListeners.add(listener); },
      removeEventListener: (_: string, listener: () => void) => { mediaListeners.delete(listener); },
      addListener: vi.fn(), removeListener: vi.fn(),
    }));
    onClose.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const stage = () => document.querySelector<HTMLElement>('[data-testid="chat-image-lightbox-stage"]')!;
  const image = () => document.querySelector<HTMLImageElement>('[data-testid="chat-image-lightbox-image"]')!;
  const close = () => document.querySelector<HTMLButtonElement>('[data-testid="chat-image-lightbox-close"]')!;
  const button = (name: string) => document.querySelector<HTMLButtonElement>(`[data-testid="chat-image-${name}"]`)!;
  const scale = () => Number(/scale\(([^)]+)\)/.exec(image().style.transform)![1]);
  async function press(name: string) {
    await act(async () => button(name).click());
  }
  async function open() {
    await act(async () => root.render(<ChatImageLightboxOverlay imageLightbox={{ src: "/image.png", alt: "Original screenshot" }} onClose={onClose} />));
    stage().getBoundingClientRect = () => ({ x: 16, y: 72, left: 16, top: 72, width: 300, height: 600, right: 316, bottom: 672, toJSON() {} });
    Object.defineProperties(image(), { naturalWidth: { value: 600 }, naturalHeight: { value: 2400 } });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      image().dispatchEvent(new Event("load"));
    });
  }

  const controls = () => document.querySelector<HTMLElement>('[data-testid="chat-image-controls"]')!;

  it("starts mobile controls hidden but reveals them for keyboard focus and assistive activation", async () => {
    await open();
    expect(controls().dataset.visible).toBe("false");
    expect(close()).not.toBeNull();
    expect(button("actual-size").tabIndex).toBe(0);
    expect(controls().getAttribute("aria-hidden")).toBeNull();
    await act(async () => button("fit-width").focus());
    expect(controls().dataset.visible).toBe("true");
    expect(document.activeElement).toBe(button("fit-width"));
    await act(async () => image().click());
    expect(controls().dataset.visible).toBe("true");
    expect(document.activeElement).toBe(button("fit-width"));
  });

  it("reveals controls on assistive button activation without a focus event", async () => {
    await open();
    expect(controls().dataset.visible).toBe("false");
    await press("actual-size");
    expect(controls().dataset.visible).toBe("true");
    expect(scale()).toBe(1);
  });

  it("keeps desktop controls visible", async () => {
    immersive = false;
    await open();
    expect(controls().dataset.visible).toBe("true");
    expect(controls().dataset.immersive).toBe("false");
  });

  it("offers overview, readable width and original pixels without modifying the attachment", async () => {
    await open();
    expect(scale()).toBe(0.25);
    expect(stage().tabIndex).toBe(0);
    expect(stage().getAttribute("aria-description")).toContain("arrows pan");
    await press("fit-width");
    expect(scale()).toBe(0.5);
    expect(button("fit-width").hasAttribute("aria-pressed")).toBe(false);
    const widthFit = image().style.transform;
    await act(async () => stage().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(image().style.transform).not.toBe(widthFit);
    await press("fit-width");
    expect(image().style.transform).toBe(widthFit);
    await press("actual-size");
    expect(scale()).toBe(1);
    expect(button("actual-size").textContent).toBe("100%");
    expect(document.getElementById(button("actual-size").getAttribute("aria-describedby")!)?.textContent).toBe("Current zoom: 100%");
    await press("fit");
    expect(scale()).toBe(0.25);
    expect(image().getAttribute("src")).toBe("/image.png");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus on zoom controls when a zoom boundary is reached", async () => {
    await open();
    const zoomIn = button("zoom-in");
    await act(async () => zoomIn.focus());
    for (let i = 0; i < 12; i += 1) await press("zoom-in");
    expect(zoomIn.getAttribute("aria-disabled")).toBe("true");
    expect(zoomIn.disabled).toBe(false);
    expect(document.activeElement).toBe(zoomIn);
    const maximum = scale();
    await press("zoom-in");
    expect(scale()).toBe(maximum);
    await press("fit");
    expect(button("zoom-out").getAttribute("aria-disabled")).toBe("true");
  });

  it("retains the image and focused controls through mobile/desktop layout changes", async () => {
    await open();
    const originalImage = image();
    for (const control of [close(), button("fit-width")]) {
      await act(async () => control.focus());
      for (const next of [false, true]) {
        await act(async () => { immersive = next; mediaListeners.forEach(listener => listener()); });
        expect(image()).toBe(originalImage);
        expect(document.activeElement).toBe(control);
        expect(stage().dataset.immersive).toBe(String(next));
      }
    }
  });

  it("supports inspection shortcuts and shared dialog Escape dismissal", async () => {
    await open();
    await act(async () => stage().focus());
    const key = async (value: string) => act(async () => stage().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
    await key("1");
    expect(controls().dataset.visible).toBe("true");
    expect(scale()).toBe(1);
    const before = image().style.transform;
    await key("ArrowDown");
    expect(image().style.transform).not.toBe(before);
    await key("0");
    expect(stage().dataset.mode).toBe("overview");
    const fitted = image().style.transform;
    await key(" ");
    expect(controls().dataset.visible).toBe("false");
    expect(document.activeElement).toBe(stage());
    expect(image().style.transform).toBe(fitted);
    await key("Enter");
    expect(controls().dataset.visible).toBe("true");
    await key("Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
