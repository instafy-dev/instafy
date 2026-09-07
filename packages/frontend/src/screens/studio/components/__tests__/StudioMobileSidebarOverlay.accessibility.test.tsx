// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Button } from "../../../../components/Button";
import { StudioMobileSidebarOverlay } from "../StudioMobileSidebarOverlay";

function Harness() {
  const [isOpen, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)} data-testid="open-navigation">Open navigation</Button>
      {isOpen ? <StudioMobileSidebarOverlay onClose={() => setOpen(false)}>
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

  async function open() {
    await act(async () => root.render(<Harness />));
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
    expect(dialog?.getAttribute("aria-label")).toBe("Navigation and recent chats");
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(container.getAttribute("aria-hidden")).toBe("true");
  });

  it("dismisses on Escape and restores focus to the composer menu trigger", async () => {
    const trigger = await open();
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement).toBe(trigger);
    expect(container.hasAttribute("aria-hidden")).toBe(false);
  });

  it("can dismiss after a chat is selected", async () => {
    await open();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="select-chat"]')?.click());
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
  });
});
