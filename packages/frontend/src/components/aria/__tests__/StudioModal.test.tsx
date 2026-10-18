/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDialogModal } from "../StudioModal";
import { StudioDialogBody, StudioDialogFooter, StudioDialogHeader } from "../StudioDialogLayout";

describe("StudioDialogModal appearances", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the adaptive light appearance by default", async () => {
    await act(async () => {
      root.render(
        <StudioDialogModal isOpen dialogAriaLabel="Default dialog">
          Default content
        </StudioDialogModal>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    const modal = dialog?.parentElement;
    const overlay = modal?.parentElement;

    expect(modal?.classList.contains("dark")).toBe(false);
    expect(modal?.className).toContain("bg-white");
    expect(modal?.className).toContain("dark:bg-[var(--color-studio-dark-panel)]");
    expect(overlay?.className).toContain("bg-black/40");
  });

  it("provides an always-dark root for dark dialog descendants", async () => {
    await act(async () => {
      root.render(
        <StudioDialogModal
          isOpen
          appearance="dark"
          dialogAriaLabel="Dark dialog"
          modalClassName="feature-modal"
        >
          Dark content
        </StudioDialogModal>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    const modal = dialog?.parentElement;
    const overlay = modal?.parentElement;

    expect(modal?.classList.contains("dark")).toBe(true);
    expect(modal?.className).toContain("border-white/10");
    expect(modal?.className).toContain("bg-zinc-950");
    expect(modal?.className).toContain("feature-modal");
    expect(overlay?.className).toContain("bg-zinc-950/70");
    expect(overlay?.className).toContain("backdrop-blur-sm");
  });

  it.each([
    ["sm", "max-w-sm"],
    ["md", "max-w-lg"],
    ["lg", "max-w-2xl"],
  ] as const)("selects one width preset for size %s without leaking it to the overlay", async (size, widthClass) => {
    await act(async () => root.render(
      <StudioDialogModal isOpen size={size} dialogAriaLabel="Sized dialog">Content</StudioDialogModal>,
    ));
    const modal = document.querySelector('[role="dialog"]')!.parentElement!;
    expect([...modal.classList].filter((value) => value.startsWith("max-w-"))).toEqual([widthClass]);
    expect(modal.parentElement!.hasAttribute("size")).toBe(false);
  });

  it("supports an opaque backdrop for immersive dark surfaces", async () => {
    await act(async () => {
      root.render(
        <StudioDialogModal
          isOpen
          appearance="dark"
          backdrop="opaque"
          dialogAriaLabel="Immersive dialog"
        >
          Immersive content
        </StudioDialogModal>,
      );
    });

    const dialog = document.querySelector('[role="dialog"]');
    const overlay = dialog?.parentElement?.parentElement;

    expect(overlay?.className).toContain("bg-zinc-950");
    expect(overlay?.className).not.toContain("bg-zinc-950/70");
    expect(overlay?.className).not.toContain("backdrop-blur-sm");
  });

  it("bounds an editor and keeps its header and footer outside the scrolling body", async () => {
    await act(async () => root.render(
      <StudioDialogModal isOpen layout="editor" dialogAriaLabel="Edit profile">
        <StudioDialogHeader title="Edit profile" />
        <StudioDialogBody scrollable padding="none"><input aria-label="Name" defaultValue="Draft" /></StudioDialogBody>
        <StudioDialogFooter><button>Save</button></StudioDialogFooter>
      </StudioDialogModal>,
    ));
    const dialog = document.querySelector('[role="dialog"]')!;
    const [header, body, footer] = [...dialog.children];
    expect(dialog.parentElement!.className).toContain("100dvh-max(var(--instafy-safe-area-inset-top,0px),1rem)");
    expect(dialog.classList.contains("max-h-[inherit]")).toBe(true);
    expect(header.classList.contains("shrink-0")).toBe(true);
    expect(footer.classList.contains("shrink-0")).toBe(true);
    expect(body.classList.contains("overflow-y-auto")).toBe(true);
    expect(body.classList.contains("min-h-0")).toBe(true);
    expect(body.classList.contains("px-5")).toBe(false);
    expect(body.querySelector("input")?.value).toBe("Draft");
    expect(footer.querySelector("button")?.textContent).toBe("Save");
  });

  it("keeps the existing section gutters and unpadded footer by default", async () => {
    await act(async () => root.render(
      <>
        <StudioDialogHeader title="Editor" />
        <StudioDialogBody>Fields</StudioDialogBody>
        <StudioDialogFooter padding="default" divider>Actions</StudioDialogFooter>
        <StudioDialogFooter>Already padded actions</StudioDialogFooter>
      </>,
    ));
    const [header, body, paddedFooter, bareFooter] = [...container.children];
    for (const section of [header, body, paddedFooter]) {
      expect(section.classList.contains("px-5")).toBe(true);
      expect(section.classList.contains("px-4")).toBe(false);
      expect(section.classList.contains("py-4")).toBe(true);
    }
    expect(paddedFooter.classList.contains("border-t")).toBe(true);
    expect(bareFooter.className).toBe("shrink-0");
  });

  it("opts every shared section into responsive gutters at the dialog boundary", async () => {
    await act(async () => root.render(
      <StudioDialogModal isOpen gutter="responsive" dialogAriaLabel="Responsive editor">
        <StudioDialogHeader title="Editor" />
        <StudioDialogBody>Fields</StudioDialogBody>
        <StudioDialogFooter padding="default" divider>Actions</StudioDialogFooter>
      </StudioDialogModal>,
    ));
    const dialog = document.querySelector('[role="dialog"]')!;
    for (const section of [...dialog.children]) {
      expect(section.classList.contains("px-4")).toBe(true);
      expect(section.classList.contains("sm:px-5")).toBe(true);
      expect(section.classList.contains("px-5")).toBe(false);
    }
    expect(dialog.parentElement!.parentElement!.hasAttribute("gutter")).toBe(false);
  });
});

// A control that disables itself while it works (the invite dialog's Copy)
// drops focus to <body>. React Aria only hears Escape from inside the dialog,
// so the dialog then ignored Escape and stayed over the page.
describe("StudioDialogModal with focus lost to the page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function loseFocus() {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  }

  function press(key: string) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(event); });
    return event;
  }

  it("still closes on Escape", async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(<StudioDialogModal isOpen isDismissable onOpenChange={onOpenChange} dialogAriaLabel="Invite">
        <button type="button">Copy</button>
      </StudioDialogModal>);
    });
    loseFocus();
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("takes Tab back inside the dialog", async () => {
    await act(async () => {
      root.render(<StudioDialogModal isOpen onOpenChange={vi.fn()} dialogAriaLabel="Invite">
        <button type="button">Copy</button>
      </StudioDialogModal>);
    });
    loseFocus();
    press("Tab");
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
  });

  it("closes only the top dialog, and never one whose keyboard dismissal is off", async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    await act(async () => {
      root.render(<>
        <StudioDialogModal isOpen onOpenChange={outer} dialogAriaLabel="Outer">outer</StudioDialogModal>
        <StudioDialogModal isOpen onOpenChange={inner} isKeyboardDismissDisabled dialogAriaLabel="Inner">inner</StudioDialogModal>
      </>);
    });
    loseFocus();
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(inner).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });
});
