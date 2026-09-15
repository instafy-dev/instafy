import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOriginSummary, requestOriginAccessToken } from "../origins";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../workspaceLeases";
import type { ControllerRequestContext } from "../core";
const contextMock = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  controllerBaseUrl: "http://controller.invalid",
  normalizeOriginEndpointForClient: (value: string) => value,
  resolveControllerRequestContext: contextMock.resolve,
  readControllerError: async (response: Response) => response.text(),
  safeJson: (value: unknown) => value,
}));
const originalContext: ControllerRequestContext = {
  baseUrl: "http://controller.invalid", accessToken: "inert-user-token", credentialSource: "fixed", generation: 1,
};
beforeEach(() => contextMock.resolve.mockReset().mockResolvedValue(originalContext));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("origin token error handling", () => {
  it("preserves HTTP status and detail for strict write callers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("origin is not bound to the requested active runtime", { status: 403 })));
    await expect(requestOriginAccessToken({ projectId: "project", scopes: ["fs.write"], throwOnError: true })).rejects.toThrow("request origin access token failed (403): origin is not bound");
  });
  it("keeps the existing nullable contract for other callers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    await expect(requestOriginAccessToken({ projectId: "project", scopes: ["fs.write"] })).resolves.toBeNull();
  });
  it.each([true, false])("retains a known 403 when its error body stalls (strict %s)", async (throwOnError) => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => ({
      ok: false, status: 403,
      text: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })),
    })));
    const pending = requestOriginAccessToken({
      projectId: "denied-body-timeout", scopes: ["fs.write"], requestContext: originalContext, timeoutMs: 25, throwOnError,
    });
    const assertion = throwOnError
      ? expect(pending).rejects.toThrow("request origin access token failed (403): request origin access token timed out after 25ms")
      : expect(pending).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains a known 403 if reading its error body fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, text: async () => { throw new TypeError("Failed to fetch"); } })));
    await expect(requestOriginAccessToken({
      projectId: "denied-body-error", scopes: ["fs.write"], throwOnError: true,
    })).rejects.toThrow("request origin access token failed (403): Failed to fetch");
  });
  it("reports rejection headers before a stalled body so an outer deadline can retain the status", async () => {
    const controller = new AbortController();
    const onErrorResponse = vi.fn();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => ({
      ok: false, status: 403,
      text: () => new Promise((_resolve, reject) => {
        expect(onErrorResponse).toHaveBeenCalledExactlyOnceWith(403);
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        bodyStarted();
      }),
    })));
    const reason = new DOMException("Overall deadline reached", "AbortError");
    const rejected = expect(requestOriginAccessToken({
      projectId: "outer-deadline", scopes: ["fs.write"], requestContext: originalContext,
      signal: controller.signal, onErrorResponse, throwOnError: true,
    })).rejects.toBe(reason);
    await started;
    expect(onErrorResponse).toHaveBeenCalledExactlyOnceWith(403);
    controller.abort(reason);
    await rejected;
  });
  it("does not share token requests between callers observing rejection headers", async () => {
    const complete: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => complete.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const callbacks = [vi.fn(), vi.fn()];
    const params = { projectId: "independent-header-observers", scopes: ["fs.read"] as ["fs.read"], requestContext: originalContext };
    const first = requestOriginAccessToken({ ...params, onErrorResponse: callbacks[0] });
    const second = requestOriginAccessToken({ ...params, onErrorResponse: callbacks[1] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    complete[0](new Response("denied", { status: 403 }));
    complete[1](new Response("unavailable", { status: 503 }));
    await Promise.all([first, second]);
    expect(callbacks[0]).toHaveBeenCalledExactlyOnceWith(403);
    expect(callbacks[1]).toHaveBeenCalledExactlyOnceWith(503);
  });
});

