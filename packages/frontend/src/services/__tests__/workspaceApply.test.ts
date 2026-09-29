import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ summary: vi.fn(), token: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock("../runtimeController/core", () => ({ runtimeControllerEnabled: true }));
vi.mock("../runtimeController/origins", () => ({ fetchOriginSummary: mocks.summary, requestOriginAccessToken: mocks.token }));
vi.mock("../runtimeController/workspaceLeases", () => ({ acquireWorkspaceLease: mocks.acquire, releaseWorkspaceLease: mocks.release }));
import { applyWorkspaceChangesViaOrigin } from "../runtimeController/workspaceApply";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.summary.mockResolvedValue({ originId: "hosted-gateway", runtimeId: null, presence: { status: "online" } });
  mocks.acquire.mockResolvedValue({ leaseId: "workspace-lease" });
  mocks.release.mockResolvedValue(undefined);
  mocks.token.mockImplementation(async ({ originId, preferRuntime }) => {
    // Match the controller's exact origin/runtime binding requirement.
    if (originId === "hosted-gateway" && preferRuntime) return null;
    return { endpoint: "https://origin.test", token: "test-token", mode: "hosted" };
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"rev":"commit"}', { headers: { "content-type": "application/json" } })));
});
afterEach(() => vi.unstubAllGlobals());

describe("workspace writes resolve their selected runtime", () => {
  it("creates the file on the preferred runtime without combining it with the hosted gateway", async () => {
    const result = await applyWorkspaceChangesViaOrigin({ projectId: "project", runtimeId: "runtime", files: [{ path: "notes.md", content: "# Notes" }] });
    expect(result.ok).toBe(true);
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.token).toHaveBeenCalledWith(expect.objectContaining({ originId: null, preferRuntime: "runtime", leaseId: "workspace-lease" }));
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("preserves an explicit origin so a mismatch is rejected rather than redirected", async () => {
    const result = await applyWorkspaceChangesViaOrigin({ projectId: "project", runtimeId: "runtime", originId: "hosted-gateway", files: [{ path: "notes.md", content: "# Notes" }] });
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.token).toHaveBeenCalledWith(expect.objectContaining({ originId: "hosted-gateway", preferRuntime: "runtime" }));
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("continues using the default origin when no runtime or origin is selected", async () => {
    expect((await applyWorkspaceChangesViaOrigin({ projectId: "project", files: [{ path: "notes.md", content: "# Notes" }] })).ok).toBe(true);
    expect(mocks.token).toHaveBeenCalledWith(expect.objectContaining({ originId: "hosted-gateway", preferRuntime: null }));
  });

  it("still binds the workspace lease when the caller selects the default origin without a runtime", async () => {
    mocks.summary.mockResolvedValue({ originId: "runtime-origin", runtimeId: "runtime", presence: { status: "online" } });
    expect((await applyWorkspaceChangesViaOrigin({ projectId: "project", originId: "runtime-origin", files: [{ path: "notes.md", content: "# Notes" }] })).ok).toBe(true);
    expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "runtime" }));
    expect(mocks.token).toHaveBeenCalledWith(expect.objectContaining({ originId: "runtime-origin", preferRuntime: "runtime" }));
  });
});
