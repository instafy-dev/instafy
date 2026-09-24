// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomDock } from "../MobileBottomDock";

describe("MobileBottomDock", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (overrides: Partial<ComponentProps<typeof MobileBottomDock>> = {}) => act(async () => {
    root.render(<MobileBottomDock activeSlot="chat" homeAttentionCount={0}
      onHomePress={() => {}} onChatPress={() => {}} onProjectsPress={() => {}} {...overrides} />);
  });

  it("keeps three stable overview destinations, with no history action", async () => {
    await render();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map(button => button.getAttribute("aria-label"))).toEqual(["Open home", "Open chats", "Open spaces"]);
    expect(buttons.map(button => button.textContent)).toEqual(["Home", "Chats", "Spaces"]);
    expect(buttons.every(button => button.classList.contains("min-h-12") && button.classList.contains("min-w-12"))).toBe(true);
    expect(buttons.every(button => !button.disabled)).toBe(true);
    expect(buttons[1].getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('nav')?.getAttribute("aria-label")).toBe("Studio navigation");
  });

  it("routes each overview once and retains the Home attention badge", async () => {
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];
    await render({ activeSlot: "home", homeAttentionCount: 12,
      onHomePress: callbacks[0], onChatPress: callbacks[1], onProjectsPress: callbacks[2] });
    for (const button of container.querySelectorAll("button")) await act(async () => button.click());
    for (const callback of callbacks) expect(callback).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="mobile-bottom-dock-home-badge"]')?.textContent).toBe("9+");
    expect(container.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("Open home");
  });

  it("moves the visible selection indicator with the current destination", async () => {
    for (const activeSlot of ["home", "chat", "projects"] as const) {
      await render({ activeSlot });
      const selected = container.querySelectorAll('[aria-current="page"]');
      expect(selected).toHaveLength(1);
      expect(selected[0].getAttribute("data-testid")).toBe(`mobile-bottom-dock-${activeSlot}`);
      const indicators = container.querySelectorAll('[data-testid="mobile-bottom-dock-active-indicator"]');
      expect(indicators).toHaveLength(1);
      expect(selected[0].contains(indicators[0])).toBe(true);
    }
  });
});
