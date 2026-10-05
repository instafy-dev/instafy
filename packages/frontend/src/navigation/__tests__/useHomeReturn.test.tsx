// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeReturn } from "../useHomeReturn";

describe("Home return", () => {
  let root: Root;
  let container: HTMLDivElement;
  let navigate: ReturnType<typeof useNavigate>;
  let location: ReturnType<typeof useLocation>;
  let homeReturn: ReturnType<typeof useHomeReturn>;
  let userId: string | null;
  function Harness() {
    navigate = useNavigate();
    location = useLocation();
    homeReturn = useHomeReturn(userId, new URLSearchParams(location.search).get("panel") === "home");
    return null;
  }
  const render = () => act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>));
  const push = (search: string, options?: { replace?: boolean; state?: unknown }) => act(async () => {
    await navigate(`/studio?${search}`, options);
  });
  const move = async (action: () => void) => {
    const key = location.key;
    await act(async () => {
      action();
      await vi.waitFor(() => expect(window.history.state.key).not.toBe(key));
    });
  };
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({ idx: 0, key: "initial" }, "", "/studio?panel=home");
    userId = "viewer";
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

  it("has no invented destination on a fresh Home launch or after changing accounts", async () => {
    expect(homeReturn.canReturn).toBe(false);
    await push("projectId=space-a&panel=settings&settingsCategory=appearance");
    await push("panel=home");
    expect(homeReturn.canReturn).toBe(true);
    const stale = homeReturn.returnToPrevious;
    userId = "another-viewer";
    await render();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    stale(); homeReturn.returnToPrevious();
    expect(homeReturn.canReturn).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });

  it("returns to the exact team, space, settings and visit after Home filters and a picker", async () => {
    await push("teamId=team-b&projectId=space-b&panel=settings&settingsTab=profile&settingsCategory=appearance");
    const origin = location;
    await push("panel=home&teamId=team-b");
    await push("panel=home&teamId=team-c");
    const homeKey = location.key;
    await push("panel=home&teamId=team-c", { state: { instafyVisitKey: homeKey, instafySidebar: { view: "workspace" } } });
    await move(() => navigate(-1));
    await move(homeReturn.returnToPrevious);
    expect(location.key).toBe(origin.key);
    expect(location.search).toBe(origin.search);
    expect(homeReturn.canReturn).toBe(false);
  });

  it("keeps each Home visit's own origin through browser Back and Forward", async () => {
    await push("projectId=first&conversationId=chat-a&reviewTab=review-a");
    const first = location.key;
    await push("panel=home");
    await push("projectId=second&panel=skills");
    const second = location.key;
    await push("panel=home");
    await move(homeReturn.returnToPrevious);
    expect(location.key).toBe(second);
    await move(() => navigate(-1));
    await move(homeReturn.returnToPrevious);
    expect(location.key).toBe(first);
    await move(() => navigate(1));
    expect(homeReturn.canReturn).toBe(true);
    await move(homeReturn.returnToPrevious);
    expect(location.key).toBe(first);
  });

  it("carries the target through Home replacements and rejects rapid or stale clicks", async () => {
    await push("panel=skills");
    await push("panel=home");
    await push("panel=home&teamId=team-b", { replace: true });
    expect(homeReturn.canReturn).toBe(true);
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    homeReturn.returnToPrevious(); homeReturn.returnToPrevious();
    expect(go).toHaveBeenCalledTimes(1);
    go.mockClear();
    window.history.pushState({ idx: 3, key: "unrendered" }, "", "/studio?panel=credits");
    homeReturn.returnToPrevious();
    expect(go).not.toHaveBeenCalled();
  });

  it("does not return to an origin replaced with another page", async () => {
    await push("panel=skills");
    await push("panel=home");
    await move(homeReturn.returnToPrevious);
    await push("panel=credits", { replace: true });
    await move(() => navigate(1));
    expect(homeReturn.canReturn).toBe(false);
  });
});
