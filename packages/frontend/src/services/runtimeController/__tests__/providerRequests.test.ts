import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveControllerAccessTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../core", () => ({
  controllerBaseUrl: "http://controller.test",
  readControllerError: vi.fn(),
  resolveControllerRequestContext: async (desired: string | null) => ({
    baseUrl: "http://controller.test",
    accessToken: await resolveControllerAccessTokenMock(desired),
    credentialSource: "ambient",
    generation: 1,
  }),
  runtimeControllerEnabled: true,
}));

import { listControllerProviderRequests } from "../providerRequests";

describe("listControllerProviderRequests", () => {
  beforeEach(() => {
    resolveControllerAccessTokenMock.mockReset();
    resolveControllerAccessTokenMock.mockResolvedValue("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes comma-separated statuses for controller filtering", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue("[]"),
      headers: new Headers(),
      status: 200,
    });
    vi.stubGlobal("fetch", fetchMock);

    await listControllerProviderRequests({
      projectId: "project-1",
      providerId: "camera:device-1",
      statuses: ["pending", "claimed"],
      limit: 5,
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("statuses")).toBe("pending,claimed");
    expect(parsed.searchParams.get("providerId")).toBe("camera:device-1");
    expect(parsed.searchParams.get("limit")).toBe("5");
  });
});
