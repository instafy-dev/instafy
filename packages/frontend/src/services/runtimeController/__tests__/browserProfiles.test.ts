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

import { clearSharedBrowserData } from "../browserProfiles";

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
