// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  createControllerProject: vi.fn(),
  createProject: vi.fn(),
  getSummaryResult: vi.fn(),
  removeProject: vi.fn(),
  removeProjectsByOrgId: vi.fn(),
  setProjectName: vi.fn(),
  setProjectOrg: vi.fn(),
  switchProject: vi.fn(),
  recordProjectOpened: vi.fn(),
  useAuth: vi.fn(),
  listProjects: vi.fn(),
  navigate: vi.fn(),
  // Mutable per test: the startup path under test is the one with nothing
  // remembered, so a test can empty the active project and the URL.
  activeProjectId: "11111111-1111-4111-8111-111111111111",
  locationSearch: "?projectId=11111111-1111-4111-8111-111111111111",
  // Mutable per test: a self-hosted app built without Supabase.
  hasSupabaseConfig: true,
  // Mutable per test: the spaces this tab lists besides the open one.
  otherProjects: {} as Record<string, { metadata: { projectName: string }; org: { id: string; name: string } }>,
}));

vi.mock("../../lib/supabaseClient", () => ({
  get hasSupabaseConfig() {
    return mocks.hasSupabaseConfig;
  },
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    projects: {
      create: mocks.createControllerProject,
      getSummaryResult: mocks.getSummaryResult,
      listResult: mocks.listProjects,
    },
  },
}));

vi.mock("../ProjectStateProvider", () => ({
  useProjectState: () => ({
    projects: {
      ...mocks.otherProjects,
      [PROJECT_ID]: {
        metadata: { projectName: "Shared space" },
        org: { id: "org-1", name: "Team" },
      },
    },
    activeProjectId: mocks.activeProjectId,
    createProject: mocks.createProject,
    switchProject: mocks.switchProject,
    setProjectOrg: mocks.setProjectOrg,
    setProjectName: mocks.setProjectName,
    removeProject: mocks.removeProject,
    removeProjectsByOrgId: mocks.removeProjectsByOrgId,
  }),
}));

