import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), readError: vi.fn() }));
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  controllerBaseUrl: "http://controller.test",
  normalizeOriginEndpointForClient: (value: string) => value,
  resolveControllerRequestContext: mocks.context,
  readControllerApiError: mocks.readError,
}));

import { requestOriginAccessToken, requestOriginAccessTokenResult } from "../origins";
import { probeWorkspaceAvailability } from "../workspaceAvailabilityProbe";

const context = { accessToken: "test-user-grant", baseUrl: "http://controller.test" };
const params = { projectId: "space", routing: "default" as const };
const tokenParams = { projectId: "space", protocol: "http" as const, scopes: ["fs.read" as const] };
function json(status: number, value: unknown) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function grant() {
  return json(200, { originId: "origin-1", endpoint: "http://private-runtime.test", token: "scoped-origin-grant", mode: "hosted", expiresIn: 300 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue(context);
  mocks.readError.mockImplementation(async (response: Response) => {
    const text = await response.text();
    let body: { message?: string; code?: string } = {};
    try { body = JSON.parse(text); } catch { /* older controller response */ }
    return { status: response.status, message: body.message ?? text, code: body.code ?? null };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("workspace availability probe", () => {
  it("uses fresh read-only grants through the controller proxy, not a compute-status guess", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(grant()).mockResolvedValueOnce(json(200, []))
      .mockResolvedValueOnce(grant()).mockResolvedValueOnce(json(200, [{ name: "src", kind: "directory" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeWorkspaceAvailability({ ...params, runtimeId: "stopped-runtime", originId: "origin-1" })).toEqual({ kind: "available" });
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind: "available" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ projectId: "space", protocol: "http", scopes: ["fs.read"], originId: "origin-1" });
    expect(fetchMock.mock.calls[1][0]).toBe("http://controller.test/origin/origin-1/entries");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: "no-store", headers: { authorization: "Bearer scoped-origin-grant" } });
  });

  it.each([
    { name: "report.md", path: "report.md", kind: "file", mime_type: "text/markdown", has_children: false },
    { name: "report.md", path: "report.md", kind: "file", mimeType: "text/markdown", hasChildren: false, blobOid: "oid" },
    { name: "src", path: "src", kind: "directory", hasChildren: true, size: null, modified: null },
  ])("accepts workspace listing dialect %j", async (entry) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(grant()).mockResolvedValueOnce(json(200, [entry])));
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind: "available" });
  });

  it("falls back from the selected runtime to a working canonical origin", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(grant()).mockResolvedValueOnce(json(503, { error: "runtime offline" }))
      .mockResolvedValueOnce(grant()).mockResolvedValueOnce(json(200, []));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeWorkspaceAvailability({ projectId: "space", runtimeId: "stopped-runtime" })).toEqual({ kind: "available" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).preferRuntime).toBe("stopped-runtime");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty("preferRuntime");
  });

  it.each([
    [404, "no origin available for requested protocol", null, "unavailable"],
    [404, "origin not registered", null, "unavailable"],
    [500, "WORKSPACE_ROOT is not configured", null, "unavailable"],
    [404, "origin path not found", null, "unknown"],
    [404, "path not found", null, "unknown"],
    [409, "workspace conflict", "head_moved", "unknown"],
    [401, "expired session", "unauthorized", "access"],
    [403, "permission denied", null, "access"],
    [502, "canonical unreachable", "canonical_unreachable", "connection"],
    [503, "fetch pending", "fetch_pending", "unknown"],
    [503, "workspace unavailable", "workspace_unavailable", "unavailable"],
    [503, "workspace overloaded", "disk_full", "unknown"],
    [503, "workspace mirror restarting", "mirror_reset", "unknown"],
    [503, "write slots busy", "writes_busy", "unknown"],
    [503, "upstream offline", null, "connection"],
  ])("classifies token failure %s/%s as %s", async (status, message, code, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(status, { message, code })));
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind });
    expect(mocks.readError).toHaveBeenCalledWith(expect.any(Response), "request origin access token failed", context);
  });

  it.each([
    [404, { error: "path not found" }, "unknown"],
    [404, { error: "origin path not found" }, "unknown"],
    [409, { error: "head changed", code: "head_moved" }, "unknown"],
    [403, { error: "forbidden" }, "access"],
    [503, { error: "fetch pending", code: "fetch_pending" }, "unknown"],
    [503, { error: "workspace unavailable", code: "workspace_unavailable" }, "unavailable"],
  ])("preserves the root response distinction %s/%j", async (status, body, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(grant()).mockResolvedValueOnce(json(status, body)));
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind });
  });

  it("does not send an unauthenticated request when the session is absent", async () => {
    mocks.context.mockResolvedValue({ ...context, accessToken: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind: "access" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries canonical routing after the preferred token cannot find an origin", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(404, { message: "no origin available for requested protocol" }))
      .mockResolvedValueOnce(grant()).mockResolvedValueOnce(json(200, [])));
    expect(await probeWorkspaceAvailability({ projectId: "space", runtimeId: "old-runtime" })).toEqual({ kind: "available" });
  });

  it("does not turn malformed token or root bodies into connection failures", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, { wrong: "shape" }))
      .mockResolvedValueOnce(grant()).mockResolvedValueOnce(new Response("broken json", { status: 200 }))
      .mockResolvedValueOnce(grant()).mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(grant()).mockResolvedValueOnce(json(200, [{}]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind: "unknown" });
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind: "unknown" });
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind: "unknown" });
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind: "unknown" });
  });

  it("recognizes a network failure at either controller or origin", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(grant()).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind: "connection" });
    expect(await probeWorkspaceAvailability(params)).toEqual({ kind: "connection" });
  });

  it("bounds a stalled auth context without sending any request afterwards", async () => {
    vi.useFakeTimers();
    let resolveContext!: (value: typeof context) => void;
    mocks.context.mockImplementation(() => new Promise((resolve) => { resolveContext = resolve; }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pending = probeWorkspaceAvailability(params);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ kind: "connection" });
    resolveContext(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts stalled network requests and bounds response-body reads", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    }));
    const pending = probeWorkspaceAvailability(params);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toEqual({ kind: "connection" });
    expect(signal?.aborted).toBe(true);

    const stalled = json(200, []);
    vi.spyOn(stalled, "json").mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(grant()).mockResolvedValueOnce(stalled));
    const bodyPending = probeWorkspaceAvailability(params);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await bodyPending).toEqual({ kind: "connection" });
  });

  it("does not use missing canonical configuration to mask a runtime connection failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json(404, { message: "no origin available for requested protocol" })));
    expect(await probeWorkspaceAvailability({ projectId: "space", runtimeId: "r" })).toEqual({ kind: "connection" });
  });
});

describe("typed origin token requests", () => {
  it("preserves failure status and code while the existing API remains nullable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json(503, { message: "origin unavailable", code: "fetch_pending" })));
    expect(await requestOriginAccessTokenResult({ ...tokenParams, forceRefresh: true })).toMatchObject({ ok: false, error: { status: 503, code: "fetch_pending" } });
    expect(await requestOriginAccessToken({ ...tokenParams, forceRefresh: true })).toBeNull();
  });

  it("keeps cached success compatible with nullable callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(grant());
    vi.stubGlobal("fetch", fetchMock);
    const first = await requestOriginAccessToken({ ...tokenParams, forceRefresh: true });
    expect(first).toMatchObject({ originId: "origin-1", token: "scoped-origin-grant" });
    expect(await requestOriginAccessToken(tokenParams)).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
