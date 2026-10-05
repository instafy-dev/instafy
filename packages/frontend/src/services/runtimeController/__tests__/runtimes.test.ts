import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureRuntime, fetchRuntimeStatus, startRuntime } from "../runtimes";
import { CONTROLLER_READ_BUDGET_MS } from "../readBudget";

const { resolveContext, readError } = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  readError: vi.fn(),
}));
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  resolveControllerRequestContext: resolveContext,
  readControllerError: readError,
  coerceControllerRuntimeIdleTtlSeconds: () => 600,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const context = { baseUrl: "https://controller.test", accessToken: "inert-session" };
const snapshot = {
  runtimes: [{ runtimeId: "runtime-1", runtimeImage: " image@sha256:example " }],
  preferredRuntimeId: "runtime-1",
};

describe("fetchRuntimeStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resolveContext.mockResolvedValue(context);
    readError.mockResolvedValue("Runtime status unavailable");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot))));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the authenticated status response and disposes its deadline", async () => {
    await expect(fetchRuntimeStatus({ projectId: "project/one", accessToken: "provided-session" })).resolves.toEqual({
      ...snapshot,
      runtimes: [{ ...snapshot.runtimes[0], runtimeImage: "image@sha256:example" }],
    });
    expect(resolveContext).toHaveBeenCalledWith("provided-session");
    expect(fetch).toHaveBeenCalledWith("https://controller.test/projects/project%2Fone/runtime/status", {
      headers: { authorization: "Bearer inert-session" },
      signal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["credentials", "request", "success body", "error body"])(
    "settles a stalled %s so browser discovery and refresh can retry",
    async (phase) => {
      const stalled = new Promise<never>(() => {});
      const json = vi.fn(() => stalled);
      if (phase === "credentials") resolveContext.mockReturnValueOnce(stalled);
      if (phase === "request") vi.mocked(fetch).mockReturnValueOnce(stalled);
      if (phase === "success body") vi.mocked(fetch).mockResolvedValueOnce(Object.assign(new Response("{}"), { json }));
      if (phase === "error body") {
        vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 503 }));
        readError.mockReturnValueOnce(stalled);
      }

      const request = fetchRuntimeStatus({ projectId: "project-1", quietOnAbort: true });
      await vi.advanceTimersByTimeAsync(0);
      if (phase === "success body") expect(json).toHaveBeenCalledOnce();
      if (phase === "error body") expect(readError).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(CONTROLLER_READ_BUDGET_MS);
      await expect(request).resolves.toBeNull();
      expect(console.warn).toHaveBeenCalledWith("[runtime-controller] fetchRuntimeStatus error:", "Controller read timed out.");
      expect(vi.getTimerCount()).toBe(0);
      if (phase === "credentials") expect(fetch).not.toHaveBeenCalled();
      else expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);

      // A later refresh gets a fresh budget and can recover normally.
      await expect(fetchRuntimeStatus({ projectId: "project-1" })).resolves.toMatchObject({ preferredRuntimeId: "runtime-1" });
    },
  );

  it("uses one deadline across credentials and response body", async () => {
    const credentials = deferred<typeof context>();
    const body = deferred<typeof snapshot>();
    const json = vi.fn(() => body.promise);
    resolveContext.mockReturnValueOnce(credentials.promise);
    vi.mocked(fetch).mockResolvedValueOnce(Object.assign(new Response("{}"), { json }));
    const request = fetchRuntimeStatus({ projectId: "project-1" });
    await vi.advanceTimersByTimeAsync(CONTROLLER_READ_BUDGET_MS - 1);
    credentials.resolve(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(json).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toBeNull();
    body.resolve(snapshot);
  });

  it("does not start a late request after cancellation during credential resolution", async () => {
    const credentials = deferred<typeof context>();
    resolveContext.mockReturnValueOnce(credentials.promise);
    const abort = new AbortController();
    const request = fetchRuntimeStatus({ projectId: "project-1", signal: abort.signal, quietOnAbort: true });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(request).resolves.toBeNull();
    credentials.resolve(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a late body after the caller cancels", async () => {
    const body = deferred<typeof snapshot>();
    const json = vi.fn(() => body.promise);
    vi.mocked(fetch).mockResolvedValueOnce(Object.assign(new Response("{}"), { json }));
    const abort = new AbortController();
    const request = fetchRuntimeStatus({ projectId: "project-1", signal: abort.signal, quietOnAbort: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(json).toHaveBeenCalledOnce();
    abort.abort();
    await expect(request).resolves.toBeNull();
    body.resolve(snapshot);
    expect(console.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps pre-canceled and signed-out reads empty without an HTTP request", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(fetchRuntimeStatus({ projectId: "project-1", signal: abort.signal })).resolves.toBeNull();
    expect(resolveContext).not.toHaveBeenCalled();
    resolveContext.mockResolvedValueOnce({ ...context, accessToken: null });
    await expect(fetchRuntimeStatus({ projectId: "project-1" })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ensureRuntime", () => {
  const ensured = { runtime_id: "runtime-2", leaseId: "lease-2", status: "requested", provider: "instafy-cloud" };

  beforeEach(() => {
    resolveContext.mockResolvedValue(context);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ensured))));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  function sentBodies() {
    return vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
  }

  it("asks the controller to replace a stalled launch only when told to", async () => {
    await ensureRuntime({ projectId: "project-1", provider: "instafy-cloud", replaceStalledLaunch: true });
    await ensureRuntime({ projectId: "project-1", provider: "instafy-cloud", replaceStalledLaunch: false });
    await ensureRuntime({ projectId: "project-1", provider: "instafy-cloud" });

    expect(fetch).toHaveBeenCalledWith("https://controller.test/runtime/ensure", expect.objectContaining({ method: "POST" }));
    const [replace, plainFalse, plain] = sentBodies();
    expect(replace).toMatchObject({ project_id: "project-1", replaceStalledLaunch: true });
    // Older controllers see exactly the body they always did.
    expect(plainFalse).not.toHaveProperty("replaceStalledLaunch");
    expect(plain).not.toHaveProperty("replaceStalledLaunch");
    expect(plain).toEqual(plainFalse);
  });

  it("forwards the flag from a Machines start, which ensures with the runtime id", async () => {
    await expect(
      startRuntime({ projectId: "project-1", runtimeId: "runtime-1", replaceStalledLaunch: true }),
    ).resolves.toBe(true);
    await startRuntime({ projectId: "project-1", runtimeId: "runtime-1" });

    const [replace, plain] = sentBodies();
    expect(replace).toMatchObject({ runtime_id: "runtime-1", provider: "instafy-cloud", replaceStalledLaunch: true });
    expect(plain).toMatchObject({ runtime_id: "runtime-1" });
    expect(plain).not.toHaveProperty("replaceStalledLaunch");
  });
});