vi.mock("../../providers/AuthProvider", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useLocation: () => ({
      pathname: "/studio",
      search: mocks.locationSearch,
      hash: "",
      state: null,
      key: "test",
    }),
    // No router is mounted here; the routed write is covered by
    // ProjectAccessProvider.router.test.tsx.
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("../projectRecency", () => ({ recordProjectOpened: mocks.recordProjectOpened }));
vi.mock("../../workspace/projectClear", () => ({ clearProjectState: vi.fn() }));

import {
  PROJECT_ACCESS_REFRESH_EVENT,
  ProjectAccessProvider,
  useProjectAccess,
} from "../ProjectAccessProvider";
import { markProjectDeletedHere, unmarkProjectDeletedHere } from "../projectDeletion";
import { suppressProjectAutoCreate } from "../projectAutoCreate";
import { reportControllerProjectNotFound } from "../../services/runtimeController/projectNotFound";
import { ProjectAccessRecoveryBanner, StudioStartupGate } from "../../screens/StudioStartup";

function AccessProbe() {
  const access = useProjectAccess();
  return (
    <output
      data-testid="access-probe"
      data-role={access.effectiveProjectRole ?? "none"}
      data-write={String(access.canWriteProject)}
      data-share={String(access.canShareProject)}
      data-resolved={String(access.projectCapabilitiesResolved)}
      data-blocked={String(access.projectAccessBlocked)}
      data-deleted={String(access.projectAccessDeleted)}
      data-initialized={String(access.projectInitialized)}
      data-pending={String(access.projectAccessPending)}
      data-provision-failed={String(access.projectProvisionFailed)}
      data-attachments={access.chatAttachments ?? "unknown"}
    />
  );
}

function summaryFor(role: "admin" | "viewer") {
  const admin = role === "admin";
  return {
    summary: {
      projectId: PROJECT_ID,
      projectName: "Shared space",
      orgId: "org-1",
      orgName: "Team",
      effectiveRole: role,
      canWrite: admin,
      canShare: admin,
      canManage: admin,
    },
    notFound: false,
    forbidden: false,
    unauthorized: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ProjectAccessProvider capability refresh", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, "", `/studio?projectId=${PROJECT_ID}`);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.values(mocks).forEach((mock) => {
      if (typeof mock === "function") mock.mockReset();
    });
    mocks.activeProjectId = PROJECT_ID;
    mocks.locationSearch = `?projectId=${PROJECT_ID}`;
    mocks.otherProjects = {};
    mocks.useAuth.mockReturnValue({ user: { id: "user-1", email: "user@example.test" } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the shared Octo gate visible until the initial project lookup settles", async () => {
    const lookup = deferred<ReturnType<typeof summaryFor>>();
    mocks.getSummaryResult.mockReturnValueOnce(lookup.promise);
    await act(async () => root.render(
      <ProjectAccessProvider>
        <AccessProbe />
        <StudioStartupGate><p>Workspace ready</p></StudioStartupGate>
      </ProjectAccessProvider>,
    ));

    const probe = container.querySelector('[data-testid="access-probe"]');
    expect(container.querySelector('[data-testid="entry-loading-screen"]')).not.toBeNull();
    expect(container.querySelector('[data-octo-motion="thinking"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Getting things ready…");
    expect(container.textContent).not.toContain("Workspace ready");
    expect(probe?.getAttribute("data-initialized")).toBe("false");
    expect(probe?.getAttribute("data-pending")).toBe("true");
    expect(probe?.getAttribute("data-write")).toBe("false");
    expect(mocks.createControllerProject).not.toHaveBeenCalled();
    expect(mocks.recordProjectOpened).not.toHaveBeenCalled();

    await act(async () => lookup.resolve(summaryFor("viewer")));
    expect(mocks.recordProjectOpened).toHaveBeenCalledWith(PROJECT_ID, undefined, "user@example.test");
    expect(probe?.getAttribute("data-initialized")).toBe("true");
    expect(probe?.getAttribute("data-pending")).toBe("false");
    expect(probe?.getAttribute("data-role")).toBe("viewer");
    expect(probe?.getAttribute("data-write")).toBe("false");
    expect(container.querySelector('[data-testid="entry-loading-screen"]')).toBeNull();
    expect(container.textContent).toContain("Workspace ready");
  });

  it("does not copy the previous active space into a new account before initialization", async () => {
    mocks.getSummaryResult.mockResolvedValue(summaryFor("viewer"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    expect(mocks.recordProjectOpened).toHaveBeenCalledWith(PROJECT_ID, undefined, "user@example.test");
    mocks.recordProjectOpened.mockClear();
    const lookup = deferred<ReturnType<typeof summaryFor>>();
    mocks.getSummaryResult.mockReturnValue(lookup.promise);
    mocks.useAuth.mockReturnValue({ user: { id: "user-2", email: "other@example.test" } });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    expect(mocks.recordProjectOpened).not.toHaveBeenCalled();
    await act(async () => lookup.resolve(summaryFor("viewer")));
    expect(mocks.recordProjectOpened).toHaveBeenCalledWith(PROJECT_ID, undefined, "other@example.test");
  });

  it("aborts a pending startup access read when its provider unmounts", async () => {
    let signal: AbortSignal | undefined;
    mocks.getSummaryResult.mockImplementation((_projectId: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason));
      });
    });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    expect(signal?.aborted).toBe(false);

    await act(async () => root.render(null));

    expect(signal?.aborted).toBe(true);
    expect(mocks.createControllerProject).not.toHaveBeenCalled();
  });

  it("cancels a superseded access refresh and starts the fresh check promptly", async () => {
    let staleSignal: AbortSignal | undefined;
    mocks.getSummaryResult
      .mockResolvedValueOnce(summaryFor("admin"))
      .mockImplementationOnce((_projectId: string, options: { signal: AbortSignal }) => {
        staleSignal = options.signal;
        return new Promise((_resolve, reject) => {
          staleSignal?.addEventListener("abort", () => reject(staleSignal?.reason));
        });
      })
      .mockResolvedValueOnce(summaryFor("viewer"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(staleSignal?.aborted).toBe(false);

    await act(async () => window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
      detail: { projectId: PROJECT_ID },
    })));

    expect(staleSignal?.aborted).toBe(true);
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-testid="access-probe"]')?.getAttribute("data-role")).toBe("viewer");
  });

  it.each(["unavailable", "rejected"])("recovers from an initial %s lookup without keeping the full-screen loader or granting access", async (failure) => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    if (failure === "rejected") {
      mocks.getSummaryResult.mockRejectedValueOnce(new Error("network unavailable"));
    } else {
      mocks.getSummaryResult.mockResolvedValueOnce({
        summary: null, notFound: false, forbidden: false, unauthorized: false,
      });
    }
    mocks.getSummaryResult.mockResolvedValueOnce(summaryFor("viewer"));

    await act(async () => root.render(
      <ProjectAccessProvider>
        <StudioStartupGate><AccessProbe /><ProjectAccessRecoveryBanner /></StudioStartupGate>
      </ProjectAccessProvider>,
    ));
    const probe = container.querySelector('[data-testid="access-probe"]');
    expect(probe?.getAttribute("data-initialized")).toBe("true");
    expect(probe?.getAttribute("data-pending")).toBe("false");
    expect(probe?.getAttribute("data-resolved")).toBe("false");
    expect(probe?.getAttribute("data-write")).toBe("false");
    expect(probe?.getAttribute("data-blocked")).toBe("false");
    expect(container.querySelector('[data-testid="entry-loading-screen"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Couldn’t check access. Retrying…");

    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(2);
    expect(probe?.getAttribute("data-role")).toBe("viewer");
    expect(probe?.getAttribute("data-resolved")).toBe("true");
    expect(probe?.getAttribute("data-write")).toBe("false");
    expect(mocks.createControllerProject).not.toHaveBeenCalled();
    expect(mocks.removeProject).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(mocks.setProjectName).toHaveBeenCalledWith(PROJECT_ID, "Shared space");
    expect(mocks.setProjectOrg).toHaveBeenCalledWith(PROJECT_ID, { id: "org-1", name: "Team" });
  });

  it("lets the recovery banner retry the same access check immediately", async () => {
    const retry = deferred<ReturnType<typeof summaryFor>>();
    mocks.getSummaryResult
      .mockResolvedValueOnce({ summary: null, notFound: false, forbidden: false, unauthorized: false })
      .mockReturnValueOnce(retry.promise);
    await act(async () => root.render(
      <ProjectAccessProvider>
        <StudioStartupGate><AccessProbe /><ProjectAccessRecoveryBanner /></StudioStartupGate>
      </ProjectAccessProvider>,
    ));
    const retryButton = container.querySelector("button");
    expect(retryButton?.textContent).toBe("Retry");
    await act(async () => retryButton?.click());
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(2);
    expect(mocks.getSummaryResult).toHaveBeenLastCalledWith(PROJECT_ID, { signal: expect.any(AbortSignal) });
    expect(container.querySelector('[data-testid="access-probe"]')?.getAttribute("data-write")).toBe("false");

    await act(async () => retry.resolve(summaryFor("viewer")));
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(mocks.createControllerProject).not.toHaveBeenCalled();
  });

  it("cancels a pending recovery retry when the project provider unmounts", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mocks.getSummaryResult.mockResolvedValue({
      summary: null, notFound: false, forbidden: false, unauthorized: false,
    });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);

    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["notFound", "forbidden", "unauthorized"])("keeps initial %s access failures blocked without a transient retry", async (failure) => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mocks.getSummaryResult.mockResolvedValue({
      summary: null, notFound: false, forbidden: false, unauthorized: false, [failure]: true,
    });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));

    const probe = container.querySelector('[data-testid="access-probe"]');
    expect(probe?.getAttribute("data-initialized")).toBe("true");
    expect(probe?.getAttribute("data-blocked")).toBe("true");
    expect(probe?.getAttribute("data-write")).toBe("false");
    expect(mocks.removeProject).toHaveBeenCalledWith(PROJECT_ID);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);
    expect(mocks.createControllerProject).not.toHaveBeenCalled();
  });

  it("resolves access immediately for a space the studio switched to without a URL change", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    mocks.getSummaryResult.mockResolvedValue(summaryFor("admin"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    expect(probe?.getAttribute("data-resolved")).toBe("true");
    mocks.getSummaryResult.mockClear();

    // New space / picker: the store switches, the URL still names the old space.
    const lookup = deferred<ReturnType<typeof summaryFor>>();
    mocks.getSummaryResult.mockReturnValue(lookup.promise);
    mocks.activeProjectId = OTHER;
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);
    expect(mocks.getSummaryResult.mock.calls[0]?.[0]).toBe(OTHER);
    expect(probe?.getAttribute("data-resolved")).toBe("false");

    await act(async () =>
      lookup.resolve({
        ...summaryFor("admin"),
        summary: { ...summaryFor("admin").summary, projectId: OTHER, projectName: "Fresh space" },
      }),
    );
    expect(probe?.getAttribute("data-resolved")).toBe("true");
    expect(probe?.getAttribute("data-write")).toBe("true");
    expect(mocks.setProjectName).not.toHaveBeenCalledWith(PROJECT_ID, "Fresh space");
  });

  it("reports whether the space can store chat attachments, and refreshes it", async () => {
    mocks.getSummaryResult
      .mockResolvedValueOnce({ ...summaryFor("admin"), summary: { ...summaryFor("admin").summary, attachments: "none" } })
      .mockResolvedValueOnce({ ...summaryFor("admin"), summary: { ...summaryFor("admin").summary, attachments: "storage" } });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    await vi.waitFor(() => expect(probe?.getAttribute("data-attachments")).toBe("none"));

    await act(async () => {
      window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, { detail: { projectId: PROJECT_ID } }));
    });
    await vi.waitFor(() => expect(probe?.getAttribute("data-attachments")).toBe("storage"));
  });

  it("turns attachments off in an app without a Supabase configuration", async () => {
    mocks.hasSupabaseConfig = false;
    try {
      mocks.getSummaryResult.mockResolvedValue({
        ...summaryFor("admin"),
        summary: { ...summaryFor("admin").summary, attachments: "storage" },
      });
      await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
      const probe = container.querySelector('[data-testid="access-probe"]');
      await vi.waitFor(() => expect(probe?.getAttribute("data-attachments")).toBe("none"));
    } finally {
      mocks.hasSupabaseConfig = true;
    }
  });

  it("leaves attachments on while an older controller says nothing about them", async () => {
    mocks.getSummaryResult.mockResolvedValue(summaryFor("admin"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    await vi.waitFor(() => expect(probe?.getAttribute("data-resolved")).toBe("true"));
    expect(probe?.getAttribute("data-attachments")).toBe("unknown");
  });

  it("demotes a live project after a targeted controller invalidation", async () => {
    mocks.getSummaryResult
      .mockResolvedValueOnce(summaryFor("admin"))
      .mockResolvedValueOnce(summaryFor("viewer"));

    await act(async () => {
      root.render(
        <ProjectAccessProvider>
          <AccessProbe />
        </ProjectAccessProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="access-probe"]')?.getAttribute("data-role")).toBe("admin");
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
          detail: { projectId: PROJECT_ID },
        }),
      );
    });
    await vi.waitFor(() => {
      const probe = container.querySelector('[data-testid="access-probe"]');
      expect(probe?.getAttribute("data-role")).toBe("viewer");
      expect(probe?.getAttribute("data-write")).toBe("false");
      expect(probe?.getAttribute("data-share")).toBe("false");
    });
  });

  it("promotes a live project after a targeted controller invalidation", async () => {
    mocks.getSummaryResult
      .mockResolvedValueOnce(summaryFor("viewer"))
      .mockResolvedValueOnce(summaryFor("admin"));

    await act(async () => {
      root.render(
        <ProjectAccessProvider>
          <AccessProbe />
        </ProjectAccessProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="access-probe"]')?.getAttribute("data-role")).toBe("viewer");
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
          detail: { projectId: PROJECT_ID },
        }),
      );
    });
    await vi.waitFor(() => {
      const probe = container.querySelector('[data-testid="access-probe"]');
      expect(probe?.getAttribute("data-role")).toBe("admin");
      expect(probe?.getAttribute("data-write")).toBe("true");
      expect(probe?.getAttribute("data-share")).toBe("true");
    });
  });

  it("fails closed immediately and refetches after an older refresh is in flight", async () => {
    const staleRefresh = deferred<ReturnType<typeof summaryFor>>();
    const authoritativeRefresh = deferred<ReturnType<typeof summaryFor>>();
    mocks.getSummaryResult
      .mockResolvedValueOnce(summaryFor("admin"))
      .mockReturnValueOnce(staleRefresh.promise)
      .mockReturnValueOnce(authoritativeRefresh.promise);

    await act(async () => {
      root.render(
        <ProjectAccessProvider>
          <AccessProbe />
        </ProjectAccessProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="access-probe"]')?.getAttribute("data-role")).toBe("admin");
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() => expect(mocks.getSummaryResult).toHaveBeenCalledTimes(2));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
          detail: { projectId: PROJECT_ID },
        }),
      );
    });
    let probe = container.querySelector('[data-testid="access-probe"]');
    expect(probe?.getAttribute("data-role")).toBe("none");
    expect(probe?.getAttribute("data-write")).toBe("false");
    expect(probe?.getAttribute("data-share")).toBe("false");
    expect(probe?.getAttribute("data-resolved")).toBe("false");

    await act(async () => {
      staleRefresh.resolve(summaryFor("admin"));
      await staleRefresh.promise;
    });
    await vi.waitFor(() => expect(mocks.getSummaryResult).toHaveBeenCalledTimes(3));
    probe = container.querySelector('[data-testid="access-probe"]');
    expect(probe?.getAttribute("data-role")).toBe("none");
    expect(probe?.getAttribute("data-write")).toBe("false");

    await act(async () => {
      authoritativeRefresh.resolve(summaryFor("viewer"));
      await authoritativeRefresh.promise;
    });
    await vi.waitFor(() => {
      const refreshedProbe = container.querySelector('[data-testid="access-probe"]');
      expect(refreshedProbe?.getAttribute("data-role")).toBe("viewer");
      expect(refreshedProbe?.getAttribute("data-write")).toBe("false");
    });
  });

  it("fails closed when an explicit refresh discovers revoked access", async () => {
    mocks.getSummaryResult
      .mockResolvedValueOnce(summaryFor("admin"))
      .mockResolvedValueOnce({
        summary: null,
        notFound: false,
        forbidden: true,
        unauthorized: false,
      });

    await act(async () => {
      root.render(
        <ProjectAccessProvider>
          <AccessProbe />
        </ProjectAccessProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="access-probe"]')?.getAttribute("data-role")).toBe("admin");
    });

    await act(async () => {
      window.dispatchEvent(new Event(PROJECT_ACCESS_REFRESH_EVENT));
    });
    await vi.waitFor(() => {
      const probe = container.querySelector('[data-testid="access-probe"]');
      expect(probe?.getAttribute("data-blocked")).toBe("true");
      expect(probe?.getAttribute("data-resolved")).toBe("false");
      expect(mocks.removeProject).toHaveBeenCalledWith(PROJECT_ID);
    });
  });

  it("drops a space deleted elsewhere from this tab's lists without touching the open space", async () => {
    const DELETED = "44444444-4444-4444-8444-444444444444";
    mocks.getSummaryResult.mockResolvedValue(summaryFor("admin"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    expect(probe?.getAttribute("data-role")).toBe("admin");
    mocks.getSummaryResult.mockClear();

    await act(async () => window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
      detail: { projectId: null, deletedProjectId: DELETED },
    })));

    expect(mocks.removeProject).toHaveBeenCalledExactlyOnceWith(DELETED);
    expect(mocks.getSummaryResult).not.toHaveBeenCalled();
    expect(probe?.getAttribute("data-role")).toBe("admin");
    expect(probe?.getAttribute("data-write")).toBe("true");
    expect(probe?.getAttribute("data-blocked")).toBe("false");
  });

  it("says the open space was deleted and stays on that notice instead of opening another space", async () => {
    const FALLBACK = "55555555-5555-4555-8555-555555555555";
    mocks.getSummaryResult.mockResolvedValueOnce(summaryFor("admin"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    expect(probe?.getAttribute("data-role")).toBe("admin");
    mocks.getSummaryResult.mockClear();

    // The real store activates another local space when the open one is
    // removed; the URL still names the deleted one.
    mocks.removeProject.mockImplementation(() => {
      mocks.activeProjectId = FALLBACK;
    });
    mocks.getSummaryResult.mockImplementation(async (projectId: string) => projectId === PROJECT_ID
      ? { summary: null, notFound: true, forbidden: false, unauthorized: false }
      : { ...summaryFor("admin"), summary: { ...summaryFor("admin").summary, projectId } });

    await act(async () => window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
      detail: { projectId: null, deletedProjectId: PROJECT_ID },
    })));
    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(mocks.removeProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(mocks.getSummaryResult.mock.calls.map(([projectId]) => projectId)).toEqual([PROJECT_ID]);
    expect(probe?.getAttribute("data-blocked")).toBe("true");
    expect(probe?.getAttribute("data-deleted")).toBe("true");
    expect(probe?.getAttribute("data-write")).toBe("false");
    expect(mocks.switchProject).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("leaves a space this tab is deleting to the delete, so the picker never flashes", async () => {
    mocks.getSummaryResult.mockResolvedValueOnce(summaryFor("admin"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    mocks.getSummaryResult.mockResolvedValue({ summary: null, notFound: true, forbidden: false, unauthorized: false });
    markProjectDeletedHere(PROJECT_ID);
    try {
      // The controller's notice can beat the DELETE response, and the
      // confirm dialog closing focuses the window.
      await act(async () => window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
        detail: { projectId: null, deletedProjectId: PROJECT_ID },
      })));
      await act(async () => window.dispatchEvent(new Event("focus")));

      expect(mocks.getSummaryResult).toHaveBeenCalledTimes(2);
      expect(mocks.removeProject).not.toHaveBeenCalled();
      expect(probe?.getAttribute("data-blocked")).toBe("false");
      expect(probe?.getAttribute("data-role")).toBe("admin");
    } finally {
      unmarkProjectDeletedHere(PROJECT_ID);
    }
  });

  it("drops a team deleted elsewhere from this tab's lists without touching an open space in another team", async () => {
    mocks.getSummaryResult.mockResolvedValue(summaryFor("admin"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    expect(probe?.getAttribute("data-role")).toBe("admin");
    mocks.getSummaryResult.mockClear();

    await act(async () => window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
      detail: { projectId: null, deletedProjectId: null, deletedOrgId: "org-2" },
    })));

    expect(mocks.removeProjectsByOrgId).toHaveBeenCalledExactlyOnceWith("org-2");
    expect(mocks.removeProject).not.toHaveBeenCalled();
    expect(mocks.getSummaryResult).not.toHaveBeenCalled();
    expect(probe?.getAttribute("data-role")).toBe("admin");
    expect(probe?.getAttribute("data-blocked")).toBe("false");
  });

  it("says the open space was deleted with its team, without its own notice, and opens no other space", async () => {
    const SIBLING = "77777777-7777-4777-8777-777777777777";
    const ELSEWHERE = "88888888-8888-4888-8888-888888888888";
    mocks.otherProjects = {
      [SIBLING]: { metadata: { projectName: "Sibling" }, org: { id: "org-1", name: "Team" } },
      [ELSEWHERE]: { metadata: { projectName: "Elsewhere" }, org: { id: "org-2", name: "Other team" } },
    };
    mocks.getSummaryResult.mockResolvedValueOnce(summaryFor("admin"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    expect(probe?.getAttribute("data-role")).toBe("admin");
    mocks.getSummaryResult.mockClear();

    // The real store activates another space when the open one is removed;
    // the URL still names the deleted one.
    mocks.removeProject.mockImplementation((projectId: string) => {
      if (projectId === PROJECT_ID) mocks.activeProjectId = ELSEWHERE;
    });
    mocks.getSummaryResult.mockImplementation(async (projectId: string) => projectId === PROJECT_ID
      ? { summary: null, notFound: true, forbidden: false, unauthorized: false }
      : { ...summaryFor("admin"), summary: { ...summaryFor("admin").summary, projectId, orgId: "org-2" } });

    await act(async () => window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
      detail: { projectId: null, deletedProjectId: null, deletedOrgId: "org-1" },
    })));
    await act(async () => window.dispatchEvent(new Event("focus")));

    // The sibling left first, so the store never moved to a space of the team.
    expect(mocks.removeProject.mock.calls.map(([projectId]) => projectId)).toEqual([SIBLING, PROJECT_ID]);
    expect(mocks.getSummaryResult.mock.calls.map(([projectId]) => projectId)).toEqual([PROJECT_ID]);
    expect(probe?.getAttribute("data-blocked")).toBe("true");
    expect(probe?.getAttribute("data-deleted")).toBe("true");
    expect(mocks.switchProject).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();

    // A repeated notice, now that the store holds a space of another team.
    await act(async () => window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
      detail: { projectId: null, deletedProjectId: null, deletedOrgId: "org-1" },
    })));
    expect(mocks.removeProjectsByOrgId).toHaveBeenCalledExactlyOnceWith("org-1");
    expect(probe?.getAttribute("data-deleted")).toBe("true");
  });

  it("leaves an open space in a team this tab is deleting to the delete, and blocks it if the delete fails", async () => {
    const SIBLING = "77777777-7777-4777-8777-777777777777";
    mocks.otherProjects = {
      [SIBLING]: { metadata: { projectName: "Sibling" }, org: { id: "org-1", name: "Team" } },
    };
    mocks.getSummaryResult.mockResolvedValueOnce(summaryFor("admin"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    mocks.getSummaryResult.mockClear();
    mocks.getSummaryResult.mockResolvedValue({ summary: null, notFound: true, forbidden: false, unauthorized: false });
    markProjectDeletedHere(PROJECT_ID);
    markProjectDeletedHere(SIBLING);
    try {
      // Every notice of the team delete arrives while its request still runs.
      await act(async () => {
        for (const deletedProjectId of [SIBLING, PROJECT_ID]) {
          window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
            detail: { projectId: null, deletedProjectId },
          }));
        }
        window.dispatchEvent(new CustomEvent(PROJECT_ACCESS_REFRESH_EVENT, {
          detail: { projectId: null, deletedOrgId: "org-1" },
        }));
      });

      // A space announced deleted leaves the lists; the open one is left alone.
      expect(mocks.removeProject).toHaveBeenCalledExactlyOnceWith(SIBLING);
      expect(mocks.removeProjectsByOrgId).not.toHaveBeenCalled();
      expect(mocks.getSummaryResult).not.toHaveBeenCalled();
      expect(probe?.getAttribute("data-blocked")).toBe("false");
      expect(probe?.getAttribute("data-role")).toBe("admin");
    } finally {
      unmarkProjectDeletedHere(PROJECT_ID);
      unmarkProjectDeletedHere(SIBLING);
    }

    // The delete failed after all: the next check finds the space gone and
    // says so, since the controller announced it.
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(probe?.getAttribute("data-blocked")).toBe("true");
    expect(probe?.getAttribute("data-deleted")).toBe("true");
    expect(mocks.switchProject).not.toHaveBeenCalled();
  });

  it("checks the open space at once when one of its reads gets a 404, even in a hidden tab", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    mocks.getSummaryResult.mockResolvedValueOnce(summaryFor("admin"));
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    const probe = container.querySelector('[data-testid="access-probe"]');
    mocks.getSummaryResult.mockResolvedValue({ summary: null, notFound: true, forbidden: false, unauthorized: false });

    await act(async () => reportControllerProjectNotFound("66666666-6666-4666-8666-666666666666"));
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);

    await act(async () => {
      reportControllerProjectNotFound(PROJECT_ID);
      reportControllerProjectNotFound(PROJECT_ID);
    });
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(2);
    expect(probe?.getAttribute("data-blocked")).toBe("true");
    // Nothing said the space was deleted, only that it is not found.
    expect(probe?.getAttribute("data-deleted")).toBe("false");
    expect(mocks.removeProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("ends the lookup when the last space this browser knew is gone and nothing replaces it", async () => {
    mocks.locationSearch = "";
    window.history.replaceState(null, "", "/studio");
    suppressProjectAutoCreate();
    mocks.getSummaryResult.mockResolvedValue({ summary: null, notFound: true, forbidden: false, unauthorized: false });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));

    const probe = container.querySelector('[data-testid="access-probe"]');
    expect(mocks.removeProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(probe?.getAttribute("data-initialized")).toBe("true");
    expect(probe?.getAttribute("data-pending")).toBe("false");
    expect(mocks.listProjects).not.toHaveBeenCalled();
    expect(mocks.createControllerProject).not.toHaveBeenCalled();
  });
});

