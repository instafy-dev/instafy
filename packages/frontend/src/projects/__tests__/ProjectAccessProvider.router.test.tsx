// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStudioVisitKey } from "../../navigation/studioVisit";
import { useWorkspaceStore } from "../../store";
import { PROJECT_ACCESS_REFRESH_EVENT, ProjectAccessProvider, useProjectAccess } from "../ProjectAccessProvider";
import { ProjectMetadataProvider } from "../ProjectMetadataProvider";
import { ProjectStateProvider } from "../ProjectStateProvider";
import { useProject } from "../useProject";
import { markProjectDeletedHere, unmarkProjectDeletedHere } from "../projectDeletion";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const mocks = vi.hoisted(() => ({ create: vi.fn(), getSummaryResult: vi.fn(), listResult: vi.fn() }));

const NOT_FOUND = { summary: null, notFound: true, forbidden: false, unauthorized: false };

const summaryFor = (projectId: string) => ({
  summary: {
    projectId,
    projectName: projectId === PROJECT_ID ? "Remembered space" : "Other space",
    orgId: "org-1",
    orgName: "Team",
    effectiveRole: "owner",
    canWrite: true,
    canShare: true,
    canManage: true,
  },
  notFound: false,
  forbidden: false,
  unauthorized: false,
});

function deferredSummary() {
  let resolve: (value: ReturnType<typeof summaryFor>) => void = () => {};
  const promise = new Promise<ReturnType<typeof summaryFor>>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

vi.mock("../../lib/supabaseClient", () => ({ hasSupabaseConfig: true }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { projects: mocks } }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "router-user" }, loading: false }) }));

// Unlike ProjectAccessProvider.test.tsx, nothing here mocks useLocation: the
// provider runs inside a real router, so a URL write the router never hears
// about shows up as a missing projectId in the routed location.
type RuntimeWindow = typeof window & {
  __INSTAFY_ACTIVE_PROJECT_ID__?: string | null;
  __INSTAFY_PROJECT_INITIALIZED__?: boolean;
};

// The space the runtime, chat and tab readers fall back to when the store has
// none open.
const windowActiveProjectId = () => (window as RuntimeWindow).__INSTAFY_ACTIVE_PROJECT_ID__;

function RouteProbe() {
  const location = useLocation();
  const access = useProjectAccess();
  const { activeProjectName } = useProject();
  return (
    <output
      data-testid="route-probe"
      data-search={location.search}
      data-hash={location.hash}
      data-state={JSON.stringify(location.state ?? null)}
      data-initialized={String(access.projectInitialized)}
      data-pending={String(access.projectAccessPending)}
      data-blocked={String(access.projectAccessBlocked)}
      data-deleted={String(access.projectAccessDeleted)}
      data-project-name={String(activeProjectName)}
    />
  );
}

