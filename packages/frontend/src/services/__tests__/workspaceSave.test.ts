import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  signal: vi.fn(),
}));

vi.mock("../runtimeController/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimeController/core")>()),
  runtimeControllerEnabled: true,
  normalizeOriginEndpointForClient: (value: string) => value,
}));
vi.mock("../runtimeController/origins", () => ({
  requestOriginAccessToken: mocks.token,
  fetchOriginSummary: vi.fn(),
}));
vi.mock("../runtimeController/workspaceLeases", () => ({
  acquireWorkspaceLease: mocks.acquire,
  releaseWorkspaceLease: mocks.release,
}));
vi.mock("../runtimeController/workspaceVersioningCache", () => ({ noteVersioningSignal: mocks.signal }));

import { ControllerApiError } from "../runtimeController/core";
import { instafyClientHeaderValue } from "../runtimeController/originRequest";
import { defaultWorkspaceSaveMessage, saveWorkspaceChanges } from "../runtimeController/workspaceSave";

const GATEWAY = "https://controller.test/origin/gateway";
const DESKTOP = "https://controller.test/origin/desk";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenFor(originId: string, endpoint: string, mode: string) {
  return { originId, endpoint, mode, token: `${originId}-token`, expiresIn: 60, scopes: ["fs.write"], leaseId: null };
}

function calls() {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url: String(url), init: (init ?? {}) as RequestInit }));
}

async function manifestOf(init: RequestInit): Promise<Record<string, unknown>> {
  const blob = (init.body as FormData).get("manifest") as Blob;
  return JSON.parse(await blob.text()) as Record<string, unknown>;
}

