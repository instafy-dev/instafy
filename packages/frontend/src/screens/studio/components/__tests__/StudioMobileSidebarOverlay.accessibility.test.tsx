// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Button } from "../../../../components/Button";
import { StudioMobileSidebarOverlay } from "../StudioMobileSidebarOverlay";

function Harness({ presentation = "side", showCloseFooter = true }: { presentation?: "side" | "bottom"; showCloseFooter?: boolean }) {
  const [isOpen, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)} data-testid="open-navigation">Open navigation</Button>
      {isOpen ? <StudioMobileSidebarOverlay presentation={presentation} showCloseFooter={showCloseFooter} onClose={() => setOpen(false)}>
        <Button data-testid="close-navigation" onPress={() => setOpen(false)}>Close navigation</Button>
        <Button data-testid="select-chat" onPress={() => setOpen(false)}>Select chat</Button>
      </StudioMobileSidebarOverlay> : null}
    </>
  );
}

describe("StudioMobileSidebarOverlay accessibility", () => {
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function open(presentation: "side" | "bottom" = "side", showCloseFooter = true) {
    await act(async () => root.render(<Harness presentation={presentation} showCloseFooter={showCloseFooter} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="open-navigation"]')!;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    return trigger;
  }

  it("moves focus into a named modal and hides the chat behind it from assistive technology", async () => {
    await open();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("Navigation");
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(container.getAttribute("aria-hidden")).toBe("true");
    // The viewport observer must attach after the semantic modal portal mounts.
    const controls = document.querySelector<HTMLElement>('[data-testid="mobile-sidebar-controls"]');
    expect(controls?.style.height).not.toBe("");
  });

  it.each(["side", "bottom"] as const)("dismisses the %s drawer on Escape and restores focus to the composer menu trigger", async presentation => {
    const trigger = await open(presentation);
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(trigger);
    expect(container.hasAttribute("aria-hidden")).toBe(false);
  });

  it("closes the bottom sheet from its reachable footer", async () => {
    await open("bottom");
    expect(document.querySelector('[data-testid="mobile-sidebar-surface"]')?.getAttribute("data-presentation")).toBe("bottom");
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    expect(container.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      const close = document.querySelector<HTMLButtonElement>('[data-testid="mobile-navigation-sheet-close"]')!;
      close.focus(); close.click();
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
    expect(container.hasAttribute("aria-hidden")).toBe(false);
  });

  it("makes the handle a named close button when there is no footer", async () => {
    await open("bottom", false);
    expect(document.querySelector('[data-testid="mobile-navigation-sheet-close"]')).toBeNull();
    const handle = document.querySelector<HTMLButtonElement>('[data-testid="mobile-navigation-sheet-handle"]')!;
    expect(handle.tagName).toBe("BUTTON");
    expect(handle.getAttribute("aria-label")).toBe("Close navigation");
    expect(handle.hasAttribute("aria-hidden")).toBe(false);
    await act(async () => { handle.focus(); handle.click(); });
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
    expect(container.hasAttribute("aria-hidden")).toBe(false);
  });

  it.each([true, false])("dismisses by dragging but ignores the click after an incomplete drag (footer=%s)", async showCloseFooter => {
    await open("bottom", showCloseFooter);
    const handle = document.querySelector<HTMLElement>('[data-testid="mobile-navigation-sheet-handle"]')!;
    Object.defineProperty(handle, "setPointerCapture", { value: () => {} });
    const pointer = (type: string, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientY: y });
      Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
      handle.dispatchEvent(event);
    };
    await act(async () => { pointer("pointerdown", 200); pointer("pointermove", 220); pointer("pointerup", 220); handle.click(); });
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).not.toBeNull();
    await act(async () => { pointer("pointerdown", 200); pointer("pointermove", 270); pointer("pointerup", 270); });
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
  });

  it("can dismiss after a chat is selected", async () => {
    await open();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="select-chat"]')?.click());
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
  });
});
