import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());

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
  readControllerError: vi.fn(async () => "controller request failed"),
  resolveControllerAccessToken: resolveControllerAccessTokenMock,
  runtimeControllerEnabled: true,
}));

vi.mock("../logging", () => ({
  logControllerRequestError: vi.fn(),
}));

import {
  importGithubProject,
  listControllerOrganizations,
  listControllerOrgMembers,
  listControllerProjectMembers,
} from "../projects";

describe("strict controller membership discovery", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
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
