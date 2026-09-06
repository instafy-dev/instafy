import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerRequestContextMock = vi.hoisted(() => vi.fn());
const readControllerErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../core", () => ({
  controllerBaseUrl: "http://controller.test",
  normalizeUuidParam: (value: string | null | undefined) => value?.trim() || null,
  readControllerApiError: vi.fn(async (response: Response, fallback: string) => {
    const data = (await response.json().catch(() => null)) as
      | { message?: unknown; code?: unknown; details?: unknown }
      | null;
    return {
      status: response.status,
      message:
        typeof data?.message === "string" && data.message.trim().length > 0
          ? data.message.trim()
          : `${fallback} (${response.status})`,
      code:
        typeof data?.code === "string" && data.code.trim().length > 0
          ? data.code.trim()
          : null,
      details: data?.details ?? null,
      url: response.url,
    };
  }),
  readControllerError: readControllerErrorMock,
  resolveControllerRequestContext: resolveControllerRequestContextMock,
  runtimeControllerEnabled: true,
}));

vi.mock("../logging", () => ({
  logControllerRequestError: vi.fn(),
}));

import {
  createControllerProject,
  getControllerProjectSummaryResult,
  importGithubProject,
  listControllerProjects,
  listControllerProjectsResult,
  listControllerOrganizations,
  listControllerOrgMembers,
  listControllerProjectMembers,
} from "../projects";

const defaultRequestContext = Object.freeze({
  baseUrl: "http://controller.test",
  accessToken: "token-123",
  credentialSource: "ambient" as const,
  generation: 1,
});

function resetControllerMocks() {
  resolveControllerRequestContextMock.mockReset();
  resolveControllerRequestContextMock.mockResolvedValue(defaultRequestContext);
  readControllerErrorMock.mockReset();
  readControllerErrorMock.mockImplementation(
    async (response: Response, fallback: string) => {
      const data = (await response.json().catch(() => null)) as
        | { message?: unknown }
        | null;
      return typeof data?.message === "string" && data.message.trim().length > 0
        ? data.message.trim()
        : `${fallback} (${response.status})`;
    },
  );
}

