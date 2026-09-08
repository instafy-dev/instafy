import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyWorkspaceChangesViaOrigin } from "../workspaceApply";
import { fetchOriginSummary, requestOriginAccessToken } from "../origins";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../workspaceLeases";
import { resolveControllerRequestContext } from "../core";

vi.mock("../core", () => ({ runtimeControllerEnabled: true, resolveControllerRequestContext: vi.fn() }));
vi.mock("../origins", () => ({ fetchOriginSummary: vi.fn(), requestOriginAccessToken: vi.fn() }));
vi.mock("../workspaceLeases", () => ({ acquireWorkspaceLease: vi.fn(), releaseWorkspaceLease: vi.fn() }));
const fetchMock = vi.fn();
const params = { projectId: "project", runtimeId: "runtime", files: [{ path: "image.png", bytes: new Uint8Array([1, 2, 3]) }] };
const requestContext = { baseUrl: "http://controller.invalid", accessToken: "inert-session", credentialSource: "ambient" as const, generation: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resolveControllerRequestContext).mockResolvedValue(requestContext);
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
  it("keeps the actual target after a write fails and pins rollback to its controller and credentials", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection closed after write"));
    const failure = await applyWorkspaceChangesViaOrigin(params);
    expect(failure).toMatchObject({ ok: false, target: { projectId: "project", originId: "runtime-origin", runtimeId: "runtime", requestContext } });
    vi.clearAllMocks();
    const rollback = await applyWorkspaceChangesViaOrigin({ projectId: "project", files: [], deletes: ["image.png"], target: failure.target, runtimeId: "replacement-runtime" });
    expect(rollback.ok).toBe(true);
    expect(resolveControllerRequestContext).not.toHaveBeenCalled();
    expect(fetchOriginSummary).not.toHaveBeenCalled();
    expect(acquireWorkspaceLease).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "runtime", requestContext }));
    expect(requestOriginAccessToken).toHaveBeenCalledWith(expect.objectContaining({ originId: "runtime-origin", preferRuntime: "runtime", requestContext }));
    expect(releaseWorkspaceLease).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "runtime", requestContext }));
  });
  it("rejects a pinned target from another project without network calls", async () => {
    const result = await applyWorkspaceChangesViaOrigin({ ...params, target: { projectId: "another-project", originId: "origin", runtimeId: "runtime", requestContext } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("another project") });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(acquireWorkspaceLease).not.toHaveBeenCalled();
  });
  it("fails closed if the controller resolves a different origin for a pinned target", async () => {
    const result = await applyWorkspaceChangesViaOrigin({ ...params, target: { projectId: "project", originId: "original-origin", runtimeId: "runtime", requestContext } });
    expect(result).toMatchObject({ ok: false, error: "origin apply target changed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseWorkspaceLease).toHaveBeenCalledOnce();
  });
  it("bounds stalled auth resolution and never starts a late request", async () => {
    vi.useFakeTimers();
    let resolveAuth!: (value: typeof requestContext) => void;
    vi.mocked(resolveControllerRequestContext).mockImplementationOnce(() => new Promise(resolve => { resolveAuth = resolve; }));
    const pending = applyWorkspaceChangesViaOrigin({ ...params, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ ok: false, error: "origin apply timed out after 500ms" });
    resolveAuth(requestContext);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchOriginSummary).not.toHaveBeenCalled();
    expect(acquireWorkspaceLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds stalled preflight and does not upload when it eventually resolves", async () => {
    vi.useFakeTimers();
    let resolveToken!: (value: Awaited<ReturnType<typeof requestOriginAccessToken>>) => void;
    vi.mocked(requestOriginAccessToken).mockImplementationOnce(() => new Promise(resolve => { resolveToken = resolve; }));
    const pending = applyWorkspaceChangesViaOrigin({ ...params, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ ok: false, error: "origin apply timed out after 500ms" });
    resolveToken({ originId: "runtime-origin", endpoint: "http://origin.invalid", mode: "hosted", token: "inert", expiresIn: 60, scopes: ["fs.write"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseWorkspaceLease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds stalled response bodies and lease release while retaining the attempted target", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => new Promise(() => {}) });
    vi.mocked(releaseWorkspaceLease).mockImplementationOnce(() => new Promise(() => {}));
    const pending = applyWorkspaceChangesViaOrigin({ ...params, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toMatchObject({ ok: false, error: "origin apply timed out after 500ms", target: { originId: "runtime-origin" } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves a permanent rejection when its error body stalls", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: () => new Promise(() => {}) });
    const pending = applyWorkspaceChangesViaOrigin({ ...params, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ ok: false, error: "origin apply failed (403): error response body unavailable", target: { originId: "runtime-origin" } });
    expect(releaseWorkspaceLease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
