// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
    },
  },
}));

describe("runtime controller run request contexts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_CONTROLLER_URL", "https://controller.example.test");
    vi.stubEnv("PROD", false);
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "ambient-session-token" } },
    });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/studio");
    window.sessionStorage.clear();
    window.__INSTAFY_CONTROLLER_TOKEN__ = null;
    window.__INSTAFY_CONTROLLER_BASE_URL__ = null;
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
    window.__INSTAFY_CONTROLLER_TOKEN__ = null;
    window.__INSTAFY_CONTROLLER_BASE_URL__ = null;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("distinguishes 401 and 403 run-list responses from a missing project", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "forbidden" }), { status: 403 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "missing" }), { status: 404 }),
      );
    const { fetchRunsFromController } = await import("../runs");
    const core = await import("../core");
    const authErrors: number[] = [];
    const handleAuthError = (event: Event) => {
      authErrors.push(
        (event as CustomEvent<{ status: number }>).detail.status,
      );
    };
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);

    await expect(fetchRunsFromController({ projectId: "project-1" })).resolves.toEqual({
      runs: [],
      notFound: false,
      unauthorized: true,
      forbidden: false,
    });
    await expect(fetchRunsFromController({ projectId: "project-1" })).resolves.toEqual({
      runs: [],
      notFound: false,
      unauthorized: false,
      forbidden: true,
    });
    await expect(fetchRunsFromController({ projectId: "project-1" })).resolves.toEqual({
      runs: [],
      notFound: true,
      unauthorized: false,
      forbidden: false,
    });

    expect(authErrors).toEqual([401]);
    window.removeEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);
  });

  it("does not let a stale ambient-token 401 invalidate a refreshed session", async () => {
    getSessionMock
      .mockResolvedValueOnce({
        data: { session: { access_token: "stale-session-token" } },
      })
      .mockResolvedValueOnce({
        data: { session: { access_token: "refreshed-session-token" } },
      });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "stale token" }), { status: 401 }),
    );
    const { fetchRunsFromController } = await import("../runs");
    const core = await import("../core");
    const handleAuthError = vi.fn();
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);

    await expect(fetchRunsFromController({ projectId: "project-1" })).resolves.toEqual({
      runs: [],
      notFound: false,
      unauthorized: true,
      forbidden: false,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://controller.example.test/runs?projectId=project-1",
      expect.objectContaining({
        headers: { authorization: "Bearer stale-session-token" },
      }),
    );
    expect(getSessionMock).toHaveBeenCalledTimes(2);
    expect(handleAuthError).not.toHaveBeenCalled();
    window.removeEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);
  });

  it("does not let a rejected fixed request token invalidate the ambient session", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "fixed token rejected" }), {
        status: 401,
      }),
    );
    const { fetchRunsFromController } = await import("../runs");
    const core = await import("../core");
    const handleAuthError = vi.fn();
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);

    await expect(
      fetchRunsFromController({
        projectId: "project-1",
        accessToken: "one-request-token",
      }),
    ).resolves.toEqual({
      runs: [],
      notFound: false,
      unauthorized: true,
      forbidden: false,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://controller.example.test/runs?projectId=project-1",
      expect.objectContaining({
        headers: { authorization: "Bearer one-request-token" },
      }),
    );
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(handleAuthError).not.toHaveBeenCalled();
    window.removeEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);
  });

  it("routes a run-result 401 through the originating request context", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchRunResultFromController } = await import("../runs");
    const core = await import("../core");
    const authErrors: number[] = [];
    const handleAuthError = (event: Event) => {
      authErrors.push(
        (event as CustomEvent<{ status: number }>).detail.status,
      );
    };
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);

    await expect(fetchRunResultFromController("run-1")).resolves.toBeNull();

    expect(authErrors).toEqual([401]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[runtime-controller] fetch run result error:",
      "unauthorized",
    );
    window.removeEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);
  });

  it("treats a missing run result as non-auth failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "run not found" }), { status: 404 }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchRunResultFromController } = await import("../runs");
    const core = await import("../core");
    const handleAuthError = vi.fn();
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);

    await expect(fetchRunResultFromController("missing-run")).resolves.toBeNull();

    expect(handleAuthError).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[runtime-controller] fetch run result error:",
      "run not found",
    );
    window.removeEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, handleAuthError);
  });
});
