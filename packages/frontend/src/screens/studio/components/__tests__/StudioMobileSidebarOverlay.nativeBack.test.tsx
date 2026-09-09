// @vitest-environment jsdom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDialogModal } from "../../../../components/aria/StudioModal";
import { useStudioHistory } from "../../../../navigation/useStudioHistory";
import { useRouteOwnedWorkspaceDrawer } from "../../../useRouteOwnedWorkspaceDrawer";
import { StudioMobileSidebarOverlay } from "../StudioMobileSidebarOverlay";
import { StudioSidebarWorkspacePanel } from "../StudioSidebarWorkspacePanel";
import { StudioSidebarMobileDrillIn } from "../StudioSidebarMobileDrillIn";
import { useStudioLayoutChromeState } from "../../../useStudioLayoutChromeState";

const native = vi.hoisted(() => ({ addListener: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
vi.mock("@capacitor/app", () => ({ App: native }));

function Harness() {
  const { mobileSidebarOpen, setMobileSidebarOpen, mobileSidebarNavigation } = useStudioLayoutChromeState({
    isLargeScreen: false, scopeKey: "fixture-user:fixture-project",
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [team, setTeam] = useState("Atlas");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return <>
    <span data-testid="selected-team">{team}</span>
    <button data-testid="open-navigation" onClick={() => setMobileSidebarOpen(true)}>Navigation</button>
    {mobileSidebarOpen ? <StudioMobileSidebarOverlay onClose={() => setMobileSidebarOpen(false)}>
      <button ref={triggerRef} data-testid="open-picker" onClick={() => mobileSidebarNavigation.openView("workspace")}>Team & spaces</button>
      <button data-testid="open-more" onClick={() => mobileSidebarNavigation.openView("more")}>More</button>
      <button data-testid="open-dialog" onClick={() => setDialogOpen(true)}>Dialog</button>
      <StudioSidebarWorkspacePanel open={mobileSidebarNavigation.view === "workspace"} desktop={false} portalTarget={null}
        triggerRef={triggerRef} onClose={mobileSidebarNavigation.back}>
        <button data-testid="select-harbor" onClick={() => {
          setTeam("Harbor");
        }}>Harbor</button>
      </StudioSidebarWorkspacePanel>
      <StudioSidebarMobileDrillIn open={mobileSidebarNavigation.view === "more"} title="More" testId="more-picker"
        backLabel="Back" backTestId="more-back" onBack={mobileSidebarNavigation.back}>
        <button>Another panel</button>
      </StudioSidebarMobileDrillIn>
      <StudioDialogModal isOpen={dialogOpen} onOpenChange={setDialogOpen} isDismissable
        dialogAriaLabel="Above navigation" data-testid="top-dialog">
        <button>Dialog action</button>
      </StudioDialogModal>
    </StudioMobileSidebarOverlay> : null}
  </>;
}

function RouteOwnedHarness() {
  const location = useLocation();
  const { dismiss } = useRouteOwnedWorkspaceDrawer({ enabled: true, history: useStudioHistory() });
  const [dialogOpen, setDialogOpen] = useState(false);
  if (new URLSearchParams(location.search).get("workspaceTab") !== "workspaces") return <p>Chat</p>;
  return <StudioMobileSidebarOverlay onClose={dismiss}>
    <button data-testid="open-dialog" onClick={() => setDialogOpen(true)}>New team</button>
    <StudioDialogModal isOpen={dialogOpen} onOpenChange={setDialogOpen} isDismissable
      dialogAriaLabel="New team" data-testid="top-dialog">
      <input aria-label="Team name" />
    </StudioDialogModal>
  </StudioMobileSidebarOverlay>;
}

describe("Android Back in mobile navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let callbacks: Set<() => void>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    callbacks = new Set();
    native.addListener.mockReset();
    native.addListener.mockImplementation(async (name: string, callback: () => void) => {
      expect(name).toBe("backButton");
      callbacks.add(callback);
      return { remove: async () => { callbacks.delete(callback); } };
    });
    window.history.replaceState({ idx: 0, key: "chat-base", usr: null }, "", "/studio?projectId=fixture-project&panel=chat");
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
    await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>));
    await click("open-navigation");
    expect(callbacks.size).toBe(1);
  }

  async function pressNativeBack({ navigates = true } = {}) {
    const previousKey = window.history.state.key;
    await act(async () => {
      callbacks.forEach((callback) => callback());
      if (navigates) await vi.waitFor(() => expect(window.history.state.key).not.toBe(previousKey));
    });
    await settleFocus();
  }

  it("pops only the owned drawer visit and restores its trigger and original chat", async () => {
    await open();
    const back = vi.spyOn(window.history, "back");
    const go = vi.spyOn(window.history, "go");
    expect(window.history.state.idx).toBe(1);
    await pressNativeBack();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="open-navigation"]'));
    expect(window.location.search).toBe("?projectId=fixture-project&panel=chat");
    expect(window.history.state.key).toBe("chat-base");
    expect(window.history.state.idx).toBe(0);
    expect(back).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledExactlyOnceWith(-1);
    expect(callbacks.size).toBe(0);
  });

  it("pops Team & spaces before the drawer while retaining the selected team and chat destination", async () => {
    await open();
    await click("open-picker");
    await click("select-harbor");
    expect(window.history.state.idx).toBe(2);
    const urlAfterSwitch = window.location.href;
    const back = vi.spyOn(window.history, "back");
    const go = vi.spyOn(window.history, "go");

    await pressNativeBack();
    expect(document.querySelector('[data-testid="sidebar-project-switcher-menu"]')).toBeNull();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="open-picker"]'));
    expect(container.querySelector('[data-testid="selected-team"]')?.textContent).toBe("Harbor");
    expect(window.location.href).toBe(urlAfterSwitch);
    expect(window.history.state.idx).toBe(1);

    await pressNativeBack();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
    expect(container.querySelector('[data-testid="selected-team"]')?.textContent).toBe("Harbor");
    expect(window.location.href).toBe(urlAfterSwitch);
    expect(back).not.toHaveBeenCalled();
    expect(go.mock.calls).toEqual([[-1], [-1]]);
    expect(window.history.state.key).toBe("chat-base");
    expect(window.history.state.idx).toBe(0);
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
    const drawerKey = window.history.state.key;
    expect(callbacks.size).toBe(1);
    await pressNativeBack({ navigates: false });
    expect(window.history.state.key).toBe(drawerKey);
    expect(document.querySelector('[data-testid="top-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).not.toBeNull();
    await pressNativeBack();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
  });

  it("dismisses the real shared modal before replacing a direct-entry workspace drawer route", async () => {
    window.history.replaceState({ idx: 0, key: "direct", usr: { instafyVisitKey: "chat-visit" } }, "",
      "/studio?projectId=fixture-project&panel=chat&workspaceTab=workspaces");
    const historyLength = window.history.length;
    const go = vi.spyOn(window.history, "go");
    await act(async () => root.render(<BrowserRouter><RouteOwnedHarness /></BrowserRouter>));
    await settleFocus();
    await click("open-dialog");
    const drawerKey = window.history.state.key;
    expect(callbacks.size).toBe(1);
    await pressNativeBack({ navigates: false });
    expect(document.querySelector('[data-testid="top-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).not.toBeNull();
    expect(window.history.state.key).toBe(drawerKey);
    expect(window.location.search).toContain("workspaceTab=workspaces");
    await pressNativeBack();
    expect(document.querySelector('[data-testid="mobile-sidebar-overlay"]')).toBeNull();
    expect(window.location.search).toBe("?projectId=fixture-project&panel=chat");
    expect(window.history.state.idx).toBe(0);
    expect(window.history.state.usr.instafyVisitKey).toBe("chat-visit");
    expect(window.history.length).toBe(historyLength);
    expect(go).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
  });

});
