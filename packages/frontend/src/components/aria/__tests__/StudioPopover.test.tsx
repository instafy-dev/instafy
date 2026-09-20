// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DialogTrigger, MenuTrigger } from "react-aria-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../Button";
import { StudioDialogPopover, StudioPopover } from "../StudioPopover";
import { StudioMenu, StudioMenuItem } from "../StudioMenu";

function MenuFixture({ onSelect }: { onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return <MenuTrigger isOpen={open} onOpenChange={setOpen}>
    <Button data-testid="menu-trigger">Choose option</Button>
    <StudioPopover data-testid="menu-popover" className="w-64 p-2">
      <StudioMenu aria-label="Options" selectionMode="single" onAction={id => { onSelect(String(id)); setOpen(false); }}>
        {Array.from({ length: 40 }, (_, index) => <StudioMenuItem id={`option-${index}`} key={index}>Option {index + 1}</StudioMenuItem>)}
      </StudioMenu>
    </StudioPopover>
  </MenuTrigger>;
}

describe("StudioPopover content scrolling boundary", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function click(id: string) {
    const button = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    expect(button).not.toBeNull();
    await act(async () => { button!.focus(); button!.click(); });
  }
  async function key(key: string) {
    const target = document.activeElement!;
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    });
  }
  async function finishFocusRestoration() {
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  }

  it("keeps the decorative surface outside the content and supports keyboard selection of the last item", async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<MenuFixture onSelect={onSelect} />));
    await click("menu-trigger");
    const popover = document.querySelector('[data-testid="menu-popover"]')!;
    const content = popover.querySelector(':scope > [data-studio-popover-content]')!;
    const decoration = popover.querySelector(':scope > [aria-hidden=true]')!;
    expect(content.contains(popover.querySelector('[role="menu"]'))).toBe(true);
    expect(decoration).not.toBeNull();
    expect(content.contains(decoration)).toBe(false);
    await act(async () => popover.querySelector<HTMLElement>('[role="menuitemradio"]')!.focus());
    await key("End");
    expect(document.activeElement?.textContent).toBe("Option 40");
    await key("Enter");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("option-39");
    expect(document.querySelector('[data-testid="menu-popover"]')).toBeNull();
    await finishFocusRestoration();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="menu-trigger"]'));
  });

  it("keeps nested picker dismissal local and restores focus through the enclosing dialog", async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<DialogTrigger>
      <Button data-testid="dialog-trigger">Open parent</Button>
      <StudioDialogPopover data-testid="dialog-popover" className="w-72 p-3">
        <h2 slot="title">Parent dialog</h2>
        <MenuFixture onSelect={onSelect} />
      </StudioDialogPopover>
    </DialogTrigger>));
    await click("dialog-trigger"); await click("menu-trigger");
    await act(async () => document.querySelector<HTMLElement>('[role="menuitemradio"]')!.focus());
    await key("Escape");
    expect(document.querySelector('[data-testid="menu-popover"]')).toBeNull();
    expect(document.querySelector('[data-testid="dialog-popover"]')).not.toBeNull();
    await finishFocusRestoration();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="menu-trigger"]'));
    await key("Escape");
    expect(document.querySelector('[data-testid="dialog-popover"]')).toBeNull();
    await finishFocusRestoration();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="dialog-trigger"]'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
