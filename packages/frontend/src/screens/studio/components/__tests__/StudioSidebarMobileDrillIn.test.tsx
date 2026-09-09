// @vitest-environment jsdom

import { act, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioSidebarMobileDrillIn } from "../StudioSidebarMobileDrillIn";

describe("StudioSidebarMobileDrillIn focus", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onBack = vi.fn();
  const onOuterKeyDown = vi.fn();
  let finishBack: () => void;

  function Harness({ delayed = false, focusRootOnClose = false }: { delayed?: boolean; focusRootOnClose?: boolean }) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const homeRef = useRef<HTMLButtonElement | null>(null);
    const destinationRef = useRef<HTMLButtonElement | null>(null);
    finishBack = () => setOpen(false);
    useLayoutEffect(() => {
      if (!open && focusRootOnClose) homeRef.current?.focus();
    }, [open, focusRootOnClose]);
    return <div onKeyDown={onOuterKeyDown}>
      <nav>
      <div inert={open} aria-hidden={open || undefined} data-testid="root-controls">
        <button ref={homeRef} data-testid="home">Home</button>
        <button ref={triggerRef} onClick={() => setOpen(true)} data-testid="trigger">More</button>
      </div>
      <StudioSidebarMobileDrillIn open={open} testId="drill-in" title="More"
        backLabel="Back" backTestId="back" triggerRef={triggerRef}
        onBack={() => { onBack(); if (!delayed) setOpen(false); }}>
        <button data-testid="select" onClick={() => {
          setOpen(false);
          destinationRef.current?.focus();
        }}>Select destination</button>
      </StudioSidebarMobileDrillIn>
      </nav>
      <button ref={destinationRef} data-testid="destination">Destination</button>
    </div>;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function click(id: string) {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.click());
  }
  async function frame() {
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  async function open(delayed = false, focusRootOnClose = false) {
    await act(async () => root.render(<Harness delayed={delayed} focusRootOnClose={focusRootOnClose} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    trigger.focus();
    await click("trigger");
    return trigger;
  }

  it("focuses its named region as it opens over the root navigation", async () => {
    await open();
    const panel = container.querySelector('[data-testid="drill-in"]');
    expect(document.activeElement).toBe(panel);
    expect(panel?.getAttribute("role")).toBe("region");
    expect(document.getElementById(panel!.getAttribute("aria-labelledby")!)?.textContent).toBe("More");
    expect(container.querySelector('[data-testid="root-controls"]')?.hasAttribute("inert")).toBe(true);
  });

  it.each(["back", "escape"])("restores the trigger after %s removes root inertness", async (action) => {
    const trigger = await open();
    if (action === "back") await click("back");
    else {
      await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      })));
      expect(onOuterKeyDown).not.toHaveBeenCalled();
    }
    await frame();
    expect(onBack).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="drill-in"]')).toBeNull();
    expect(container.querySelector('[data-testid="root-controls"]')?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("waits for an asynchronous Back to close before restoring focus", async () => {
    const trigger = await open(true);
    await click("back");
    await frame();
    expect(container.querySelector('[data-testid="drill-in"]')).not.toBeNull();
    expect(document.activeElement).not.toBe(trigger);
    await act(async () => finishBack());
    await frame();
    expect(document.activeElement).toBe(trigger);
  });

  it("restores More when the outer modal first focuses Home after closing", async () => {
    const trigger = await open(false, true);
    await click("back");
    expect(document.activeElement).toBe(container.querySelector('[data-testid="home"]'));
    await frame();
    expect(document.activeElement).toBe(trigger);
  });

  it("preserves focus moved outside navigation after an explicit Back", async () => {
    await open();
    await click("back");
    const destination = container.querySelector<HTMLButtonElement>('[data-testid="destination"]')!;
    destination.focus();
    await frame();
    expect(document.activeElement).toBe(destination);
  });

  it("preserves destination focus when selection closes the drill-in", async () => {
    await open();
    await click("select");
    await frame();
    expect(onBack).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="drill-in"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="destination"]'));
  });
});
