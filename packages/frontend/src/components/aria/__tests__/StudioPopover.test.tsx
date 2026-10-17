// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DialogTrigger, MenuTrigger } from "react-aria-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../Button";
import { FormPickerPopover } from "../../FormPicker";
import { StudioDialogPopover, StudioPopover, type StudioPopoverProps } from "../StudioPopover";
import { StudioMenu, StudioMenuItem } from "../StudioMenu";

const { renderedPopoverProps } = vi.hoisted(() => ({ renderedPopoverProps: vi.fn() }));
vi.mock("react-aria-components", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-aria-components")>();
  return {
    ...actual,
    Popover: (props: ComponentProps<typeof actual.Popover>) => {
      renderedPopoverProps(props);
      return <actual.Popover {...props} />;
    },
  };
});

function MenuFixture({ onSelect, popoverProps }: { onSelect: (id: string) => void; popoverProps?: StudioPopoverProps }) {
  const [open, setOpen] = useState(false);
  return <MenuTrigger isOpen={open} onOpenChange={setOpen}>
    <Button data-testid="menu-trigger">Choose option</Button>
    <StudioPopover data-testid="menu-popover" layout="menu" className="w-64" {...popoverProps}>
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
    renderedPopoverProps.mockClear();
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

  it.each(["menu", "form"] as const)("applies bounded %s geometry without changing caller classes or styles", async (layout) => {
    await act(async () => root.render(<MenuFixture onSelect={vi.fn()} popoverProps={{
      layout,
      className: () => "z-50",
      style: () => ({ width: 240 }),
    }} />));
    await click("menu-trigger");
    const popover = document.querySelector<HTMLElement>('[data-testid="menu-popover"]')!;
    expect(popover.dataset.studioPopoverLayout).toBe(layout);
    expect(popover.classList.contains("p-2")).toBe(true);
    expect(popover.classList.contains("z-50")).toBe(true);
    expect(popover.style.width).toBe("240px");
    expect(popover.style.getPropertyValue("--studio-popover-max-width")).toBe("calc(100vw - 16px)");
    expect(renderedPopoverProps.mock.lastCall?.[0]).toMatchObject({ offset: 6, containerPadding: 8 });
    expect(renderedPopoverProps.mock.lastCall?.[0]).not.toHaveProperty("layout");
  });

  it("preserves explicit geometry, including a zero trigger gap, and clamps to its edge clearance", async () => {
    await act(async () => root.render(<MenuFixture onSelect={vi.fn()} popoverProps={{ offset: 0, containerPadding: 24 }} />));
    await click("menu-trigger");
    expect(renderedPopoverProps.mock.lastCall?.[0]).toMatchObject({ offset: 0, containerPadding: 24 });
    expect(document.querySelector<HTMLElement>('[data-testid="menu-popover"]')!.style.getPropertyValue("--studio-popover-max-width"))
      .toBe("calc(100vw - 48px)");
  });

  it("leaves legacy popover geometry and padding unchanged unless a layout is requested", async () => {
    await act(async () => root.render(<MenuFixture onSelect={vi.fn()} popoverProps={{ layout: undefined, className: "w-72 p-3" }} />));
    await click("menu-trigger");
    const popover = document.querySelector<HTMLElement>('[data-testid="menu-popover"]')!;
    expect(popover.hasAttribute("data-studio-popover-layout")).toBe(false);
    expect(popover.classList.contains("p-2")).toBe(false);
    expect(popover.classList.contains("p-3")).toBe(true);
    expect(popover.style.getPropertyValue("--studio-popover-max-width")).toBe("");
    expect(renderedPopoverProps.mock.lastCall?.[0]).toMatchObject({ offset: undefined, containerPadding: undefined });
  });

  it("uses the form preset for shared field pickers while preserving explicit placement", async () => {
    await act(async () => root.render(<DialogTrigger>
      <Button data-testid="field-trigger">Choose model</Button>
      <FormPickerPopover placement="top start" offset={10} data-testid="field-popover">
        <div role="dialog" aria-label="Models">Available models</div>
      </FormPickerPopover>
    </DialogTrigger>));
    await click("field-trigger");
    expect(document.querySelector('[data-testid="field-popover"]')?.getAttribute("data-studio-popover-layout")).toBe("form");
    expect(renderedPopoverProps.mock.lastCall?.[0]).toMatchObject({ placement: "top start", offset: 10, containerPadding: 8, isNonModal: true });
  });

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
      <StudioDialogPopover data-testid="dialog-popover" layout="form" className="w-72">
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
