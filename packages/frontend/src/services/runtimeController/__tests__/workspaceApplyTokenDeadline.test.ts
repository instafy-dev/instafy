import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyWorkspaceChangesViaOrigin } from "../workspaceApply";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../workspaceLeases";

// Keep both production request functions intact. Mock only credentials, leases
// and HTTP so the token helper's local timer and the outer apply budget really
// compete, including the controller error reader's body-failure fallback.
vi.mock("../core", () => ({
  runtimeControllerEnabled: true,
  controllerBaseUrl: "https://controller.invalid",
  normalizeOriginEndpointForClient: (value: string) => value,
  resolveControllerRequestContext: async () => ({
    baseUrl: "https://controller.invalid", accessToken: "inert-test-session",
    credentialSource: "fixed", generation: 1,
  }),
  readControllerError: async (response: Response, fallback: string) => {
    try { return await response.text(); }
    catch { return `${fallback} (${response.status})`; }
  },
}));
vi.mock("../workspaceLeases", () => ({ acquireWorkspaceLease: vi.fn(), releaseWorkspaceLease: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(acquireWorkspaceLease).mockResolvedValue({ leaseId: "test-lease" } as Awaited<ReturnType<typeof acquireWorkspaceLease>>);
  vi.mocked(releaseWorkspaceLease).mockResolvedValue(undefined as never);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("token rejection across the outer workspace deadline", () => {
  it.each([0, 40])("keeps 403 when its error body stalls beyond the remaining budget after %sms of preflight", async (preflightMs) => {
    let tokenSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/projects/project/origin") {
        if (preflightMs) await new Promise(resolve => setTimeout(resolve, preflightMs));
        return new Response(null, { status: 404 });
      }
      if (path === "/access_token") {
        tokenSignal = options?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            tokenSignal?.addEventListener("abort", () => controller.error(tokenSignal?.reason), { once: true });
          },
        });
        return new Response(body, { status: 403, headers: { "content-type": "text/plain" } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = applyWorkspaceChangesViaOrigin({
      projectId: "project", runtimeId: "runtime", timeoutMs: 50,
      files: [{ path: "image.png", bytes: new Uint8Array([1, 2, 3]), encoding: "binary" }],
    });

    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^request origin access token failed \(403\): /);
    expect(result.target).toBeUndefined();
    expect(tokenSignal?.aborted).toBe(true);
    expect(releaseWorkspaceLease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/projects/project/origin", "/access_token",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