// A device that remembers nothing (a second machine, cleared site data) is
// not a new account. The first real sign-in from one opened a fresh
// "Untitled Space" instead of the one with the work in it, and the local
// database showed the minted spaces in pairs, 9ms apart, from the startup
// effect running twice.
describe("ProjectAccessProvider startup with nothing remembered", () => {
  const EXISTING_ID = "22222222-2222-4222-8222-222222222222";
  const MINTED_ID = "33333333-3333-4333-8333-333333333333";
  let container: HTMLDivElement;
  let root: Root;

  const settle = async () => {
    await act(async () => {
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    window.history.replaceState(null, "", "/studio");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.values(mocks).forEach((mock) => {
      if (typeof mock === "function") mock.mockReset();
    });
    mocks.activeProjectId = "";
    mocks.locationSearch = "";
    mocks.otherProjects = {};
    mocks.useAuth.mockReturnValue({ user: { id: "user-1", email: "user@example.test" } });
    mocks.getSummaryResult.mockImplementation(async (projectId: string) => ({
      summary: {
        projectId,
        projectName: "The one with the work in it",
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
    }));
    mocks.createControllerProject.mockResolvedValue({
      projectId: MINTED_ID,
      orgId: "org-1",
      orgName: "Team",
      projectName: null,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("opens a space the account already has instead of minting one", async () => {
    mocks.listProjects.mockResolvedValue({
      status: "success",
      projects: [
        { projectId: EXISTING_ID, projectName: "The one with the work in it", orgId: "org-1", projectType: "customer", status: "active" },
      ],
    });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    await settle();

    expect(mocks.createControllerProject).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: EXISTING_ID }));
    expect(mocks.getSummaryResult).toHaveBeenCalledWith(EXISTING_ID, expect.anything());
    expect(window.localStorage.getItem("instafy.lastProjectId")).toBe(EXISTING_ID);
    expect(container.querySelector('[data-testid="access-probe"]')?.getAttribute("data-initialized")).toBe("true");
  });

  it("opens the space last worked in, not the first one listed", async () => {
    mocks.listProjects.mockResolvedValue({
      status: "success",
      projects: [
        { projectId: MINTED_ID, orgId: "org-1", projectType: "customer", status: "active", lastActivityAt: "2026-09-18T10:00:00Z" },
        { projectId: EXISTING_ID, orgId: "org-1", projectType: "customer", status: "active", lastActivityAt: "2026-09-21T07:00:00Z" },
      ],
    });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    await settle();

    expect(mocks.createControllerProject).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: EXISTING_ID }));
  });

  it("passes over sandboxes and archived spaces when choosing", async () => {
    mocks.listProjects.mockResolvedValue({
      status: "success",
      projects: [
        { projectId: MINTED_ID, orgId: "org-1", projectType: "sandbox", status: "active" },
        { projectId: PROJECT_ID, orgId: "org-1", projectType: "customer", status: "archived" },
        { projectId: EXISTING_ID, orgId: "org-1", projectType: "customer", status: "active" },
      ],
    });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    await settle();

    expect(mocks.createControllerProject).not.toHaveBeenCalled();
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: EXISTING_ID }));
  });

  it("mints a space only for an account that has none, and once under a doubled startup", async () => {
    mocks.listProjects.mockResolvedValue({ status: "success", projects: [] });
    // StrictMode runs the startup effect twice in development, which is how
    // the pairs in the database came about.
    await act(async () => root.render(
      <StrictMode>
        <ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>
      </StrictMode>,
    ));
    await settle();

    expect(mocks.createControllerProject).toHaveBeenCalledTimes(1);
    expect(mocks.createControllerProject).toHaveBeenCalledWith({ projectType: "customer" });
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: MINTED_ID }));
  });

  it("says so and offers a retry when no space could be made, then makes one on retry", async () => {
    // The last first-run dead end: with no space and a failed create the
    // studio opened with a shut composer and no word about why.
    mocks.listProjects.mockResolvedValue({ status: "success", projects: [] });
    mocks.createControllerProject
      .mockRejectedValueOnce(new Error("controller unavailable"))
      .mockResolvedValueOnce({ projectId: MINTED_ID, orgId: "org-1", orgName: "Team", projectName: null });
    await act(async () => root.render(
      <ProjectAccessProvider>
        <AccessProbe />
        <ProjectAccessRecoveryBanner />
        <StudioStartupGate><p>Workspace ready</p></StudioStartupGate>
      </ProjectAccessProvider>,
    ));
    await settle();

    const probe = () => container.querySelector('[data-testid="access-probe"]');
    expect(probe()?.getAttribute("data-initialized")).toBe("true");
    expect(probe()?.getAttribute("data-provision-failed")).toBe("true");
    const banner = container.querySelector('[data-testid="project-provision-failed"]');
    expect(banner?.textContent).toContain("Couldn’t set up your space.");
    expect(mocks.createProject).not.toHaveBeenCalled();

    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again");
    expect(retry).not.toBeUndefined();
    await act(async () => {
      retry!.click();
    });
    await settle();

    expect(mocks.createControllerProject).toHaveBeenCalledTimes(2);
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: MINTED_ID }));
    expect(probe()?.getAttribute("data-provision-failed")).toBe("false");
    expect(container.querySelector('[data-testid="project-provision-failed"]')).toBeNull();
  });

  it("still mints when the list cannot be read, as before", async () => {
    mocks.listProjects.mockResolvedValue({ status: "error" });
    await act(async () => root.render(<ProjectAccessProvider><AccessProbe /></ProjectAccessProvider>));
    await settle();

    expect(mocks.createControllerProject).toHaveBeenCalledTimes(1);
  });
});
