// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAppRouter } from "../../navigation/appRouterBridge";
import { getStudioVisitKey } from "../../navigation/studioVisit";
import { clearProjectState } from "../projectClear";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONTROLLER_ID = "33333333-3333-4333-8333-333333333333";
const SPACE_SEARCH = `?projectId=${PROJECT_ID}&conversationId=local-1&conversationControllerId=${CONTROLLER_ID}&panel=chat`;

function RouteProbe() {
  const location = useLocation();
  return <output data-testid="route-probe" data-search={location.search} data-hash={location.hash} />;
}

const routerAt = (entry: { pathname: string; search: string; hash?: string; state?: unknown }) =>
  createMemoryRouter([{ path: "/studio", element: <RouteProbe /> }], { initialEntries: [entry] });

describe("clearProjectState", () => {
  let root: Root;
  let container: HTMLDivElement;
  let unregisterRouter: (() => void) | null = null;

  const probe = () => container.querySelector<HTMLElement>("[data-testid='route-probe']");

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    unregisterRouter?.();
    unregisterRouter = null;
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("moves the registered router off the cleared space and keeps the rest of the visit", async () => {
    const router = routerAt({ pathname: "/studio", search: SPACE_SEARCH, hash: "#latest" });
    unregisterRouter = registerAppRouter(router);
    await act(async () => root.render(<RouterProvider router={router} />));
    const visitKey = getStudioVisitKey(router.state.location);
    expect(probe()?.dataset.search).toBe(SPACE_SEARCH);

    await act(async () => {
      clearProjectState();
      await Promise.resolve();
    });

    // What the studio's URL writer and the project bootstrap read.
    expect(router.state.location.pathname).toBe("/studio");
    expect(router.state.location.search).toBe("?panel=chat");
    expect(router.state.location.hash).toBe("#latest");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(getStudioVisitKey(router.state.location)).toBe(visitKey);
    expect(probe()?.dataset.search).toBe("?panel=chat");
    expect(probe()?.dataset.hash).toBe("#latest");
  });

  it("leaves a router whose URL names no space where it is", async () => {
    const router = routerAt({ pathname: "/studio", search: "?panel=chat" });
    unregisterRouter = registerAppRouter(router);
    const navigate = vi.spyOn(router, "navigate");
    await act(async () => root.render(<RouterProvider router={router} />));
    const before = router.state.location;

    await act(async () => {
      clearProjectState();
      await Promise.resolve();
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(router.state.location).toBe(before);
  });

  it("writes window.history directly, as before, when no router is registered", () => {
    // A router registered and then released is no longer moved.
    const released = routerAt({ pathname: "/studio", search: SPACE_SEARCH });
    registerAppRouter(released)();
    const historyState = { usr: { from: "login" }, key: "entry-1", idx: 0 };
    window.history.replaceState(historyState, "", `/studio${SPACE_SEARCH}#latest`);
    window.localStorage.setItem("instafy.lastProjectId", PROJECT_ID);
    const replaceState = vi.spyOn(window.history, "replaceState");

    clearProjectState();

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(historyState, document.title, "/studio?panel=chat#latest");
    expect(window.location.pathname).toBe("/studio");
    expect(window.location.search).toBe("?panel=chat");
    expect(window.location.hash).toBe("#latest");
    expect(window.history.state).toEqual(historyState);
    expect(window.localStorage.getItem("instafy.lastProjectId")).toBeNull();
    expect(released.state.location.search).toBe(SPACE_SEARCH);
  });
});
