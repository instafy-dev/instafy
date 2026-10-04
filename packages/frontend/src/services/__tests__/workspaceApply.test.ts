import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ summary: vi.fn(), token: vi.fn(), acquire: vi.fn(), release: vi.fn(), signal: vi.fn() }));
vi.mock("../runtimeController/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimeController/core")>()),
  runtimeControllerEnabled: true,
  normalizeOriginEndpointForClient: (value: string) => value,
}));
vi.mock("../runtimeController/origins", () => ({ fetchOriginSummary: mocks.summary, requestOriginAccessToken: mocks.token }));
vi.mock("../runtimeController/workspaceLeases", () => ({ acquireWorkspaceLease: mocks.acquire, releaseWorkspaceLease: mocks.release }));
vi.mock("../runtimeController/workspaceVersioningCache", () => ({ noteVersioningSignal: mocks.signal }));
import { instafyClientHeaderValue } from "../runtimeController/originRequest";
import { applyWorkspaceChangesViaOrigin } from "../runtimeController/workspaceApply";

async function sentManifest(callIndex = 0): Promise<Record<string, unknown>> {
  const init = vi.mocked(fetch).mock.calls[callIndex][1] as RequestInit;
  const manifest = (init.body as FormData).get("manifest") as Blob;
  return JSON.parse(await manifest.text()) as Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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

describe("legacy apply requests are unchanged", () => {
  it("sends the same manifest fields and only adds X-Instafy-Client", async () => {
    await applyWorkspaceChangesViaOrigin({ projectId: "project", files: [{ path: "./notes.md", content: "# Notes" }], deletes: ["old.md"] });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://origin.test/apply");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ authorization: "Bearer test-token", "x-instafy-client": instafyClientHeaderValue() });
    const manifest = await sentManifest();
    expect(Object.keys(manifest)).toEqual(["projectId", "leaseId", "files", "deletes", "generatedAt"]);
    expect(manifest).toMatchObject({
      projectId: "project",
      leaseId: "workspace-lease",
      files: [{ path: "notes.md", size: 7, encoding: "utf8" }],
      deletes: ["old.md"],
    });
  });

  it("writes baseRev, expected and commitMessage only when given", async () => {
    await applyWorkspaceChangesViaOrigin({
      projectId: "project",
      files: [{ path: "a.md", content: "a" }],
      baseRev: "base-1",
      expected: { "./a.md": "oid-a", "new.md": null },
      commitMessage: "Update a.md",
    });
    expect(await sentManifest()).toMatchObject({
      baseRev: "base-1",
      expected: { "a.md": "oid-a", "new.md": null },
      commitMessage: "Update a.md",
    });
  });
});

describe("default routing apply", () => {
  it("pins the origin without preferRuntime or a summary lookup and reads committed", async () => {
    mocks.token.mockResolvedValue({ originId: "gateway", endpoint: "https://origin.test", token: "test-token", mode: "hosted" });
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { rev: "r2", baseRev: "r1", committed: true, fileCount: 1, bytesWritten: 1 }));
    const result = await applyWorkspaceChangesViaOrigin({
      projectId: "project",
      runtimeId: "runtime",
      originId: "gateway",
      routing: "default",
      files: [{ path: "a.md", content: "a" }],
      baseRev: "r1",
    });
    expect(mocks.summary).not.toHaveBeenCalled();
    const mint = mocks.token.mock.calls[0][0];
    expect(mint).toMatchObject({ originId: "gateway", leaseId: "workspace-lease", scopes: ["fs.write"] });
    expect(mint).not.toHaveProperty("preferRuntime");
    expect(result).toMatchObject({ ok: true, rev: "r2", baseRev: "r1", committed: true, originId: "gateway", originMode: "hosted" });
    expect(mocks.signal).toHaveBeenCalledWith("gateway", "committed");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("returns structured errors", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(409, { error: "moved", code: "head_moved", head: "e", paths: ["a.md"] }));
    const result = await applyWorkspaceChangesViaOrigin({ projectId: "project", routing: "default", files: [{ path: "a.md", content: "a" }] });
    expect(result).toMatchObject({ ok: false, errorInfo: { status: 409, code: "head_moved", head: "e", paths: ["a.md"] } });
    expect(result.error).toMatch(/^origin apply failed \(409\)/);
  });

  it("reports a refused directory delete as a versioning signal (legacy routing too)", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(400, { error: "needs baseRev", code: "delete_requires_base_rev" }));
    mocks.token.mockResolvedValue({ originId: "hosted-gateway", endpoint: "https://origin.test", token: "test-token", mode: "hosted" });
    const result = await applyWorkspaceChangesViaOrigin({ projectId: "project", files: [], deletes: ["docs"] });
    expect(result.errorInfo?.code).toBe("delete_requires_base_rev");
    expect(mocks.signal).toHaveBeenCalledWith("hosted-gateway", "delete_requires_base_rev");
  });
});
