import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../core", () => ({
  controllerBaseUrl: "http://controller.test",
  readControllerError: vi.fn(async (response: Response, fallback: string) => {
    const payload = (await response.json().catch(() => null)) as
      | { message?: unknown }
      | null;
    return typeof payload?.message === "string"
      ? payload.message
      : `${fallback} (${response.status})`;
  }),
  resolveControllerRequestContext: async (desired: string | null) => ({
    baseUrl: "http://controller.test",
    accessToken: await resolveControllerAccessTokenMock(desired),
    credentialSource: "ambient",
    generation: 1,
  }),
  runtimeControllerEnabled: true,
}));

import { clearSharedBrowserData, fetchSharedBrowserProfileStatus } from "../browserProfiles";

describe("fetchSharedBrowserProfileStatus", () => {
  const emptyStatus = { enabled: false, lastSavedAt: null, savedByRuntimeId: null };
  const savedStatus = {
    enabled: true,
    lastSavedAt: "2026-09-07T12:00:00.000Z",
    savedByRuntimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("session-token");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("gets project-scoped metadata with the current session and no cached response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(savedStatus));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSharedBrowserProfileStatus(" project/one ")).resolves.toEqual({
      success: true,
      status: savedStatus,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(resolveControllerAccessTokenMock).toHaveBeenCalledExactlyOnceWith(null);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://controller.test/projects/project%2Fone/browser-profile/status");
    expect(init.method).toBe("GET");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("cache-control")).toBe("no-cache");
    expect(init.body).toBeUndefined();
  });

  it.each([
    emptyStatus,
    { ...emptyStatus, enabled: true },
    savedStatus,
    { ...savedStatus, enabled: false },
    { ...savedStatus, savedByRuntimeId: null },
  ])("preserves explicit policy/save metadata without inferring recovery: %j", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(status)));
    await expect(fetchSharedBrowserProfileStatus("project-1")).resolves.toEqual({ success: true, status });
  });

  it("strips unknown response fields instead of exposing browser profile contents", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      ...savedStatus,
      futureMetadata: { formatVersion: 2 },
      profileContents: "inert-extra-field",
    })));
    await expect(fetchSharedBrowserProfileStatus("project-1")).resolves.toEqual({
      success: true, status: savedStatus,
    });
  });

  it.each([
    null,
    [],
    false,
    "unknown",
    {},
    { status: emptyStatus },
    { enabled: false },
    { ...emptyStatus, enabled: "false" },
    { ...emptyStatus, lastSavedAt: 0 },
    { ...emptyStatus, lastSavedAt: "not-a-date" },
    { ...emptyStatus, lastSavedAt: "0".repeat(65) },
    { ...emptyStatus, savedByRuntimeId: 1 },
    { ...savedStatus, savedByRuntimeId: "not-a-runtime" },
    { ...savedStatus, savedByRuntimeId: undefined },
    { ...emptyStatus, savedByRuntimeId: savedStatus.savedByRuntimeId },
  ])("reports malformed or unknown status as unavailable, never policy off: %j", async (value) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(value)));
    await expect(fetchSharedBrowserProfileStatus("project-1")).resolves.toEqual({
      success: false, error: "Shared Browser save status is unavailable.",
    });
  });

  it("preserves controller authorization failures without inventing an empty snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Project access denied." }), {
      status: 403, headers: { "content-type": "application/json" },
    })));
    await expect(fetchSharedBrowserProfileStatus("project-1")).resolves.toEqual({
      success: false, error: "Project access denied.",
    });
  });

  it.each(["invalid JSON", "", null])("does not interpret an unreadable body as off: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: body === null ? 204 : 200 })));
    await expect(fetchSharedBrowserProfileStatus("project-1")).resolves.toMatchObject({ success: false });
  });

  it("returns unknown status after a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(fetchSharedBrowserProfileStatus("project-1")).resolves.toMatchObject({ success: false });
  });

  it("does not request metadata without a project or authenticated session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSharedBrowserProfileStatus("   ")).resolves.toEqual({ success: false, error: "Missing project id." });
    expect(resolveControllerAccessTokenMock).not.toHaveBeenCalled();
    resolveControllerAccessTokenMock.mockResolvedValue(null);
    await expect(fetchSharedBrowserProfileStatus("project-1")).resolves.toEqual({ success: false, error: "Missing controller session token." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("clearSharedBrowserData", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("session-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends one authenticated DELETE to the project profile endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(clearSharedBrowserData(" project-1 ")).resolves.toEqual({
      success: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://controller.test/projects/project-1/browser-profile");
    expect(init.method).toBe("DELETE");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer session-token",
    );
    expect(init.body).toBeUndefined();
  });

  it("accepts the controller's JSON success response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(clearSharedBrowserData("project-1")).resolves.toEqual({
      success: true,
    });
  });

  it("surfaces the controller error and rejects a missing project locally", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Writers only." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(clearSharedBrowserData("project-1")).resolves.toEqual({
      success: false,
      error: "Writers only.",
    });
    await expect(clearSharedBrowserData("   ")).resolves.toEqual({
      success: false,
      error: "Missing project id.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
