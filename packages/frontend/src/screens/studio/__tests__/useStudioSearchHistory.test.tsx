// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStudioVisitKey } from "../../../navigation/studioVisit";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import { useStudioHistory } from "../../../navigation/useStudioHistory";
import { MobileStudioHistoryControls } from "../components/MobileStudioHistoryControls";
import { StudioSearchReturnProvider } from "../components/StudioSearchReturnContext";
import { useStudioSearch, type StudioSearchRequest } from "../components/useStudioSearch";
import { useStudioSearchHistory } from "../useStudioSearchHistory";

describe("search result browser history", () => {
  let root: Root;
  let container: HTMLDivElement;
  let navigate: NavigateFunction;
  let viewer = "viewer-a";
  let sameDestination = false;
  let queryRequests: StudioSearchRequest[];
  let lastSearch: ReturnType<typeof useStudioSearch>;
  let lastHistory: ReturnType<typeof useStudioSearchHistory>;
  function Harness() {
    const location = useLocation();
    navigate = useNavigate();
    const go = useStudioNavigation();
    const scopeKey = `${viewer}:${getStudioVisitKey(location)}:${location.search}`;
    const history = useStudioSearchHistory(viewer, getStudioVisitKey(location), scopeKey);
    const appHistory = useStudioHistory();
    lastHistory = history;
    lastSearch = useStudioSearch({
      scopeKey, org: null, space: null, persistentControl: true,
      restoreSession: history.restoredSession, onBeforeResultActivate: history.remember, onDismiss: history.dismiss,
      onRequestChange: (request) => queryRequests.push(request), messagePageCount: 2,
      records: [{ id: "message-hit", title: "Earlier discussion", description: "Team / Space", keywords: "", group: "Messages",
        orgId: "org-a", spaceId: "space-a", message: { excerpt: "a needle in earlier history", query: "needle",
          matchRanges: [{ start: 2, end: 8 }], authorLabel: "Assistant", createdAt: "2026-09-10T00:00:00Z" },
        activate: () => go({ kind: "conversation", projectId: sameDestination ? "space-a" : "space-b",
          conversationId: sameDestination ? "chat-a" : "chat-b", messageId: "message-a" },
        { forceNewVisit: true, searchOriginToken: history.getOriginToken() ?? undefined }),
      }],
    });
    return <StudioSearchReturnProvider value={history}>
      <MobileStudioHistoryControls history={appHistory} returnToSearch={!lastSearch.open} />
      {lastSearch.renderControl()}{lastSearch.results}
    </StudioSearchReturnProvider>;
  }
  async function render() { await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>)); }
  const input = () => container.querySelector<HTMLInputElement>("input")!;
  const result = () => container.querySelector<HTMLButtonElement>('[data-testid="studio-search-result-message-hit"]')!;
  async function typeQuery() {
    await act(async () => {
      input().focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), "needle");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function travel(delta: number) {
    await act(async () => {
      const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
      await navigate(delta);
      await popped;
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  async function pressHistory(testId: string) {
    await act(async () => {
      const popped = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
      container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
      await popped;
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    viewer = "viewer-a";
    sameDestination = false;
    queryRequests = [];
    window.history.replaceState(null, "", "/studio?projectId=space-a&conversationId=chat-a&messageId=message-a");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([false, true])("returns to query, results and scroll after opening a result (same URL: %s)", async (same) => {
    sameDestination = same;
    await render();
    await typeQuery();
    expect(result().querySelector("mark")?.textContent).toBe("needle");
    container.querySelector<HTMLElement>('[data-testid="studio-search-results"]')!.scrollTop = 730;
    await act(async () => result().click());
    expect(lastSearch.open).toBe(false);
    expect(lastHistory.originToken).not.toBeNull();
    expect(new URLSearchParams(window.location.search).get("projectId")).toBe(same ? "space-a" : "space-b");
    await pressHistory("mobile-header-results");
    expect(lastSearch.open).toBe(true);
    expect(input().value).toBe("needle");
    expect(result()).not.toBeNull();
    expect(container.querySelector<HTMLElement>('[data-testid="studio-search-results"]')!.scrollTop).toBe(730);
    expect(queryRequests).toContainEqual({ open: true, query: "needle", scope: "all", restoreMessagePages: 2 });
    expect(container.querySelector('[data-testid="mobile-header-results"]')).toBeNull();
    await pressHistory("mobile-header-forward");
    expect(lastSearch.open).toBe(false);
    expect(result()).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="mobile-header-forward"]')?.disabled).toBe(true);
    await travel(-1);
    expect(lastSearch.open).toBe(true);
    expect(input().value).toBe("needle");
  });

  it("does not restore another account's query on Back", async () => {
    await render();
    await typeQuery();
    await act(async () => result().click());
    viewer = "viewer-b";
    await render();
    await travel(-1);
    expect(lastSearch.open).toBe(false);
    expect(input().value).toBe("");
    expect(result()).toBeNull();
  });
});
