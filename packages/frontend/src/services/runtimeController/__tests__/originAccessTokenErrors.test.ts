import { afterEach, describe, expect, it, vi } from "vitest";
import { requestOriginAccessToken } from "../origins";
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  controllerBaseUrl: "http://controller.invalid",
  normalizeOriginEndpointForClient: (value: string) => value,
  resolveControllerRequestContext: async () => ({ baseUrl: "http://controller.invalid", accessToken: "inert-user-token" }),
  readControllerError: async (response: Response) => response.text(),
}));
afterEach(() => vi.unstubAllGlobals());
describe("origin token error handling", () => {
  it("preserves HTTP status and detail for strict write callers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("origin is not bound to the requested active runtime", { status: 403 })));
    await expect(requestOriginAccessToken({ projectId: "project", scopes: ["fs.write"], throwOnError: true })).rejects.toThrow("request origin access token failed (403): origin is not bound");
  });
  it("keeps the existing nullable contract for other callers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    await expect(requestOriginAccessToken({ projectId: "project", scopes: ["fs.write"] })).resolves.toBeNull();
  });
});
