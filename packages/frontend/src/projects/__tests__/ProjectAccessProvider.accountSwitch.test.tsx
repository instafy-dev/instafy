// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAppRouter } from "../../navigation/appRouterBridge";
import { clearRestoredAwaitingIntent } from "../../runtime/idlePauseRegistry";
import { useWorkspaceStore } from "../../store";
import { ProjectAccessProvider, useProjectAccess } from "../ProjectAccessProvider";
import { ProjectStateProvider } from "../ProjectStateProvider";

const FIRST_ACCOUNT_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ACCOUNT_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const mocks = vi.hoisted(() => ({ create: vi.fn(), getSummaryResult: vi.fn(), listResult: vi.fn() }));

// The signed-in account, as a store the provider re-renders from, so a test
// can switch accounts in place the way another tab signing in does.
const auth = vi.hoisted(() => {
  let user = { id: "first-account" };
  const listeners = new Set<() => void>();
  return {
    get: () => user,
    set: (next: { id: string }) => {
      user = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

const ownedBy: Record<string, string> = {
  [FIRST_ACCOUNT_PROJECT_ID]: "first-account",
  [SECOND_ACCOUNT_PROJECT_ID]: "second-account",
};

const summaryFor = (projectId: string) => {
  if (ownedBy[projectId] !== auth.get().id) {
    return { summary: null, notFound: false, forbidden: true, unauthorized: false };
  }
  return {
    summary: {
      projectId,
      projectName: "Space",
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
  };
};

vi.mock("../../lib/supabaseClient", () => ({ hasSupabaseConfig: true }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { projects: mocks } }));
vi.mock("../../providers/AuthProvider", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAuth: () => ({ user: useSyncExternalStore(auth.subscribe, auth.get), loading: false }),
  };
});

function RouteProbe() {
  const location = useLocation();
  const access = useProjectAccess();
  return (
    <output
      data-testid="route-probe"
      data-search={location.search}
      data-blocked={String(access.projectAccessBlocked)}
      data-pending={String(access.projectAccessPending)}
    />
  );
}

describe("ProjectAccessProvider when the account changes in place", () => {
  let root: Root;
  let container: HTMLDivElement;
  let unregisterRouter: (() => void) | null = null;

  const settle = async () => {
    await act(async () => {
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    auth.set({ id: "first-account" });
    mocks.create.mockReset();
    mocks.getSummaryResult.mockReset();
    mocks.listResult.mockReset();
    mocks.getSummaryResult.mockImplementation((projectId: string) => Promise.resolve(summaryFor(projectId)));
    mocks.listResult.mockImplementation(() =>
      Promise.resolve({
        status: "success",
        projects: Object.entries(ownedBy)
          .filter(([, owner]) => owner === auth.get().id)
          .map(([projectId]) => ({ projectId, projectType: "customer", status: "active" })),
      }),
    );
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    useWorkspaceStore.setState({ projects: {}, activeProjectId: "" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    unregisterRouter?.();
    unregisterRouter = null;
    await act(async () => root.unmount());
    container.remove();
    clearRestoredAwaitingIntent(FIRST_ACCOUNT_PROJECT_ID);
    clearRestoredAwaitingIntent(SECOND_ACCOUNT_PROJECT_ID);
    useWorkspaceStore.setState({ projects: {}, activeProjectId: "" });
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("opens the new account's own space instead of the old account's space the URL named", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/studio",
          element: (
            <ProjectStateProvider>
              <ProjectAccessProvider>
                <RouteProbe />
              </ProjectAccessProvider>
            </ProjectStateProvider>
          ),
        },
      ],
      { initialEntries: [`/studio?projectId=${FIRST_ACCOUNT_PROJECT_ID}&panel=chat`] },
    );
    unregisterRouter = registerAppRouter(router);
    await act(async () => root.render(<RouterProvider router={router} />));
    await settle();
    const probe = () => container.querySelector<HTMLElement>("[data-testid='route-probe']");
    expect(probe()?.dataset.blocked).toBe("false");
    expect(useWorkspaceStore.getState().activeProjectId).toBe(FIRST_ACCOUNT_PROJECT_ID);

    // Another tab signs in as someone else. The reset clears the old space from
    // the URL; the router has to hear it, since the lookup reads the router.
    await act(async () => auth.set({ id: "second-account" }));
    await settle();
    await settle();

    const params = new URLSearchParams(router.state.location.search);
    expect(params.get("projectId")).toBe(SECOND_ACCOUNT_PROJECT_ID);
    expect(params.get("panel")).toBe("chat");
    expect(probe()?.dataset.blocked).toBe("false");
    expect(probe()?.dataset.pending).toBe("false");
    expect(useWorkspaceStore.getState().activeProjectId).toBe(SECOND_ACCOUNT_PROJECT_ID);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