describe("ProjectAccessProvider inside a real router", () => {
  let root: Root;
  let container: HTMLDivElement;

  // Promise continuations only. Inside act() React holds its own work until
  // the callback returns, which is how these tests stand in for the window in
  // which the router has moved but has not published to React yet.
  const flushMicrotasks = async () => {
    for (let index = 0; index < 12; index += 1) {
      await Promise.resolve();
    }
  };

  const settle = async () => {
    await act(async () => {
      await flushMicrotasks();
    });
  };

  const renderAt = (entry: { pathname: string; search?: string; hash?: string; state?: unknown }) => {
    const router = createMemoryRouter(
      [
        {
          path: "/studio",
          element: (
            <ProjectStateProvider>
              <ProjectMetadataProvider>
                <ProjectAccessProvider>
                  <RouteProbe />
                </ProjectAccessProvider>
              </ProjectMetadataProvider>
            </ProjectStateProvider>
          ),
        },
        { path: "/install", element: <p data-testid="install-page" /> },
      ],
      { initialEntries: [entry] },
    );
    return router;
  };

  const routedProjectId = (router: ReturnType<typeof renderAt>) =>
    new URLSearchParams(router.state.location.search).get("projectId");

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.create.mockReset();
    mocks.getSummaryResult.mockReset();
    mocks.listResult.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    // The space the person last worked in, remembered by the workspace store
    // across sign-in. Sign-in then lands on /studio with no projectId.
    useWorkspaceStore.setState({ projects: {}, activeProjectId: "" });
    useWorkspaceStore.getState().createProject({ projectId: PROJECT_ID, projectName: "Remembered space" });
    mocks.getSummaryResult.mockImplementation((projectId: string) => Promise.resolve(summaryFor(projectId)));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useWorkspaceStore.setState({ projects: {}, activeProjectId: "" });
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    delete (window as RuntimeWindow).__INSTAFY_ACTIVE_PROJECT_ID__;
    delete (window as RuntimeWindow).__INSTAFY_PROJECT_INITIALIZED__;
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("tells the router which space it resolved, keeping the rest of the visit, and reads access once", async () => {
    const visitState = { instafyVisitKey: "visit-after-sign-in", from: "login" };
    const router = renderAt({ pathname: "/studio", search: "?workspaceTab=files", hash: "#latest", state: visitState });
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();

    const probe = container.querySelector('[data-testid="route-probe"]');
    // The studio URL writer and chat scroll restore read this routed location.
    // Without projectId in it, the chat stayed at its oldest message.
    const params = new URLSearchParams(probe?.getAttribute("data-search") ?? "");
    expect(params.get("projectId")).toBe(PROJECT_ID);
    expect(params.get("workspaceTab")).toBe("files");
    expect(probe?.getAttribute("data-hash")).toBe("#latest");
    expect(JSON.parse(probe?.getAttribute("data-state") ?? "null")).toEqual(visitState);
    expect(router.state.location.pathname).toBe("/studio");
    expect(router.state.historyAction).toBe("REPLACE");

    // The router reporting the provider's own write is not a new choice: no
    // second lookup, and access does not fall back to pending.
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);
    expect(mocks.getSummaryResult).toHaveBeenCalledWith(PROJECT_ID, { signal: expect.any(AbortSignal) });
    expect(probe?.getAttribute("data-initialized")).toBe("true");
    expect(probe?.getAttribute("data-pending")).toBe("false");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps the visit identity of a plain /studio entry across the replacement", async () => {
    const router = renderAt({ pathname: "/studio" });
    const visitKeyBefore = getStudioVisitKey(router.state.location);
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();

    expect(new URLSearchParams(router.state.location.search).get("projectId")).toBe(PROJECT_ID);
    expect(router.state.location.key).not.toBe(visitKeyBefore);
    expect(getStudioVisitKey(router.state.location)).toBe(visitKeyBefore);
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);
  });

  it("still looks up a space whose URL write another navigation overtook before it rendered", async () => {
    const lookup = deferredSummary();
    mocks.getSummaryResult.mockImplementationOnce(() => lookup.promise);
    const router = renderAt({ pathname: "/studio" });
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();

    await act(async () => {
      lookup.resolve(summaryFor(PROJECT_ID));
      await flushMicrotasks();
      expect(routedProjectId(router)).toBe(PROJECT_ID);
      // A deep link to another space lands before React renders the write,
      // so the provider never sees its own projectId come back.
      await router.navigate(`/studio?projectId=${OTHER_PROJECT_ID}`);
    });
    await settle();
    expect(useWorkspaceStore.getState().activeProjectId).toBe(OTHER_PROJECT_ID);

    const lookupsBefore = mocks.getSummaryResult.mock.calls.filter(([id]) => id === PROJECT_ID).length;
    await act(async () => {
      await router.navigate(`/studio?projectId=${PROJECT_ID}`);
    });
    await settle();

    // Going back to the first space is a new choice, not the old write.
    expect(useWorkspaceStore.getState().activeProjectId).toBe(PROJECT_ID);
    expect(mocks.getSummaryResult.mock.calls.filter(([id]) => id === PROJECT_ID).length).toBeGreaterThan(lookupsBefore);
  });

  it("writes onto the entry the router is on, not the one React last rendered", async () => {
    const router = renderAt({ pathname: "/studio", search: `?projectId=${PROJECT_ID}` });
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);

    // A support link drops projectId, which starts another lookup.
    const lookup = deferredSummary();
    mocks.getSummaryResult.mockImplementationOnce(() => lookup.promise);
    await act(async () => {
      await router.navigate("/studio?supportReportId=r1");
    });
    await settle();
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(2);

    await act(async () => {
      await router.navigate("/studio?supportReportId=r1&conversationId=c1");
      lookup.resolve(summaryFor(PROJECT_ID));
      await flushMicrotasks();
    });
    await settle();

    const params = new URLSearchParams(router.state.location.search);
    expect(params.get("projectId")).toBe(PROJECT_ID);
    expect(params.get("supportReportId")).toBe("r1");
    expect(params.get("conversationId")).toBe("c1");
  });

  it("leaves a navigation away from the studio where it went", async () => {
    const lookup = deferredSummary();
    mocks.getSummaryResult.mockImplementationOnce(() => lookup.promise);
    const router = renderAt({ pathname: "/studio" });
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();

    await act(async () => {
      // Back or a link out, taken while the startup lookup is in flight.
      await router.navigate("/install");
      lookup.resolve(summaryFor(PROJECT_ID));
      await flushMicrotasks();
    });
    await settle();

    expect(router.state.location.pathname).toBe("/install");
    expect(router.state.location.search).toBe("");
    expect(router.state.historyAction).toBe("PUSH");
    expect(container.querySelector('[data-testid="install-page"]')).not.toBeNull();
  });

  it("leaves a newer entry that names another space to that space's own lookup", async () => {
    const lookup = deferredSummary();
    mocks.getSummaryResult.mockImplementationOnce(() => lookup.promise);
    const router = renderAt({ pathname: "/studio" });
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();

    await act(async () => {
      await router.navigate(`/studio?projectId=${OTHER_PROJECT_ID}`);
      lookup.resolve(summaryFor(PROJECT_ID));
      await flushMicrotasks();
    });
    await settle();

    expect(routedProjectId(router)).toBe(OTHER_PROJECT_ID);
    expect(useWorkspaceStore.getState().activeProjectId).toBe(OTHER_PROJECT_ID);
    expect(mocks.getSummaryResult).toHaveBeenCalledWith(OTHER_PROJECT_ID, { signal: expect.any(AbortSignal) });
  });

  // A background tab had a space open when another tab deleted it. The notice
  // took the main area, but the store opened another space this browser knew
  // behind it: its name in the sidebar and the title, its files in the Files
  // panel, and its runs, events and integrations polled, as if they were the
  // deleted space's.
  it("leaves no other space open behind a space deleted in another tab, until one is picked", async () => {
    useWorkspaceStore.setState({ projects: {}, activeProjectId: "" });
    useWorkspaceStore.getState().createProject({ projectId: OTHER_PROJECT_ID, projectName: "Other space" });
    useWorkspaceStore.getState().createProject({ projectId: PROJECT_ID, projectName: "Remembered space" });
    const search = `?projectId=${PROJECT_ID}&workspaceTab=files`;
    window.history.replaceState(null, "", `/studio${search}`);
    const router = renderAt({ pathname: "/studio", search });
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();
    expect(useWorkspaceStore.getState().activeProjectId).toBe(PROJECT_ID);
    expect(windowActiveProjectId()).toBe(PROJECT_ID);

    mocks.getSummaryResult.mockClear();
    mocks.getSummaryResult.mockImplementation((projectId: string) =>
      Promise.resolve(projectId === PROJECT_ID ? NOT_FOUND : summaryFor(projectId)));
    await act(async () => {
      window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
        detail: { projectId: null, deletedProjectId: PROJECT_ID },
      }));
    });
    await settle();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    const probe = container.querySelector('[data-testid="route-probe"]');
    expect(probe?.getAttribute("data-blocked")).toBe("true");
    expect(probe?.getAttribute("data-deleted")).toBe("true");
    expect(routedProjectId(router)).toBe(PROJECT_ID);
    expect(useWorkspaceStore.getState().activeProjectId).toBe("");
    expect(Object.keys(useWorkspaceStore.getState().projects)).toEqual([OTHER_PROJECT_ID]);
    expect(mocks.getSummaryResult.mock.calls.map(([projectId]) => projectId)).toEqual([PROJECT_ID]);
    // Nothing reading the window for the open space keeps reading the deleted
    // one (runs, runtimes, chat sends), and no phantom "Untitled space" is
    // named for the space that is not open.
    expect(windowActiveProjectId()).toBeNull();
    expect(probe?.getAttribute("data-project-name")).toBe("null");

    // Picking a space from the picker names it in the URL and opens it.
    window.history.replaceState(null, "", `/studio?projectId=${OTHER_PROJECT_ID}`);
    await act(async () => {
      await router.navigate(`/studio?projectId=${OTHER_PROJECT_ID}`);
    });
    await settle();

    expect(useWorkspaceStore.getState().activeProjectId).toBe(OTHER_PROJECT_ID);
    expect(probe?.getAttribute("data-blocked")).toBe("false");
    expect(mocks.getSummaryResult).toHaveBeenCalledWith(OTHER_PROJECT_ID, { signal: expect.any(AbortSignal) });
    expect(windowActiveProjectId()).toBe(OTHER_PROJECT_ID);
    expect(probe?.getAttribute("data-project-name")).toBe("Other space");
  });

  it("opens no remembered space behind a link to a space that is gone", async () => {
    mocks.getSummaryResult.mockImplementation((projectId: string) =>
      Promise.resolve(projectId === OTHER_PROJECT_ID ? NOT_FOUND : summaryFor(projectId)));
    const search = `?projectId=${OTHER_PROJECT_ID}`;
    window.history.replaceState(null, "", `/studio${search}`);
    const router = renderAt({ pathname: "/studio", search });
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();

    const probe = container.querySelector('[data-testid="route-probe"]');
    expect(probe?.getAttribute("data-blocked")).toBe("true");
    expect(routedProjectId(router)).toBe(OTHER_PROJECT_ID);
    expect(useWorkspaceStore.getState().activeProjectId).toBe("");
    expect(Object.keys(useWorkspaceStore.getState().projects)).toEqual([PROJECT_ID]);
    expect(new Set(mocks.getSummaryResult.mock.calls.map(([projectId]) => projectId))).toEqual(new Set([OTHER_PROJECT_ID]));
    expect(windowActiveProjectId()).toBeNull();
    expect(probe?.getAttribute("data-project-name")).toBe("null");
  });

  it("still moves the tab that deleted a space on to the next one", async () => {
    useWorkspaceStore.setState({ projects: {}, activeProjectId: "" });
    useWorkspaceStore.getState().createProject({ projectId: OTHER_PROJECT_ID, projectName: "Other space" });
    useWorkspaceStore.getState().createProject({ projectId: PROJECT_ID, projectName: "Remembered space" });
    const search = `?projectId=${PROJECT_ID}`;
    window.history.replaceState(null, "", `/studio${search}`);
    const router = renderAt({ pathname: "/studio", search });
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();

    mocks.getSummaryResult.mockImplementation((projectId: string) =>
      Promise.resolve(projectId === PROJECT_ID ? NOT_FOUND : summaryFor(projectId)));
    markProjectDeletedHere(PROJECT_ID);
    try {
      // The settings delete: open the next space, then drop the deleted one
      // and tell the other lists.
      window.history.replaceState(null, "", `/studio?projectId=${OTHER_PROJECT_ID}&panel=projects`);
      await act(async () => {
        await router.navigate(`/studio?projectId=${OTHER_PROJECT_ID}&panel=projects`, { replace: true });
        useWorkspaceStore.getState().switchProject(OTHER_PROJECT_ID);
        useWorkspaceStore.getState().removeProject(PROJECT_ID);
        window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
          detail: { projectId: null, deletedProjectId: PROJECT_ID },
        }));
      });
      await settle();
    } finally {
      unmarkProjectDeletedHere(PROJECT_ID);
    }

    const probe = container.querySelector('[data-testid="route-probe"]');
    expect(useWorkspaceStore.getState().activeProjectId).toBe(OTHER_PROJECT_ID);
    expect(Object.keys(useWorkspaceStore.getState().projects)).toEqual([OTHER_PROJECT_ID]);
    expect(probe?.getAttribute("data-blocked")).toBe("false");
    expect(routedProjectId(router)).toBe(OTHER_PROJECT_ID);
  });
});
