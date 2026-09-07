// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { StudioMobileSidebarOverlay } from "../StudioMobileSidebarOverlay";
import { StudioSidebarWorkspacePanel } from "../StudioSidebarWorkspacePanel";
import { StudioSidebarMobileDrillIn } from "../StudioSidebarMobileDrillIn";

const native = vi.hoisted(() => ({ addListener: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
vi.mock("@capacitor/app", () => ({ App: native }));

function Harness() {
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [team, setTeam] = useState("Atlas");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return <>
    <span data-testid="selected-team">{team}</span>
    <button data-testid="open-navigation" onClick={() => setOpen(true)}>Navigation</button>
    {open ? <StudioMobileSidebarOverlay onClose={() => setOpen(false)}>
      <button ref={triggerRef} data-testid="open-picker" onClick={() => setPickerOpen(true)}>Team & spaces</button>
      <button data-testid="open-more" onClick={() => setMoreOpen(true)}>More</button>
      <button data-testid="open-dialog" onClick={() => setDialogOpen(true)}>Dialog</button>
      <StudioSidebarWorkspacePanel open={pickerOpen} desktop={false} portalTarget={null}
        triggerRef={triggerRef} onClose={() => setPickerOpen(false)}>
        <button data-testid="select-harbor" onClick={() => {
          setTeam("Harbor");
          window.history.pushState(null, "", "/studio?org=harbor&workspaceTab=workspaces");
        }}>Harbor</button>
      </StudioSidebarWorkspacePanel>
      <StudioSidebarMobileDrillIn open={moreOpen} title="More" testId="more-picker"
        backLabel="Back" backTestId="more-back" onBack={() => setMoreOpen(false)}>
        <button>Another panel</button>
      </StudioSidebarMobileDrillIn>
      <ModalOverlay isOpen={dialogOpen} onOpenChange={setDialogOpen} isDismissable data-testid="top-dialog">
        <Modal><Dialog aria-label="Above navigation"><button>Dialog action</button></Dialog></Modal>
      </ModalOverlay>
    </StudioMobileSidebarOverlay> : null}
  </>;
}

describe("Android Back in mobile navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let callbacks: Set<() => void>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    callbacks = new Set();
    native.addListener.mockImplementation(async (name: string, callback: () => void) => {
      expect(name).toBe("backButton");
      callbacks.add(callback);
      return { remove: async () => { callbacks.delete(callback); } };
    });
    window.history.replaceState(null, "", "/studio?org=atlas");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function settleFocus() {
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }

  async function click(testId: string) {
    await act(async () => {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
      button.focus();
      button.click();
    });
    await settleFocus();
  }

  async function open() {
    await act(async () => root.render(<Harness />));
    await click("open-navigation");
    expect(callbacks.size).toBe(1);
  }

  async function pressNativeBack() {
    await act(async () => callbacks.forEach((callback) => callback()));
    await settleFocus();
  }

  it("dismisses navigation and restores its trigger without traversing WebView history", async () => {
    await open();
    const back = vi.spyOn(window.history, "back");
    const go = vi.spyOn(window.history, "go");
    await pressNativeBack();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="open-navigation"]'));
    expect(window.location.search).toBe("?org=atlas");
    expect(back).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
  });

  it("dismisses Team & spaces before navigation after a team switch, keeping the selected team", async () => {
    await open();
    await click("open-picker");
    await click("select-harbor");
    const urlAfterSwitch = window.location.href;
    const back = vi.spyOn(window.history, "back");
    const go = vi.spyOn(window.history, "go");

    await pressNativeBack();
    expect(document.querySelector('[data-testid="sidebar-project-switcher-menu"]')).toBeNull();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="open-picker"]'));
    expect(container.querySelector('[data-testid="selected-team"]')?.textContent).toBe("Harbor");
    expect(window.location.href).toBe(urlAfterSwitch);

    await pressNativeBack();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
    expect(container.querySelector('[data-testid="selected-team"]')?.textContent).toBe("Harbor");
    expect(window.location.href).toBe(urlAfterSwitch);
    expect(back).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });

  it("returns from More to navigation before closing the outer drawer", async () => {
    await open();
    await click("open-more");
    expect(document.activeElement).toBe(document.querySelector('[data-testid="more-picker"]'));
    await pressNativeBack();
    expect(document.querySelector('[data-testid="more-picker"]')).toBeNull();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).not.toBeNull();
    await pressNativeBack();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
  });

  it("dismisses a topmost dialog without also closing navigation", async () => {
    await open();
    await click("open-dialog");
    expect(document.querySelector('[data-testid="top-dialog"]')).not.toBeNull();
    await pressNativeBack();
    expect(document.querySelector('[data-testid="top-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).not.toBeNull();
    await pressNativeBack();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
  });
});