describe("project and organization request contexts", () => {
  beforeEach(() => {
    resetControllerMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses one immutable context while implicitly creating an organization and project", async () => {
    const originatingContext = Object.freeze({
      baseUrl: "https://controller-a.test",
      accessToken: "account-a-token",
      credentialSource: "ambient" as const,
      generation: 11,
    });
    const switchedAccountContext = Object.freeze({
      baseUrl: "https://controller-b.test",
      accessToken: "account-b-token",
      credentialSource: "ambient" as const,
      generation: 12,
    });
    resolveControllerRequestContextMock
      .mockResolvedValueOnce(originatingContext)
      .mockResolvedValueOnce(switchedAccountContext);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            orgId: "22222222-2222-4222-8222-222222222222",
            orgSlug: "account-a",
            orgName: "Account A",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            projectId: "11111111-1111-4111-8111-111111111111",
            projectName: "Context-bound project",
            orgId: "22222222-2222-4222-8222-222222222222",
            orgName: "Account A",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createControllerProject({ projectName: "Context-bound project" }),
    ).resolves.toMatchObject({
      projectId: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
    });

    expect(resolveControllerRequestContextMock).toHaveBeenCalledTimes(1);
    expect(resolveControllerRequestContextMock).toHaveBeenCalledWith(null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://controller-a.test/orgs",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer account-a-token" }),
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "https://controller-a.test/orgs/22222222-2222-4222-8222-222222222222/projects",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer account-a-token" }),
      }),
    ]);
  });

  it("routes a project-list 401 through the exact originating context", async () => {
    const response = new Response(JSON.stringify({ message: "session expired" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(listControllerProjects()).resolves.toEqual([]);

    expect(readControllerErrorMock).toHaveBeenCalledWith(
      response,
      "list projects failed",
      defaultRequestContext,
    );
  });

  it("keeps unauthorized, forbidden, and missing project responses distinct", async () => {
    const forbiddenResponse = new Response(JSON.stringify({ message: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
    const unauthorizedResponse = new Response(
      JSON.stringify({ message: "session expired" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
    const missingResponse = new Response(JSON.stringify({ message: "missing" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(forbiddenResponse)
      .mockResolvedValueOnce(unauthorizedResponse)
      .mockResolvedValueOnce(missingResponse);
    vi.stubGlobal("fetch", fetchMock);

    await expect(getControllerProjectSummaryResult("project-1")).resolves.toEqual({
      summary: null,
      notFound: false,
      forbidden: true,
      unauthorized: false,
    });
    await expect(getControllerProjectSummaryResult("project-1")).resolves.toEqual({
      summary: null,
      notFound: false,
      forbidden: false,
      unauthorized: true,
    });
    await expect(getControllerProjectSummaryResult("project-1")).resolves.toEqual({
      summary: null,
      notFound: true,
      forbidden: false,
      unauthorized: false,
    });

    expect(readControllerErrorMock).toHaveBeenCalledTimes(2);
    expect(readControllerErrorMock.mock.calls).toEqual([
      [forbiddenResponse, "get project failed", defaultRequestContext],
      [unauthorizedResponse, "get project failed", defaultRequestContext],
    ]);
  });

  it("aborts a stalled project lookup as unavailable without reporting revoked access", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => {
      requestSignal = options.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    }));

    const result = getControllerProjectSummaryResult("project-1");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({
      summary: null,
      notFound: false,
      forbidden: false,
      unauthorized: false,
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(readControllerErrorMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a successful project lookup", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      requestSignal = options.signal as AbortSignal;
      return new Response(JSON.stringify({ projectId: "project-1", effectiveRole: "viewer" }));
    }));

    await expect(getControllerProjectSummaryResult("project-1")).resolves.toMatchObject({
      summary: { projectId: "project-1", effectiveRole: "viewer" },
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestSignal?.aborted).toBe(false);
  });
});

describe("strict controller membership discovery", () => {
  beforeEach(() => {
    resetControllerMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a successfully empty project list without requesting legacy discovery", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ projects: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listControllerProjectsResult()).resolves.toEqual({
      status: "success",
      projects: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([404, 405])("marks HTTP %s project discovery as unsupported", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(null, { status })));

    await expect(listControllerProjectsResult()).resolves.toEqual({ status: "unsupported" });
    await expect(listControllerProjects()).resolves.toEqual([]);
  });

  it.each([401, 403, 429, 500, 503])("retains HTTP %s as a failed project refresh", async (status) => {
    const response = new Response(JSON.stringify({ message: "discovery unavailable" }), { status });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(listControllerProjectsResult()).resolves.toEqual({ status: "error" });
    expect(readControllerErrorMock).toHaveBeenCalledWith(
      response,
      "list projects failed",
      defaultRequestContext,
    );
  });

  it("distinguishes network failure from successfully empty project discovery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));

    await expect(listControllerProjectsResult()).resolves.toEqual({ status: "error" });
    await expect(listControllerProjects()).resolves.toEqual([]);
  });

  it.each([null, {}, { projects: "invalid" }])("rejects malformed project discovery %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));

    await expect(listControllerProjectsResult()).resolves.toEqual({ status: "error" });
  });

  it("does not treat unavailable authentication as an empty project list", async () => {
    resolveControllerRequestContextMock.mockResolvedValue({ ...defaultRequestContext, accessToken: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listControllerProjectsResult()).resolves.toEqual({ status: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports org-scoped project results through the originating request context", async () => {
    const project = { projectId: "project-1", orgId: "org-1" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ projects: [project] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listControllerProjectsResult({ orgId: "org-1" })).resolves.toEqual({
      status: "success",
      projects: [project],
    });
    expect(fetchMock).toHaveBeenCalledWith("http://controller.test/orgs/org-1/projects", {
      headers: { authorization: "Bearer token-123" },
    });
  });

  it("distinguishes an organization request failure from a successful empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));

    await expect(listControllerOrganizations()).resolves.toEqual([]);
    await expect(
      listControllerOrganizations({ throwOnError: true }),
    ).rejects.toThrow("network unavailable");
  });

  it("distinguishes a member request failure from a successful empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("member directory unavailable")));

    await expect(listControllerOrgMembers("org-1")).resolves.toEqual([]);
    await expect(
      listControllerOrgMembers("org-1", { throwOnError: true }),
    ).rejects.toThrow("member directory unavailable");
  });

  it("routes a team-membership 401 through the exact originating context", async () => {
    const response = new Response(JSON.stringify({ message: "team session expired" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      listControllerOrgMembers("org-1", { throwOnError: true }),
    ).rejects.toThrow("team session expired");

    expect(readControllerErrorMock).toHaveBeenCalledWith(
      response,
      "list team members failed",
      defaultRequestContext,
    );
  });

  it("distinguishes a project member failure from a successful empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("project directory unavailable")));

    await expect(listControllerProjectMembers("project-1")).resolves.toEqual([]);
    await expect(
      listControllerProjectMembers("project-1", { throwOnError: true }),
    ).rejects.toThrow("project directory unavailable");
  });
});

describe("importGithubProject", () => {
  beforeEach(() => {
    resetControllerMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the stable idempotency key to the controller", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        rev: "abc123",
        fileCount: 4,
        bytesWritten: 512,
        targetPath: "repos/instafy-dev-private-repo",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      importGithubProject({
        projectId: "11111111-1111-1111-1111-111111111111",
        repo: "instafy-dev/private-repo",
        targetPath: "repos/instafy-dev-private-repo",
        idempotencyKey: "github-import-v1:stable",
      }),
    ).resolves.toMatchObject({ success: true, rev: "abc123" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request[0]).toBe(
      "http://controller.test/projects/11111111-1111-1111-1111-111111111111/import/github",
    );
    expect(JSON.parse(String(request[1].body))).toMatchObject({
      repo: "instafy-dev/private-repo",
      targetPath: "repos/instafy-dev-private-repo",
      idempotencyKey: "github-import-v1:stable",
    });
  });

  it("retries only an explicitly retryable workspace-busy import with the same operation key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "Workspace is busy. Try again in a moment.",
            code: "workspace_busy",
            details: { retryable: true },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            rev: "retry-success",
            fileCount: 1,
            targetPath: "repos/octocat-hello-world",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      importGithubProject({
        projectId: "11111111-1111-1111-1111-111111111111",
        repo: "octocat/Hello-World",
        targetPath: "repos/octocat-hello-world",
        idempotencyKey: "github-import-v1:retry-stable",
      }),
    ).resolves.toMatchObject({ success: true, rev: "retry-success" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call as [string, RequestInit])[1].body)),
    );
    expect(requestBodies).toEqual([
      expect.objectContaining({ idempotencyKey: "github-import-v1:retry-stable" }),
      expect.objectContaining({ idempotencyKey: "github-import-v1:retry-stable" }),
    ]);
  });

  it("does not retry a workspace-busy response unless the controller marks it retryable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Workspace is busy.",
          code: "workspace_busy",
          details: { retryable: false },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      importGithubProject({
        projectId: "11111111-1111-1111-1111-111111111111",
        repo: "octocat/Hello-World",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "Workspace is busy.",
      errorCode: "workspace_busy",
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a retryable workspace-busy response without a stable operation key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Workspace is busy. Try again in a moment.",
          code: "workspace_busy",
          details: { retryable: true },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      importGithubProject({
        projectId: "11111111-1111-1111-1111-111111111111",
        repo: "octocat/Hello-World",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "Workspace is busy. Try again in a moment.",
      errorCode: "workspace_busy",
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).not.toHaveProperty("idempotencyKey");
  });
});
