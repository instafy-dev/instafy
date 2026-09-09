// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStudioVisitKey } from "../../../../navigation/studioVisit";
import { useMobileSidebarHistory } from "../../../useMobileSidebarHistory";
import { useSharedBrowserResumeSearchReplacement } from "../useSharedBrowserResume";

describe("Shared Browser locator canonical replacement", () => {
  let root: Root;
  let container: HTMLDivElement;
  let location: ReturnType<typeof useLocation>;
  let navigate: ReturnType<typeof useNavigate>;
  let replace: ReturnType<typeof useSharedBrowserResumeSearchReplacement>;
  let sidebar: ReturnType<typeof useMobileSidebarHistory>;
  const nextSearch = "?projectId=space&browserRuntimeId=replacement";
  function Fixture() {
    location = useLocation(); navigate = useNavigate();
    replace = useSharedBrowserResumeSearchReplacement();
    sidebar = useMobileSidebarHistory({ enabled: true, scopeKey: "user:space" });
    return null;
  }
  const identity = () => ({ visit: getStudioVisitKey(location), idx: window.history.state.idx, length: window.history.length });
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({ key: "original-visit", idx: 0, usr: { retained: "inert-state" } }, "",
      "/studio?projectId=space&browserRuntimeId=original#anchor");
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<BrowserRouter><Fixture /></BrowserRouter>));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("preserves direct-entry history state, logical reading visit, index, length and hash", async () => {
    const before = identity();
    await act(async () => replace(nextSearch));
    expect(identity()).toEqual(before);
    expect(location.state).toEqual({ retained: "inert-state", instafyVisitKey: "original-visit" });
    expect(location.search).toBe(nextSearch);
    expect(location.hash).toBe("#anchor");
  });

  it("does not erase an active sidebar drill-in and still pops one layer at a time", async () => {
    await act(async () => sidebar.setMobileSidebarOpen(true));
    await act(async () => sidebar.mobileSidebarNavigation.openView("workspace"));
    const before = identity();
    const entry = location.state.instafySidebar;
    await act(async () => replace(nextSearch));
    expect(identity()).toEqual(before);
    expect(location.state.instafySidebar).toEqual(entry);
    expect(sidebar.mobileSidebarNavigation.view).toBe("workspace");
    await act(async () => {
      sidebar.mobileSidebarNavigation.back();
      await vi.waitFor(() => expect(window.history.state.idx).toBe(1));
    });
    expect(sidebar.mobileSidebarNavigation.view).toBe("sidebar");
    await act(async () => {
      sidebar.mobileSidebarNavigation.back();
      await vi.waitFor(() => expect(window.history.state.idx).toBe(0));
    });
    expect(sidebar.mobileSidebarOpen).toBe(false);
  });

  it.each([false, true])("rejects a stale callback after another visit (before Router renders=%s)", async beforeRender => {
    const stale = replace;
    if (beforeRender) {
      await act(async () => { void navigate("/studio?panel=settings"); stale(nextSearch); });
    } else {
      await act(async () => { void navigate("/studio?panel=settings"); });
      await act(async () => stale(nextSearch));
    }
    expect(location.search).toBe("?panel=settings");
    expect(window.history.state.idx).toBe(1);
  });

  it("does not replace the same search or act after its owner unmounts", async () => {
    const write = vi.spyOn(window.history, "replaceState");
    await act(async () => replace(location.search));
    expect(write).not.toHaveBeenCalled();
    const stale = replace;
    await act(async () => root.render(null));
    await act(async () => stale(nextSearch));
    expect(write).not.toHaveBeenCalled();
  });
});
