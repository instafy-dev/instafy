import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchLocalWorkspacePresence,
  fetchLocalWorkspacePresenceResult,
  fetchOriginSummary,
  fetchOriginSummaryResult,
} from "../origins";

const { resolveContext, readError } = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  readError: vi.fn(),
}));
vi.mock("../core", () => ({
  controllerBaseUrl: "https://controller.test",
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: resolveContext,
  readControllerError: readError,
  normalizeOriginEndpointForClient: (endpoint: string) => endpoint.trim(),
}));

const context = { baseUrl: "https://controller.test", accessToken: "inert-session" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("origin hydration fetches", () => {
  beforeEach(() => {
    resolveContext.mockResolvedValue(context);
    readError.mockResolvedValue("unauthorized");
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("tells a space without a default origin from a request that got no answer", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ origin_id: "gateway", endpoint: "https://gw", mode: "hosted" }));
    await expect(fetchOriginSummaryResult({ projectId: "space-a", protocol: "http" })).resolves.toMatchObject({
      ok: true,
      summary: { originId: "gateway", endpoint: "https://controller.test/origin/gateway", mode: "hosted" },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(fetchOriginSummaryResult({ projectId: "space-a" })).resolves.toEqual({ ok: true, summary: null });

    for (const answer of [
      () => Promise.resolve(new Response("bad gateway", { status: 502 })),
      () => Promise.resolve(new Response("", { status: 401 })),
      () => Promise.resolve(new Response("", { status: 403 })),
      () => Promise.resolve(json({ mode: "hosted" })),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]) {
      vi.mocked(fetch).mockImplementationOnce(answer);
      await expect(fetchOriginSummaryResult({ projectId: "space-a" })).resolves.toEqual({ ok: false });
    }
    resolveContext.mockResolvedValueOnce({ ...context, accessToken: null });
    await expect(fetchOriginSummaryResult({ projectId: "space-a" })).resolves.toEqual({ ok: false });

    // The plain call still answers null for both.
    vi.mocked(fetch).mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    await expect(fetchOriginSummary({ projectId: "space-a" })).resolves.toBeNull();
  });

  it("tells a space without a local workspace from a request that got no answer", async () => {
    const workspace = { deviceId: "device-1", path: "/Users/me/space", status: "online", presenceStatus: "online" };
    vi.mocked(fetch).mockResolvedValueOnce(json({ workspace }));
    await expect(fetchLocalWorkspacePresenceResult({ projectId: "space-a" })).resolves.toMatchObject({
      ok: true,
      workspace: { deviceId: "device-1", path: "/Users/me/space" },
    });
    vi.mocked(fetch).mockResolvedValueOnce(json({ workspace: null }));
    await expect(fetchLocalWorkspacePresenceResult({ projectId: "space-a" })).resolves.toEqual({ ok: true, workspace: null });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(fetchLocalWorkspacePresenceResult({ projectId: "space-a" })).resolves.toEqual({ ok: true, workspace: null });

    for (const answer of [
      () => Promise.resolve(new Response("bad gateway", { status: 502 })),
      () => Promise.resolve(new Response("", { status: 401 })),
      () => Promise.resolve(new Response("", { status: 403 })),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]) {
      vi.mocked(fetch).mockImplementationOnce(answer);
      await expect(fetchLocalWorkspacePresenceResult({ projectId: "space-a" })).resolves.toEqual({ ok: false });
    }
    resolveContext.mockResolvedValueOnce({ ...context, accessToken: null });
    await expect(fetchLocalWorkspacePresenceResult({ projectId: "space-a" })).resolves.toEqual({ ok: false });

    vi.mocked(fetch).mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
    await expect(fetchLocalWorkspacePresence({ projectId: "space-a" })).resolves.toBeNull();
  });
});
