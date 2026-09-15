// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMobileSidebarEntry, stripMobileSidebarState, useMobileSidebarHistory } from "../useMobileSidebarHistory";

describe("sidebar entry validation", () => {
  const entry = { version: 1, scopeKey: "user:project", baseKey: "base", baseIndex: 3, depth: 2, view: "workspace" };
  it("accepts only the exact scope and bounded matching history depth", () => {
    expect(readMobileSidebarEntry({ instafySidebar: entry }, "user:project", 5)).toEqual(entry);
    for (const value of [null, [], {}, { ...entry, depth: 3 }, { ...entry, view: "unknown" }, { ...entry, baseIndex: -1 }]) {
      expect(readMobileSidebarEntry({ instafySidebar: value }, "user:project", 5)).toBeNull();
    }
    expect(readMobileSidebarEntry({ instafySidebar: entry }, "other:project", 5)).toBeNull();
    expect(readMobileSidebarEntry({ instafySidebar: entry }, "user:project", 4)).toBeNull();
    expect(stripMobileSidebarState({ instafySidebar: entry, instafyVisitKey: "visit" })).toEqual({ instafyVisitKey: "visit" });
  });
});

describe("mobile sidebar browser history", () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useMobileSidebarHistory>;
  let currentLocation: ReturnType<typeof useLocation>;
  let navigate: ReturnType<typeof useNavigate>;
  let scopeKey: string | null;
  let enabled: boolean;
  function Harness() {
    api = useMobileSidebarHistory({ enabled, scopeKey });
    currentLocation = useLocation();
    navigate = useNavigate();
    return null;
  }
  const render = async () => { await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>)); };
  const wait = async (assertion: () => void) => {
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      assertion();
    });
  };
  const pop = async (delta: number) => {
    const previousKey = currentLocation.key;
    await act(async () => { window.history.go(delta); });
    await wait(() => expect(currentLocation.key).not.toBe(previousKey));
  };
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    scopeKey = "user:project";
    enabled = true;
    window.history.replaceState({ idx: 0, key: "base", usr: { instafyVisitKey: "visit-a" } }, "", "/studio?panel=chat");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("Back/Forward traverse drawer and drill-in while preserving the underlying visit", async () => {
    await act(async () => api.setMobileSidebarOpen(true));
    expect(api.mobileSidebarNavigation.view).toBe("sidebar");
    expect(currentLocation.state.instafyVisitKey).toBe("visit-a");
    await act(async () => api.mobileSidebarNavigation.openView("workspace"));
    expect(api.mobileSidebarNavigation.view).toBe("workspace");
    await pop(-1);
    expect(api.mobileSidebarNavigation.view).toBe("sidebar");
    await pop(-1);
    expect(api.mobileSidebarOpen).toBe(false);
    expect(currentLocation.key).toBe("base");
    await pop(1);
    expect(api.mobileSidebarNavigation.view).toBe("sidebar");
    await pop(1);
    expect(api.mobileSidebarNavigation.view).toBe("workspace");
  });

  it("opens the global team picker directly and Back returns to the original global visit", async () => {
    await act(async () => api.mobileSidebarNavigation.openView("workspace"));
    expect(api.mobileSidebarNavigation.view).toBe("workspace");
    expect(window.history.state.idx).toBe(1);
    expect(currentLocation.state.instafyVisitKey).toBe("visit-a");
    await act(async () => api.mobileSidebarNavigation.back());
    await wait(() => expect(currentLocation.key).toBe("base"));
    expect(api.mobileSidebarOpen).toBe(false);
    await pop(1);
    expect(api.mobileSidebarNavigation.view).toBe("workspace");
  });

  it("a direct team picker selection replaces its branch with one destination visit", async () => {
    await act(async () => api.mobileSidebarNavigation.openView("workspace"));
    const action = vi.fn(() => { void navigate("/studio?panel=team&teamId=empty-team", { state: null }); });
    await act(async () => api.runAfterSidebarClose(action));
    await wait(() => expect(action).toHaveBeenCalledTimes(1));
    expect(window.history.state.idx).toBe(1);
    expect(api.mobileSidebarOpen).toBe(false);
    await pop(-1);
    expect(currentLocation.key).toBe("base");
    await pop(1);
    expect(currentLocation.search).toBe("?panel=team&teamId=empty-team");
    expect(api.mobileSidebarOpen).toBe(false);
  });

  it("collapses before one destination push, so Back never resurrects the selected drawer", async () => {
    await act(async () => api.setMobileSidebarOpen(true));
    await act(async () => api.mobileSidebarNavigation.openView("workspace"));
    const action = vi.fn(() => { void navigate("/studio?panel=settings"); });
    await act(async () => api.runAfterSidebarClose(action));
    await wait(() => expect(action).toHaveBeenCalledTimes(1));
    expect(currentLocation.search).toBe("?panel=settings");
    expect(api.mobileSidebarOpen).toBe(false);
    await pop(-1);
    expect(currentLocation.key).toBe("base");
    expect(api.mobileSidebarOpen).toBe(false);
    await pop(1);
    expect(currentLocation.search).toBe("?panel=settings");
    expect(api.mobileSidebarOpen).toBe(false);
  });

  it("backdrop close collapses the whole branch but the drill-in Back pops one step", async () => {
    await act(async () => api.setMobileSidebarOpen(true));
    await act(async () => api.mobileSidebarNavigation.openView("workspace"));
    await act(async () => api.mobileSidebarNavigation.back());
    await wait(() => expect(api.mobileSidebarNavigation.view).toBe("sidebar"));
    await act(async () => api.mobileSidebarNavigation.openView("more"));
    await act(async () => api.setMobileSidebarOpen(false));
    await wait(() => expect(api.mobileSidebarOpen).toBe(false));
    expect(currentLocation.key).toBe("base");
  });

  it("replaces sibling drill-ins rather than building an unbounded overlay stack", async () => {
    await act(async () => api.setMobileSidebarOpen(true));
    await act(async () => api.mobileSidebarNavigation.openView("workspace"));
    await act(async () => api.mobileSidebarNavigation.openView("more"));
    expect(window.history.state.idx).toBe(2);
    await pop(-1);
    expect(api.mobileSidebarNavigation.view).toBe("sidebar");
  });

  it("collapses the hidden branch on desktop before any later destination is pushed", async () => {
    await act(async () => api.setMobileSidebarOpen(true));
    await act(async () => api.mobileSidebarNavigation.openView("more"));
    enabled = false;
    await render();
    expect(api.mobileSidebarOpen).toBe(false);
    expect(api.mobileSidebarNavigation.view).toBeNull();
    await wait(() => expect(currentLocation.key).toBe("base"));
    await act(async () => api.runAfterSidebarClose(() => { void navigate("/studio?panel=settings"); }));
    enabled = true;
    await render();
    await pop(-1);
    expect(currentLocation.key).toBe("base");
    expect(api.mobileSidebarOpen).toBe(false);
  });

  it("does not create two drawer entries before the router acknowledges the first", async () => {
    await act(async () => { api.setMobileSidebarOpen(true); api.setMobileSidebarOpen(true); });
    expect(window.history.state.idx).toBe(1);
    await pop(-1);
    expect(currentLocation.key).toBe("base");
    expect(api.mobileSidebarOpen).toBe(false);
  });

  it("preserves a base visit that has not needed a canonical replacement", async () => {
    await act(async () => { void navigate("/studio?panel=credits"); });
    const baseKey = currentLocation.key;
    expect(currentLocation.state).toBeNull();
    await act(async () => api.setMobileSidebarOpen(true));
    expect(currentLocation.state.instafyVisitKey).toBe(baseKey);
    await act(async () => api.mobileSidebarNavigation.openView("more"));
    expect(currentLocation.state.instafyVisitKey).toBe(baseKey);
  });

  it("allows rapid direct destination pushes but does not bypass an unrendered drawer", async () => {
    await act(async () => {
      api.runAfterSidebarClose(() => { void navigate("/studio?panel=credits"); });
      api.runAfterSidebarClose(() => { void navigate("/studio?panel=settings"); });
    });
    expect(window.history.state.idx).toBe(2);
    expect(currentLocation.search).toBe("?panel=settings");
    await pop(-1);
    expect(currentLocation.search).toBe("?panel=credits");
    const premature = vi.fn();
    await act(async () => { api.setMobileSidebarOpen(true); api.runAfterSidebarClose(premature); });
    expect(premature).not.toHaveBeenCalled();
    expect(api.mobileSidebarOpen).toBe(true);
  });

  it("cancels a pending destination when its owner unmounts", async () => {
    await act(async () => api.setMobileSidebarOpen(true));
    vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const action = vi.fn();
    await act(async () => api.runAfterSidebarClose(action));
    await act(async () => root.render(null));
    window.history.replaceState({ idx: 0, key: "base", usr: null }, "", "/studio?panel=chat");
    await render();
    expect(action).not.toHaveBeenCalled();
    expect(api.mobileSidebarNavigation.pending).toBe(false);
  });

  it("cancels a queued destination when the account or project changes", async () => {
    await act(async () => api.setMobileSidebarOpen(true));
    vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const action = vi.fn();
    await act(async () => api.runAfterSidebarClose(action));
    scopeKey = "other-user:project";
    await render();
    expect(api.mobileSidebarOpen).toBe(false);
    expect(api.mobileSidebarNavigation.pending).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it("cancels on an unrelated navigation instead of dispatching after a later Back", async () => {
    await act(async () => api.setMobileSidebarOpen(true));
    vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const action = vi.fn();
    await act(async () => api.runAfterSidebarClose(action));
    await act(async () => { void navigate("/studio?panel=credits"); });
    expect(api.mobileSidebarNavigation.pending).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it("bounds a missing history acknowledgement and ignores a second pending action", async () => {
    await act(async () => api.setMobileSidebarOpen(true));
    vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const first = vi.fn(), second = vi.fn();
    await act(async () => { api.runAfterSidebarClose(first); api.runAfterSidebarClose(second); });
    await act(async () => vi.advanceTimersByTime(2_001));
    expect(api.mobileSidebarNavigation.pending).toBe(false);
    expect(api.mobileSidebarNavigation.error).toContain("Please try again");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not create drawer visits without a scope or in desktop layout", async () => {
    scopeKey = null;
    await render();
    await act(async () => api.setMobileSidebarOpen(true));
    expect(api.mobileSidebarOpen).toBe(false);
    scopeKey = "user:project";
    enabled = false;
    await render();
    await act(async () => api.setMobileSidebarOpen(true));
    const action = vi.fn();
    await act(async () => api.runAfterSidebarClose(action));
    expect(action).toHaveBeenCalledTimes(1);
    expect(window.history.state.idx).toBe(0);
  });
});
