// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioHistory } from "../../navigation/useStudioHistory";
import { useStudioLayoutChromeState } from "../useStudioLayoutChromeState";
import { resolveLeftDrawerFromSearch } from "../useStudioLayoutWorkspaceRouting";
import { useRouteOwnedWorkspaceDrawer } from "../useRouteOwnedWorkspaceDrawer";

describe("workspace picker responsive navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chrome: ReturnType<typeof useStudioLayoutChromeState>;
  let drawer: ReturnType<typeof useRouteOwnedWorkspaceDrawer>;
  let location: ReturnType<typeof useLocation>;
  let navigate: ReturnType<typeof useNavigate>;
  let wide: boolean;
  let routeOverlay: boolean;

  function Harness() {
    const routedLocation = useLocation();
    location = routedLocation; navigate = useNavigate();
    chrome = useStudioLayoutChromeState({ isLargeScreen: wide, scopeKey: "fixture-user:fixture-space" });
    const { setLeftDrawer } = chrome;
    // Mirror the real route hydration's one-way field ownership while using
    // the real Chrome state and both mobile dismissal owners together.
    useLayoutEffect(() => setLeftDrawer(resolveLeftDrawerFromSearch(routedLocation.search)), [routedLocation.search, setLeftDrawer]);
    routeOverlay = !wide && chrome.leftDrawer === "workspaces" && !chrome.mobileSidebarOpen;
    drawer = useRouteOwnedWorkspaceDrawer({ enabled: routeOverlay, history: useStudioHistory() });
    return null;
  }
  const render = () => act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>));
  const visit = () => ({ index: window.history.state.idx, length: window.history.length,
    key: location.state?.instafyVisitKey ?? location.key });
  const move = async (action: () => void) => {
    const oldKey = location.key;
    await act(async () => {
      action();
      await vi.waitFor(() => expect(window.history.state.key).not.toBe(oldKey));
    });
    expect(location.key).not.toBe(oldKey);
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({ idx: 0, key: "direct", usr: { instafyVisitKey: "workspace-visit" } }, "",
      "/studio?projectId=fixture-space&workspaceTab=workspaces");
    wide = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps a desktop workspace URL visible on mobile without adding a sidebar branch or visit", async () => {
    expect(chrome.leftDrawer).toBe("workspaces");
    expect(chrome.mobileSidebarOpen).toBe(false);
    const before = visit(), key = location.key;
    wide = false; await render();
    expect(routeOverlay).toBe(true);
    expect(chrome.leftDrawer).toBe("workspaces");
    expect(chrome.mobileSidebarOpen).toBe(false);
    expect(chrome.mobileSidebarNavigation.view).toBeNull();
    expect(location.state.instafySidebar).toBeUndefined();
    expect(visit()).toEqual(before);
    expect(location.key).toBe(key);
    wide = true; await render();
    expect(routeOverlay).toBe(false);
    expect(chrome.leftDrawer).toBe("workspaces");
    expect(chrome.mobileSidebarOpen).toBe(false);
    expect(visit()).toEqual(before);
    expect(location.key).toBe(key);
  });

  it("Back returns to the actual history visit and Forward restores the workspace overlay", async () => {
    await act(async () => navigate("/studio?workspaceTab=history", { replace: true }));
    const historyKey = location.key;
    await act(async () => navigate("/studio?workspaceTab=workspaces"));
    const workspaceKey = location.key, length = window.history.length;
    wide = false; await render();
    expect(routeOverlay).toBe(true);
    await move(drawer.dismiss);
    expect(location.key).toBe(historyKey);
    expect(chrome.leftDrawer).toBe("history");
    expect(routeOverlay).toBe(false);
    expect(chrome.mobileSidebarOpen).toBe(false);
    await move(() => window.history.forward());
    expect(location.key).toBe(workspaceKey);
    expect(routeOverlay).toBe(true);
    expect(window.history.length).toBe(length);
  });

  it("respects a nested Escape, then dismisses a direct-entry URL without duplicate Chrome handling", async () => {
    wide = false; await render();
    const before = visit();
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    await act(async () => { window.dispatchEvent(handled); });
    expect(chrome.leftDrawer).toBe("workspaces");
    expect(routeOverlay).toBe(true);
    const replace = vi.spyOn(window.history, "replaceState");
    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    await act(async () => { window.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(chrome.leftDrawer).toBeNull();
    expect(routeOverlay).toBe(false);
    expect(chrome.mobileSidebarOpen).toBe(false);
    expect(location.search).toBe("?projectId=fixture-space");
    expect(replace).toHaveBeenCalledTimes(1);
    expect(visit()).toEqual(before);
  });

  it("leaves an explicit mobile sidebar drill-in under its original history owner", async () => {
    await act(async () => navigate("/studio?projectId=fixture-space", { replace: true }));
    wide = false; await render();
    const baseKey = location.key;
    await act(async () => chrome.setMobileSidebarOpen(true));
    await act(async () => chrome.mobileSidebarNavigation.openView("workspace"));
    expect(chrome.mobileSidebarNavigation.view).toBe("workspace");
    expect(routeOverlay).toBe(false);
    expect(window.history.state.idx).toBe(2);
    await move(chrome.mobileSidebarNavigation.back);
    expect(chrome.mobileSidebarNavigation.view).toBe("sidebar");
    await move(chrome.mobileSidebarNavigation.back);
    expect(chrome.mobileSidebarOpen).toBe(false);
    expect(location.key).toBe(baseKey);
    expect(location.search).toBe("?projectId=fixture-space");
  });

  it.each(["history", "files", "sourceControl"])("keeps the %s destination through repeated sidebar toggles", async (panel) => {
    const search = `?projectId=fixture-space&conversationId=retained-chat&workspaceTab=${panel}`;
    await act(async () => navigate(`/studio${search}`, { replace: true }));
    wide = false;
    await render();
    const baseKey = location.key;
    const baseIndex = window.history.state.idx;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await act(async () => chrome.toggleSidebar());
      expect(chrome.mobileSidebarOpen).toBe(true);
      expect(chrome.leftDrawer).toBe(panel);
      expect(location.search).toBe(search);
      expect(window.history.state.idx).toBe(baseIndex + 1);
      await move(chrome.toggleSidebar);
      expect(chrome.mobileSidebarOpen).toBe(false);
      expect(chrome.leftDrawer).toBe(panel);
      expect(location.search).toBe(search);
      expect(location.key).toBe(baseKey);
      expect(window.history.state.idx).toBe(baseIndex);
    }
  });
});