function leaseConflict() {
  return new ControllerApiError({
    status: 409,
    message: "project currently leased by 0f8b2c1e-1111-4222-8333-444455556666 until 2026-10-04T10:00:00Z",
    code: null,
    details: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquire.mockResolvedValue({ leaseId: "lease-1" });
  mocks.release.mockResolvedValue(undefined);
  mocks.token.mockResolvedValue(tokenFor("gateway", GATEWAY, "hosted"));
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("saveWorkspaceChanges", () => {
  it("stateless gateway: one apply with baseRev and expected; committed:true ends the save", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { rev: "r2", baseRev: "r1", committed: true, fileCount: 1, bytesWritten: 5 }));

    const result = await saveWorkspaceChanges({
      projectId: "p",
      originId: "gateway",
      files: [{ path: "README.md", content: "hello" }],
      baseRev: "r1",
      expected: { "README.md": "oid-1" },
    });

    expect(calls()).toHaveLength(1);
    const [apply] = calls();
    expect(apply.url).toBe(`${GATEWAY}/apply`);
    expect(apply.init.headers).toEqual({ authorization: "Bearer gateway-token", "x-instafy-client": instafyClientHeaderValue() });
    const manifest = await manifestOf(apply.init);
    expect(manifest).toMatchObject({ leaseId: "lease-1", baseRev: "r1", expected: { "README.md": "oid-1" } });
    expect(manifest).not.toHaveProperty("idempotencyKey");
    expect(manifest).not.toHaveProperty("commitMessage");
    expect(mocks.token.mock.calls[0][0]).toMatchObject({ originId: "gateway", scopes: ["fs.write"], leaseId: "lease-1" });
    expect(mocks.token.mock.calls[0][0]).not.toHaveProperty("preferHosted");
    expect(mocks.token.mock.calls[0][0]).not.toHaveProperty("preferRuntime");
    expect(result).toEqual({
      ok: true,
      originId: "gateway",
      originMode: "hosted",
      rev: "r2",
      baseRev: "r1",
      committed: true,
      saved: ["README.md"],
      conflicted: [],
      rejected: [],
      recoveryRef: null,
      via: "apply",
      report: null,
    });
    expect(mocks.signal).toHaveBeenCalledWith("gateway", "committed");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("Desktop origin: apply with expected, then /git/sync on the same origin, token and lease", async () => {
    mocks.token.mockResolvedValue(tokenFor("desk", DESKTOP, "desktop"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(200, { rev: "local-1", baseRev: "local-0", fileCount: 2, bytesWritten: 9 }))
      .mockResolvedValueOnce(
        json(200, {
          rev: "main-2",
          baseRev: "main-1",
          localRev: "local-2",
          gitSyncStatus: "partial",
          recoveryRef: "refs/instafy/recovery/desk/save-1",
          recoveryRefs: [],
          conflictedPaths: ["b.md"],
          rejectedPaths: [{ path: ".env", reason: "secret", keptSavedVersion: false }],
          checkoutMoved: true,
          unpushedRefs: 0,
        }),
      );

    const result = await saveWorkspaceChanges({
      projectId: "p",
      originId: "desk",
      files: [
        { path: "a.md", content: "a" },
        { path: "b.md", content: "b" },
        { path: ".env", content: "KEY=1" },
      ],
      expected: { "a.md": "oid-a", "b.md": null },
    });

    const [apply, sync] = calls();
    const manifest = await manifestOf(apply.init);
    expect(manifest).not.toHaveProperty("baseRev");
    expect(manifest.expected).toEqual({ "a.md": "oid-a", "b.md": null });
    expect(sync.url).toBe(`${DESKTOP}/git/sync`);
    expect(sync.init.method).toBe("POST");
    expect(JSON.parse(String(sync.init.body))).toEqual({ paths: ["a.md", "b.md", ".env"], message: "Update 3 files" });
    expect(sync.init.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer desk-token",
      "x-instafy-client": instafyClientHeaderValue(),
    });
    expect(mocks.acquire).toHaveBeenCalledOnce();
    expect(mocks.token).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      originId: "desk",
      originMode: "desktop",
      rev: "main-2",
      baseRev: "main-1",
      committed: true,
      saved: ["a.md"],
      conflicted: ["b.md"],
      rejected: [{ path: ".env", reason: "secret", keptSavedVersion: false }],
      recoveryRef: "refs/instafy/recovery/desk/save-1",
      via: "sync",
    });
    expect(mocks.signal).not.toHaveBeenCalled();
  });

  it("stateful gateway (rollback case): apply without committed, then sync with the message", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(200, { rev: "local", baseRev: "base" }))
      .mockResolvedValueOnce(json(200, { rev: "pushed", baseRev: "base" }));
    const result = await saveWorkspaceChanges({
      projectId: "p",
      files: [{ path: "src/a.ts", content: "x" }],
      syncMessage: "Save src/a.ts",
    });
    expect(JSON.parse(String(calls()[1].init.body))).toEqual({ paths: ["src/a.ts"], message: "Save src/a.ts" });
    expect(mocks.token.mock.calls[0][0]).toMatchObject({ originId: null });
    expect(result).toMatchObject({ ok: true, rev: "pushed", committed: null, via: "sync", saved: ["src/a.ts"], report: null });
  });

  it("follows D4 for committed:false: the sync still runs and reports nothing new", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(200, { rev: "m", baseRev: "m", committed: false }))
      .mockResolvedValueOnce(json(200, { rev: "m", baseRev: "m", committed: false }));
    const result = await saveWorkspaceChanges({ projectId: "p", originId: "gateway", files: [{ path: "a", content: "same" }], baseRev: "m" });
    expect(calls().map((call) => call.url)).toEqual([`${GATEWAY}/apply`, `${GATEWAY}/git/sync`]);
    expect(result).toMatchObject({ ok: true, committed: false, via: "sync" });
  });

  it("directory deletes carry baseRev and the default message", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { rev: "r2", baseRev: "r1", committed: true }));
    await saveWorkspaceChanges({ projectId: "p", originId: "gateway", deletes: ["docs/"], baseRev: "r1" });
    const manifest = await manifestOf(calls()[0].init);
    expect(manifest).toMatchObject({ deletes: ["docs"], baseRev: "r1", files: [] });
  });

  it("returns head_moved with head and paths and keeps going no further", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(409, { error: "moved", code: "head_moved", head: "e9", paths: ["README.md"] }));
    const result = await saveWorkspaceChanges({ projectId: "p", originId: "gateway", files: [{ path: "README.md", content: "x" }], baseRev: "r1" });
    expect(calls()).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      stage: "apply",
      applied: false,
      originId: "gateway",
      error: { status: 409, code: "head_moved", head: "e9", paths: ["README.md"] },
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["excluded_path", "secret"],
    ["excluded_path", undefined],
    ["ignored_path", undefined],
    ["policy_rejected", "too_large"],
  ])("returns 422 %s (reason %s)", async (code, reason) => {
    vi.mocked(fetch).mockResolvedValueOnce(json(422, { error: "refused", code, paths: ["x"], ...(reason ? { reason } : {}) }));
    const result = await saveWorkspaceChanges({ projectId: "p", files: [{ path: "x", content: "" }] });
    expect(result).toMatchObject({ ok: false, stage: "apply", error: { status: 422, code, paths: ["x"] } });
    if (!result.ok) {
      expect(result.error.reason).toBe(reason);
    }
  });

  it("retries a lease held by the agent once, then maps it without the holder id", async () => {
    vi.useFakeTimers();
    mocks.acquire.mockRejectedValue(leaseConflict());
    const pending = saveWorkspaceChanges({ projectId: "p", files: [{ path: "a", content: "a" }] });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, stage: "lease", error: { status: 409, code: "lease_conflict" } });
    expect(JSON.stringify(result)).not.toContain("0f8b2c1e");
  });

  it("succeeds when the retried lease is granted", async () => {
    mocks.acquire.mockRejectedValueOnce(leaseConflict()).mockResolvedValueOnce({ leaseId: "lease-2" });
    vi.mocked(fetch).mockResolvedValueOnce(json(200, { rev: "r", committed: true }));
    const result = await saveWorkspaceChanges({ projectId: "p", files: [{ path: "a", content: "a" }], leaseConflictRetryDelayMs: 1 });
    expect(result.ok).toBe(true);
    expect(await manifestOf(calls()[0].init)).toMatchObject({ leaseId: "lease-2" });
  });

  it("reports a missing sync route after the apply landed", async () => {
    mocks.token.mockResolvedValue(tokenFor("desk", DESKTOP, "desktop"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(200, { rev: "local-1" }))
      .mockResolvedValueOnce(json(404, { message: "origin path not found" }));
    const result = await saveWorkspaceChanges({ projectId: "p", files: [{ path: "a", content: "a" }] });
    expect(result).toMatchObject({
      ok: false,
      stage: "sync",
      applied: true,
      appliedRev: "local-1",
      error: { status: 404, routeUnavailable: true },
    });
  });

  it("reports a missing apply route without a sync", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 404 }));
    const result = await saveWorkspaceChanges({ projectId: "p", files: [{ path: "a", content: "a" }] });
    expect(calls()).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, stage: "apply", applied: false, error: { routeUnavailable: true } });
  });

  it("reports a token the controller would not mint (404 at /access_token)", async () => {
    mocks.token.mockResolvedValue(null);
    const result = await saveWorkspaceChanges({ projectId: "p", originId: "gone", files: [{ path: "a", content: "a" }] });
    expect(result).toMatchObject({ ok: false, stage: "token", error: { code: "token_unavailable" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("Desktop not_saved keeps the report so the copy can point at Unsaved work", async () => {
    mocks.token.mockResolvedValue(tokenFor("desk", DESKTOP, "desktop"));
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(200, { rev: "local-1" }))
      .mockResolvedValueOnce(
        json(409, {
          error: "Not saved: push rejected",
          code: "not_saved",
          gitSyncStatus: "unpublished",
          recoveryRef: "refs/instafy/recovery/desk/n",
          failure: "push rejected",
          conflictedPaths: [],
          rejectedPaths: [],
        }),
      );
    const result = await saveWorkspaceChanges({ projectId: "p", files: [{ path: "a", content: "a" }] });
    expect(result).toMatchObject({
      ok: false,
      stage: "sync",
      applied: true,
      error: { code: "not_saved", report: { recoveryRef: "refs/instafy/recovery/desk/n", failure: "push rejected" } },
    });
  });

  it("refuses an empty save without any request", async () => {
    const result = await saveWorkspaceChanges({ projectId: "p", files: [], deletes: [] });
    expect(result).toMatchObject({ ok: false, stage: "input", error: { code: "invalid_request" } });
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("defaultWorkspaceSaveMessage", () => {
  it("mirrors the gateway's default subjects", () => {
    expect(defaultWorkspaceSaveMessage({ files: ["a.md"], deletes: [] })).toBe("Update a.md");
    expect(defaultWorkspaceSaveMessage({ files: [], deletes: ["b.md"] })).toBe("Delete b.md");
    expect(defaultWorkspaceSaveMessage({ files: ["a"], deletes: ["b"] })).toBe("Update 2 files");
  });
});
