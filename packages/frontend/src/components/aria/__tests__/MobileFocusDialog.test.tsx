// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileFocusDialog } from "../MobileFocusDialog";

const native = vi.hoisted(() => ({
  platform: vi.fn(() => "web"),
  listen: vi.fn(),
  remove: vi.fn(async () => {}),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: native.platform } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: native.listen } }));

describe("MobileFocusDialog", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onOpenChange = vi.fn();
  let viewport: EventTarget & { offsetTop: number; offsetLeft: number; width: number; height: number; scale: number };
  let onBack: (() => void) | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    native.platform.mockReturnValue("web");
    native.listen.mockImplementation(async (_name: string, listener: () => void) => {
      onBack = listener;
      return { remove: native.remove };
    });
    onBack = undefined;
    viewport = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, width: 390, height: 844, scale: 1 });
    vi.stubGlobal("visualViewport", viewport);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(isOpen = true, closeDisabled = false) {
    await act(async () => root.render(<>
      <button type="button" data-testid="trigger">Open address</button>
      <MobileFocusDialog isOpen={isOpen} closeDisabled={closeDisabled} onOpenChange={onOpenChange}
        dialogAriaLabel="Address" header={<input aria-label="Address search" defaultValue="A draft" />}>
        <div>Results stay in the scrolling body</div>
      </MobileFocusDialog>
    </>));
  }
  const input = () => document.querySelector<HTMLInputElement>('[aria-label="Address search"]')!;
  const modal = () => document.querySelector<HTMLElement>('[role="dialog"]')!.parentElement!;
  const close = () => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;

  it("keeps the focused input and draft mounted as the visual viewport shrinks and pans", async () => {
    await render();
    const field = input();
    await act(async () => { field.focus(); field.setSelectionRange(2, 4); });
    expect(modal().style.height).toBe("844px");
    const backdrop = modal().parentElement!;
    await act(async () => {
      Object.assign(viewport, { offsetTop: 25, offsetLeft: 10, height: 260, width: 360, scale: 2 });
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
      await new Promise(requestAnimationFrame);
    });
    expect(input()).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("A draft");
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(4);
    expect(modal().style.top).toBe("25px");
    expect(modal().style.left).toBe("10px");
    expect(modal().style.height).toBe("260px");
    expect(modal().style.width).toBe("360px");
    expect(modal().parentElement).toBe(backdrop);
    expect(backdrop.className).toContain("fixed inset-0");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("uses window dimensions when visual viewport data is unavailable", async () => {
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerWidth", 375);
    vi.stubGlobal("innerHeight", 667);
    await render();
    expect(modal().style.width).toBe("375px");
    expect(modal().style.height).toBe("667px");
    await act(async () => {
      vi.stubGlobal("innerHeight", 400);
      window.dispatchEvent(new Event("resize"));
      await new Promise(requestAnimationFrame);
    });
    expect(modal().style.height).toBe("400px");
  });

  it("closes through the shared Close button and Escape", async () => {
    await render();
    await act(async () => close().click());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    await act(async () => {
      input().focus();
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("consumes native Back while open, blocks dismissal during saves, and removes listeners", async () => {
    native.platform.mockReturnValue("android");
    const removeViewport = vi.spyOn(viewport, "removeEventListener");
    await render(true, true);
    expect(native.listen).toHaveBeenCalledOnce();
    expect(close().disabled).toBe(true);
    await act(async () => {
      onBack?.();
      close().click();
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    await render(true, false);
    await act(async () => onBack?.());
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(native.listen).toHaveBeenCalledOnce();
    await render(false);
    expect(native.remove).toHaveBeenCalledOnce();
    expect(removeViewport.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining(["resize", "scroll"]));
  });

  it("restores focus to the opener after closing", async () => {
    await render(false);
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    await act(async () => trigger.focus());
    await render();
    await act(async () => input().focus());
    await render(false);
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(document.activeElement).toBe(trigger);
  });
});
