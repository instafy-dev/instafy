import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveControllerRequestContextMock } = vi.hoisted(() => ({
  resolveControllerRequestContextMock: vi.fn(),
}));

vi.mock("../core", () => ({
  controllerBaseUrl: "",
  runtimeControllerEnabled: false,
  resolveControllerRequestContext: resolveControllerRequestContextMock,
  readControllerError: vi.fn(),
}));

import { controllerJsonRequest } from "../client";

describe("controllerJsonRequest explicit request context", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resolveControllerRequestContextMock.mockReset();
  });

  it("uses the originating controller base and token without re-resolving ambient state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const requestContext = {
      baseUrl: "https://old-controller.example.com",
      accessToken: "old-access-token",
      credentialSource: "fixed" as const,
      generation: 4,
    };

    await expect(
      controllerJsonRequest<{ ok: boolean }>({
        path: "/projects/project-123/integrations",
        accessToken: "new-access-token-that-must-not-win",
        requestContext,
        fallbackError: "Unable to load integrations",
      }),
    ).resolves.toMatchObject({
      success: true,
      value: { ok: true },
    });

    expect(resolveControllerRequestContextMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://old-controller.example.com/projects/project-123/integrations");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer old-access-token");
  });
});
