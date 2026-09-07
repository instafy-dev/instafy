// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioSidebarWorkspacePanel } from "../StudioSidebarWorkspacePanel";

describe("StudioSidebarWorkspacePanel", () => {
  let container: HTMLDivElement;
  let portalTarget: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();
  const onOuterKeyDown = vi.fn();

  function Harness({ desktop = true, initialOpen = true }: { desktop?: boolean; initialOpen?: boolean }) {
    const [open, setOpen] = useState(initialOpen);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const destinationRef = useRef<HTMLButtonElement | null>(null);
    return (
      <div onKeyDown={onOuterKeyDown} data-testid="navigation">
        <button ref={triggerRef} type="button" data-testid="trigger" onClick={() => setOpen(!open)}>Team & spaces</button>
        <button ref={destinationRef} type="button" data-testid="destination">Chat</button>
        <StudioSidebarWorkspacePanel
          open={open}
          desktop={desktop}
          portalTarget={portalTarget}
          triggerRef={triggerRef}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <button type="button" data-testid="space" onClick={() => {
            setOpen(false);
            destinationRef.current?.focus();
          }}>Selected space</button>
        </StudioSidebarWorkspacePanel>
      </div>
    );
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    portalTarget = document.createElement("div");
    document.body.append(container, portalTarget);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    portalTarget.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(props: { desktop?: boolean; initialOpen?: boolean } = {}) {
    await act(async () => root.render(<Harness {...props} />));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }

  async function click(testId: string) {
    await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click());
  }

  it("renders an initially open controlled panel in the drawer target and moves focus into it", async () => {
    await render();
    const panel = portalTarget.querySelector('[data-testid="sidebar-project-switcher-menu"]');
    expect(panel?.getAttribute("role")).toBe("region");
    expect(panel?.textContent).toContain("Team & spaces");
    expect(container.querySelector('[data-testid="space"]')).toBeNull();
    expect(portalTarget.querySelector('[data-testid="space"]')).not.toBeNull();
    expect(document.activeElement).toBe(panel);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-studio-popover]')).toBeNull();
  });

  it("does not dismiss when focus or a click moves to the adjacent workspace", async () => {
    await render();
    await click("destination");
    expect(portalTarget.querySelector('[data-testid="space"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["close", "escape"])("dismisses with %s and returns focus to the sidebar trigger", async (action) => {
    await render();
    if (action === "close") {
      await click("sidebar-project-switcher-close");
    } else {
      await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    }
    expect(portalTarget.textContent).toBe("");
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="trigger"]'));
  });

  it("preserves navigation focus when selection closes the controlled panel", async () => {
    await render();
    await click("space");
    expect(portalTarget.textContent).toBe("");
    expect(document.activeElement).toBe(container.querySelector('[data-testid="destination"]'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the controlled panel open when switching between desktop and mobile presentation", async () => {
    await render();
    await render({ desktop: false });
    expect(portalTarget.textContent).toBe("");
    expect(container.querySelector('[data-testid="sidebar-project-switcher-back"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="space"]')).not.toBeNull();
    await render({ desktop: true });
    expect(portalTarget.querySelector('[data-testid="space"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["back", "escape"])("mobile %s returns to navigation without dismissing its parent", async (action) => {
    await render({ desktop: false });
    if (action === "back") {
      await click("sidebar-project-switcher-back");
    } else {
      await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(onOuterKeyDown).not.toHaveBeenCalled();
    }
    expect(document.querySelector('[data-testid="sidebar-project-switcher-menu"]')).toBeNull();
    expect(container.querySelector('[data-testid="navigation"]')).not.toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="trigger"]'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("waits for the caller to open the panel", async () => {
    await render({ initialOpen: false });
    expect(portalTarget.textContent).toBe("");
    await click("trigger");
    expect(portalTarget.querySelector('[data-testid="space"]')).not.toBeNull();
  });
});