type RequestOptions = { signal?: AbortSignal; requestContext?: ControllerRequestContext };
const operations = [
  { name: "origin summary", call: (options: RequestOptions) => fetchOriginSummary({ projectId: "project", ...options }) },
  { name: "origin token", call: (options: RequestOptions) => requestOriginAccessToken({ projectId: "project", scopes: ["fs.write"], throwOnError: true, ...options }) },
  { name: "lease acquisition", call: (options: RequestOptions) => acquireWorkspaceLease({ projectId: "project", runtimeId: "runtime", ...options }) },
  { name: "lease release", call: (options: RequestOptions) => releaseWorkspaceLease({ projectId: "project", runtimeId: "runtime", leaseId: "lease", ...options }) },
];
const payload = {
  origin_id: "origin", endpoint: "http://origin.invalid", token: "inert-origin-token", expires_in: 60,
  scopes: ["fs.read"], lease_id: "lease", project_id: "project",
};

describe("origin and lease request cancellation", () => {
  it.each(operations)("pins $name to the supplied context without resolving a later session", async ({ call }) => {
    const pinned = { ...originalContext, baseUrl: "http://pinned.invalid", accessToken: "inert-original-session" };
    const fetchMock = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    await call({ requestContext: pinned });
    expect(contextMock.resolve).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/pinned.invalid\//), expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer inert-original-session" }),
    }));
  });

  it.each(operations)("does not start $name if context resolution finishes after cancellation", async ({ call }) => {
    let finishContext!: (value: ControllerRequestContext) => void;
    contextMock.resolve.mockReturnValue(new Promise<ControllerRequestContext>((resolve) => { finishContext = resolve; }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const reason = new DOMException("Operation cancelled", "AbortError");
    const rejected = expect(call({ signal: controller.signal })).rejects.toBe(reason);
    controller.abort(reason);
    finishContext(originalContext);
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(operations)("passes cancellation through an in-flight $name request", async ({ call }) => {
    const controller = new AbortController();
    const reason = new DOMException("Operation cancelled", "AbortError");
    const fetchMock = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const rejected = expect(call({ signal: controller.signal, requestContext: originalContext })).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the token timeout active through response body consumption", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })),
    })));
    const rejected = expect(requestOriginAccessToken({
      projectId: "body-timeout", scopes: ["fs.write"], requestContext: originalContext, timeoutMs: 25, throwOnError: true,
    })).rejects.toThrow("request origin access token timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 403])("preserves external body abort and cleans up token timers and caller listeners after status %s", async (status) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      const readBody = () => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        bodyStarted();
      });
      return { ok: status === 200, status, json: readBody, text: readBody };
    }));
    const reason = new DOMException("Cleanup deadline reached", "AbortError");
    const rejected = expect(requestOriginAccessToken({
      projectId: "body-abort", scopes: ["fs.write"], requestContext: originalContext, signal: controller.signal,
    })).rejects.toBe(reason);
    await started;
    controller.abort(reason);
    await rejected;
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not share cancellable token requests with another caller", async () => {
    const controllers = [new AbortController(), new AbortController()];
    const complete: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn((_url, options) => new Promise<Response>((resolve, reject) => {
      complete.push(resolve);
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const params = { projectId: "independent-callers", scopes: ["fs.read"] as ["fs.read"], requestContext: originalContext };
    const first = requestOriginAccessToken({ ...params, signal: controllers[0].signal });
    const second = requestOriginAccessToken({ ...params, signal: controllers[1].signal });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reason = new DOMException("Only caller one cancelled", "AbortError");
    const rejected = expect(first).rejects.toBe(reason);
    controllers[0].abort(reason);
    complete[1](Response.json(payload));
    await rejected;
    await expect(second).resolves.toMatchObject({ originId: "origin" });
    expect(controllers[1].signal.aborted).toBe(false);
  });

  it("keeps cached origin credentials within their controller context", async () => {
    const fetchMock = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    const params = { projectId: "controller-cache-scope", scopes: ["fs.read"] as ["fs.read"] };
    await requestOriginAccessToken({ ...params, requestContext: originalContext });
    const result = await requestOriginAccessToken({ ...params, requestContext: { ...originalContext, baseUrl: "http://other-controller.invalid" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.endpoint).toMatch(/^http:\/\/other-controller.invalid\//);
  });
});
