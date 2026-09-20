// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  createControllerProject: vi.fn(),
  createProject: vi.fn(),
  getSummaryResult: vi.fn(),
  removeProject: vi.fn(),
  setProjectName: vi.fn(),
  setProjectOrg: vi.fn(),
  switchProject: vi.fn(),
  recordProjectOpened: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("../../lib/supabaseClient", () => ({
  hasSupabaseConfig: true,
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    projects: {
      create: mocks.createControllerProject,
      getSummaryResult: mocks.getSummaryResult,
    },
  },
}));

vi.mock("../ProjectStateProvider", () => ({
  useProjectState: () => ({
    projects: {
      [PROJECT_ID]: {
        metadata: { projectName: "Shared space" },
        org: { id: "org-1", name: "Team" },
      },
    },
    activeProjectId: PROJECT_ID,
    createProject: mocks.createProject,
    switchProject: mocks.switchProject,
    setProjectOrg: mocks.setProjectOrg,
    setProjectName: mocks.setProjectName,
    removeProject: mocks.removeProject,
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
      search: `?projectId=${PROJECT_ID}`,
      hash: "",
      state: null,
      key: "test",
    }),
  };
});

vi.mock("../projectRecency", () => ({ recordProjectOpened: mocks.recordProjectOpened }));
vi.mock("../../workspace/projectClear", () => ({ clearProjectState: vi.fn() }));

import {
  PROJECT_ACCESS_REFRESH_EVENT,
  ProjectAccessProvider,
  useProjectAccess,
} from "../ProjectAccessProvider";
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
      data-initialized={String(access.projectInitialized)}
      data-pending={String(access.projectAccessPending)}
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
    Object.values(mocks).forEach((mock) => mock.mockReset());
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
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Couldn’t check access");

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
});
