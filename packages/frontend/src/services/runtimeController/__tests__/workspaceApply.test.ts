import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyWorkspaceChangesViaOrigin } from "../workspaceApply";
import { fetchOriginSummary, requestOriginAccessToken } from "../origins";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../workspaceLeases";

vi.mock("../core", () => ({ runtimeControllerEnabled: true }));
vi.mock("../origins", () => ({ fetchOriginSummary: vi.fn(), requestOriginAccessToken: vi.fn() }));
vi.mock("../workspaceLeases", () => ({ acquireWorkspaceLease: vi.fn(), releaseWorkspaceLease: vi.fn() }));
const fetchMock = vi.fn();
const params = { projectId: "project", runtimeId: "runtime", files: [{ path: "image.png", bytes: new Uint8Array([1, 2, 3]) }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(fetchOriginSummary).mockResolvedValue({ originId: "default-origin", runtimeId: "other-runtime", endpoint: "http://default.invalid", mode: "hosted", presence: null });
  vi.mocked(acquireWorkspaceLease).mockResolvedValue({ leaseId: "lease" } as Awaited<ReturnType<typeof acquireWorkspaceLease>>);
  vi.mocked(releaseWorkspaceLease).mockResolvedValue(undefined as never);
  vi.mocked(requestOriginAccessToken).mockResolvedValue({ originId: "runtime-origin", endpoint: "http://origin.invalid", mode: "hosted", token: "inert-test-token", expiresIn: 60, scopes: ["fs.write"] });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ rev: "rev" }), { headers: { "content-type": "application/json" } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("workspace origin writes", () => {
  it("lets the controller resolve the requested runtime instead of pinning an unrelated default", async () => {
    expect(await applyWorkspaceChangesViaOrigin(params)).toMatchObject({ ok: true, rev: "rev" });
    expect(requestOriginAccessToken).toHaveBeenCalledWith(expect.objectContaining({ originId: null, preferRuntime: "runtime", leaseId: "lease", throwOnError: true }));
    expect(releaseWorkspaceLease).toHaveBeenCalledWith(expect.objectContaining({ leaseId: "lease", runtimeId: "runtime" }));
  });
  it("preserves an explicitly requested origin", async () => {
    await applyWorkspaceChangesViaOrigin({ ...params, originId: "explicit-origin" });
    expect(requestOriginAccessToken).toHaveBeenCalledWith(expect.objectContaining({ originId: "explicit-origin", preferRuntime: "runtime" }));
  });
  it("does not block a requested runtime on another origin's offline status", async () => {
    vi.mocked(fetchOriginSummary).mockResolvedValue({ originId: "default-origin", runtimeId: "other-runtime", endpoint: "http://default.invalid", mode: "hosted", presence: { status: "offline" } } as Awaited<ReturnType<typeof fetchOriginSummary>>);
    expect(await applyWorkspaceChangesViaOrigin(params)).toMatchObject({ ok: true });
  });
  it("can resolve a runtime origin before a project default exists", async () => {
    vi.mocked(fetchOriginSummary).mockResolvedValue(null);
    expect(await applyWorkspaceChangesViaOrigin(params)).toMatchObject({ ok: true });
  });
  it("retains an authorization rejection and releases its lease without uploading", async () => {
    vi.mocked(requestOriginAccessToken).mockRejectedValue(new Error("request origin access token failed (403): origin is not bound to the requested active runtime"));
    expect(await applyWorkspaceChangesViaOrigin(params)).toMatchObject({ ok: false, error: expect.stringContaining("(403)") });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseWorkspaceLease).toHaveBeenCalledOnce();
  });
  it("aborts a stalled upload and releases its lease", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
    const pending = applyWorkspaceChangesViaOrigin(params);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ ok: false, error: "origin apply timed out after 30000ms" });
    expect(releaseWorkspaceLease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
