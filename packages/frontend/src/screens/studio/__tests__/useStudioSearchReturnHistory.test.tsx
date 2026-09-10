// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import { getStudioVisitKey } from "../../../navigation/studioVisit";
import { useMobileSidebarHistory } from "../../useMobileSidebarHistory";
import type { StudioSearchSnapshot } from "../components/useStudioSearch";
import { useStudioSearchHistory } from "../useStudioSearchHistory";

describe("verified return to search results", () => {
  let root: Root;
  let container: HTMLDivElement;
  let viewer: string | null;
  let location: ReturnType<typeof useLocation>;
  let navigate: NavigateFunction;
  let go: ReturnType<typeof useStudioNavigation>;
  let history: ReturnType<typeof useStudioSearchHistory>;
  let sidebar: ReturnType<typeof useMobileSidebarHistory>;
  const sourceSearch = "?projectId=space-a&conversationId=chat-a";
  const snapshot: StudioSearchSnapshot = {
    query: "needle", scope: "space", resultLimit: 200, resultId: "message-hit",
    scrollTop: 730, messagePageCount: 2,
  };

  function Harness() {
    location = useLocation();
    navigate = useNavigate();
    go = useStudioNavigation();
    const visitKey = getStudioVisitKey(location);
    const projectId = new URLSearchParams(location.search).get("projectId");
    const sidebarScopeKey = viewer ? `${viewer}:${projectId ?? "no-project"}` : null;
    history = useStudioSearchHistory(viewer, visitKey, `${viewer}:${visitKey}:${location.search}`, sidebarScopeKey);
    sidebar = useMobileSidebarHistory({ enabled: true, scopeKey: sidebarScopeKey });
    return null;
  }

  const render = async () => { await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>)); };
  const waitFor = async (assertion: () => void) => {
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      assertion();
    });
  };
  const openResult = async () => {
    let token: string | null = null;
    await act(async () => {
      history.remember(snapshot);
      token = history.getOriginToken();
      go({ kind: "conversation", projectId: "space-a", conversationId: "chat-b", messageId: "message-b" },
        { forceNewVisit: true, searchOriginToken: token ?? undefined });
    });
    expect(token).not.toBeNull();
    return token!;
  };
  const assertAtResults = () => {
    expect(window.history.state.idx).toBe(0);
    expect(location.search).toBe(sourceSearch);
    expect(history.restoredSession).toMatchObject(snapshot);
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    viewer = "viewer-a";
    window.history.replaceState({ idx: 0, key: "source", usr: null }, "", `/studio${sourceSearch}`);
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

  it("returns past a message result and Return to latest to the exact results visit", async () => {
    const token = await openResult();
    expect(history.originToken).toBe(token);
    expect(location.state).toEqual({ instafySearchOriginToken: token });
    await act(async () => {
      go({ kind: "conversation", projectId: "space-a", conversationId: "chat-b" },
        { searchOriginToken: history.originToken ?? undefined });
    });
    expect(window.history.state.idx).toBe(2);
    expect(history.originToken).toBe(token);
    await act(async () => history.returnToResults());
    await waitFor(assertAtResults);
    await act(async () => navigate(2));
    await waitFor(() => expect(window.history.state.idx).toBe(2));
    expect(history.originToken).toBe(token);
    await act(async () => history.returnToResults());
    await waitFor(assertAtResults);
  });

  it("does not offer a return for a direct link or ordinary navigation", async () => {
    const move = vi.spyOn(window.history, "go");
    await act(async () => history.returnToResults());
    expect(history.originToken).toBeNull();
    expect(move).not.toHaveBeenCalled();
    await openResult();
    await act(async () => go({ kind: "panel", panel: "settings", settingsTab: "project" }));
    expect(history.originToken).toBeNull();
    await act(async () => history.returnToResults());
    expect(move).not.toHaveBeenCalled();
  });

  it("requires an in-memory checkpoint even when the URL state contains a marker", async () => {
    await openResult();
    const resultKey = location.key;
    await act(async () => root.render(null));
    await render();
    expect(history.originToken).toBeNull();
    const move = vi.spyOn(window.history, "go");
    await act(async () => history.returnToResults());
    expect(move).not.toHaveBeenCalled();
    expect(location.key).toBe(resultKey);
  });

  it("clears return ownership on account changes, including switching back", async () => {
    await openResult();
    const move = vi.spyOn(window.history, "go");
    viewer = "viewer-b";
    await render();
    expect(history.originToken).toBeNull();
    await act(async () => history.returnToResults());
    viewer = "viewer-a";
    await render();
    expect(history.originToken).toBeNull();
    await act(async () => history.returnToResults());
    expect(move).not.toHaveBeenCalled();
  });

  it("keeps the return through canonical replacement without confusing Router and visit keys", async () => {
    const token = await openResult();
    const resultKey = location.key;
    const resultVisit = getStudioVisitKey(location);
    await act(async () => {
      await navigate(`${location.pathname}${location.search}&conversationControllerId=controller-b`, {
        replace: true,
        state: { ...location.state, instafyVisitKey: resultVisit },
      });
    });
    expect(location.key).not.toBe(resultKey);
    expect(getStudioVisitKey(location)).toBe(resultVisit);
    expect(window.history.state.idx).toBe(1);
    expect(history.originToken).toBe(token);
    await act(async () => history.returnToResults());
    await waitFor(assertAtResults);
  });

  it("records the base index when result activation starts inside a depth-two drawer", async () => {
    await act(async () => sidebar.setMobileSidebarOpen(true));
    await act(async () => sidebar.mobileSidebarNavigation.openView("more"));
    expect(window.history.state.idx).toBe(2);
    let token: string | null = null;
    await act(async () => {
      history.remember(snapshot);
      token = history.getOriginToken();
      sidebar.runAfterSidebarClose(() => go(
        { kind: "conversation", projectId: "space-a", conversationId: "chat-b", messageId: "message-b" },
        { forceNewVisit: true, searchOriginToken: token ?? undefined },
      ));
    });
    await waitFor(() => expect(new URLSearchParams(location.search).get("messageId")).toBe("message-b"));
    expect(window.history.state.idx).toBe(1);
    expect(history.originToken).toBe(token);
    expect(history.originToken).not.toBeNull();
    await act(async () => history.returnToResults());
    await waitFor(assertAtResults);
    expect(sidebar.mobileSidebarOpen).toBe(false);
  });

  it("recomputes the return after collapsing a result's depth-two drawer", async () => {
    await openResult();
    await act(async () => sidebar.setMobileSidebarOpen(true));
    await act(async () => sidebar.mobileSidebarNavigation.openView("more"));
    expect(window.history.state.idx).toBe(3);
    const returnToResults = history.returnToResults;
    let acknowledgeCollapse: () => void = () => {};
    let acknowledgeReturn: () => void = () => {};
    const collapsed = new Promise<void>(resolve => { acknowledgeCollapse = resolve; });
    const returned = new Promise<void>(resolve => { acknowledgeReturn = resolve; });
    const onReturn = () => acknowledgeReturn();
    window.addEventListener("popstate", () => {
      window.addEventListener("popstate", onReturn, { once: true });
      acknowledgeCollapse();
    }, { once: true });
    await act(async () => {
      sidebar.runAfterSidebarClose(returnToResults);
      await collapsed;
    });
    await act(async () => { await returned; });
    assertAtResults();
    expect(sidebar.mobileSidebarOpen).toBe(false);
  });

  it.each(["key", "idx"] as const)("rejects a stale rendered result when the live Router %s changed", async (field) => {
    await openResult();
    const move = vi.spyOn(window.history, "go");
    window.history.replaceState({ ...window.history.state,
      [field]: field === "key" ? "unrendered-visit" : window.history.state.idx + 1,
    }, "", window.location.href);
    await act(async () => history.returnToResults());
    expect(move).not.toHaveBeenCalled();
  });

  it("dispatches only one return before the first traversal is acknowledged", async () => {
    await openResult();
    const move = vi.spyOn(window.history, "go").mockImplementation(() => {});
    await act(async () => {
      history.returnToResults();
      history.returnToResults();
    });
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith(-1);
  });
});
