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
vi.mock("../runtimeController/origins", () => ({ requestOriginAccessToken: mocks.token }));
vi.mock("../runtimeController/workspaceLeases", () => ({
  acquireWorkspaceLease: mocks.acquire,
  releaseWorkspaceLease: mocks.release,
}));
vi.mock("../runtimeController/workspaceVersioningCache", () => ({ noteVersioningSignal: mocks.signal }));

import { ControllerApiError } from "../runtimeController/core";
import { instafyClientHeaderValue } from "../runtimeController/originRequest";
import {
  dismissWorkspaceRecoveryFromController,
  fetchWorkspaceGitDiffFromController,
  fetchWorkspaceGitHistoryFromController,
  fetchWorkspaceGitHistoryReviewFromController,
  fetchWorkspaceGitStatusFromController,
  fetchWorkspaceRecoveryFromController,
  REVERT_ROUTE_UNAVAILABLE_MESSAGE,
  restoreWorkspaceRecoveryFromController,
  revertWorkspaceGitCommitFromController,
  revertWorkspaceGitPathsFromController,
  syncWorkspaceGitToRemoteFromController,
} from "../runtimeController/workspaceGit";

const ENDPOINT = "https://controller.test/origin/gateway";

function token(overrides: Record<string, unknown> = {}) {
  return {
    originId: "gateway",
    endpoint: ENDPOINT,
    mode: "hosted",
    token: "origin-token",
    expiresIn: 60,
    scopes: ["fs.read"],
    leaseId: null,
    ...overrides,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fetchMock() {
  return vi.mocked(fetch);
}

function lastRequest() {
  const calls = fetchMock().mock.calls;
  const [url, init] = calls[calls.length - 1];
  return { url: String(url), init: init ?? {} };
}

function readHeaders() {
  return {
    authorization: "Bearer origin-token",
    accept: "application/json",
    "x-instafy-client": instafyClientHeaderValue(),
  };
}

function writeHeaders() {
  return {
    authorization: "Bearer origin-token",
    "content-type": "application/json",
    accept: "application/json",
    "x-instafy-client": instafyClientHeaderValue(),
  };
}

function historyEntry(index: number, extra: Record<string, unknown> = {}) {
  return {
    commit: `c${index}`.padEnd(40, "0"),
    shortCommit: `c${index}`,
    committedAt: "2026-10-04T10:00:00Z",
    authorName: "Ada",
    authorEmail: "ada@users.noreply.instafy.dev",
    subject: `Update file ${index}`,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.mockResolvedValue(token());
  mocks.acquire.mockResolvedValue({ leaseId: "lease-1" });
  mocks.release.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => json(200, {})));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("legacy requests are unchanged apart from X-Instafy-Client", () => {
  it("status", async () => {
    fetchMock().mockResolvedValue(json(200, { supported: true, dirtyCount: 0, dirtyPaths: [] }));
    const status = await fetchWorkspaceGitStatusFromController({ projectId: "p", limit: 5 });
    expect(mocks.token.mock.calls[0][0]).toEqual({
      projectId: "p",
      protocol: "http",
      scopes: ["fs.read"],
      preferHosted: true,
      originId: null,
      accessToken: null,
      forceRefresh: false,
    });
    const { url, init } = lastRequest();
    expect(url).toBe(`${ENDPOINT}/git/status?limit=5`);
    expect(init.headers).toEqual(readHeaders());
    expect(init.cache).toBe("no-store");
    expect(status?.stateless).toBe(false);
    expect(mocks.signal).not.toHaveBeenCalled();
  });

  it("history keeps the 12-entry clamp and sends no skip", async () => {
    fetchMock().mockResolvedValue(json(200, { supported: true, entries: [historyEntry(1)] }));
    const history = await fetchWorkspaceGitHistoryFromController({ projectId: "p", limit: 20 });
    expect(mocks.token.mock.calls[0][0]).toMatchObject({ preferHosted: true });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/history?limit=12`);
    expect(lastRequest().init.headers).toEqual(readHeaders());
    expect(history?.entries[0]).toEqual({
      commit: historyEntry(1).commit,
      shortCommit: "c1",
      committedAt: "2026-10-04T10:00:00Z",
      authorName: "Ada",
      authorEmail: "ada@users.noreply.instafy.dev",
      subject: "Update file 1",
      resolvedBy: null,
    });
    expect(history?.hasMore).toBe(false);
  });

  it("diff and review", async () => {
    fetchMock().mockResolvedValue(json(200, { supported: true, diff: "", entries: [] }));
    await fetchWorkspaceGitDiffFromController({ projectId: "p", path: "a.md", commit: "c", base: "b" });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/diff?path=a.md&commit=c&base=b`);
    expect(lastRequest().init.headers).toEqual(readHeaders());
    await fetchWorkspaceGitHistoryReviewFromController({ projectId: "p", commit: "c" });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/history/review?commit=c`);
    expect(mocks.token.mock.calls[1][0]).toEqual({
      projectId: "p",
      protocol: "http",
      scopes: ["fs.read"],
      preferHosted: true,
      originId: null,
      accessToken: null,
    });
  });

  it("sync sends the default message and keeps the error text", async () => {
    fetchMock().mockResolvedValue(json(409, { error: "conflict", code: "not_saved", gitSyncStatus: "unpublished", recoveryRef: "refs/instafy/recovery/o/n" }));
    const result = await syncWorkspaceGitToRemoteFromController({ projectId: "p", paths: ["a.md"] });
    expect(mocks.token.mock.calls[0][0]).toEqual({
      projectId: "p",
      protocol: "http",
      scopes: ["fs.write"],
      preferHosted: true,
      originId: null,
      leaseId: "lease-1",
      accessToken: null,
      forceRefresh: false,
    });
    const { url, init } = lastRequest();
    expect(url).toBe(`${ENDPOINT}/git/sync`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ message: "instafy: sync", paths: ["a.md"] }));
    expect(init.headers).toEqual(writeHeaders());
    expect(result).toMatchObject({ ok: false, conflict: true });
    expect(result?.error).toMatch(/^origin git sync failed \(409\): /);
    expect(result?.errorInfo).toMatchObject({ code: "not_saved" });
    expect(result?.report?.recoveryRef).toBe("refs/instafy/recovery/o/n");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("path revert", async () => {
    fetchMock().mockResolvedValue(json(200, { reverted: ["a"], removed: [] }));
    await revertWorkspaceGitPathsFromController({ projectId: "p", paths: ["a"] });
    expect(mocks.token.mock.calls[0][0]).toMatchObject({ preferHosted: true, leaseId: "lease-1" });
    expect(lastRequest().init.body).toBe(JSON.stringify({ paths: ["a"] }));
    expect(lastRequest().init.headers).toEqual(writeHeaders());
  });
});

describe("default routing", () => {
  it("status pins the origin, omits preferHosted and reports stateless", async () => {
    fetchMock().mockResolvedValue(json(200, { supported: true, dirtyCount: 0, dirtyPaths: [], stateless: true }));
    const status = await fetchWorkspaceGitStatusFromController({ projectId: "p", originId: "gateway", limit: 1, routing: "default" });
    const mint = mocks.token.mock.calls[0][0];
    expect(mint).toMatchObject({ originId: "gateway" });
    expect(mint).not.toHaveProperty("preferHosted");
    expect(status?.stateless).toBe(true);
    expect(mocks.signal).toHaveBeenCalledWith("gateway", "stateless");
  });

  it("history pages with skip, allows 50 and parses firstParent, actor and hasMore", async () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      historyEntry(index, index === 0 ? { firstParent: "p0", actor: "service" } : index === 1 ? { first_parent: "p1", actor: "robot" } : {}),
    );
    fetchMock().mockResolvedValue(json(200, { supported: true, entries }));
    const history = await fetchWorkspaceGitHistoryFromController({ projectId: "p", limit: 20, skip: 20, routing: "default" });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/history?limit=20&skip=20`);
    expect(history?.entries[0]).toMatchObject({ firstParent: "p0", actor: "service" });
    expect(history?.entries[1]).toMatchObject({ firstParent: "p1" });
    expect(history?.entries[1]).not.toHaveProperty("actor");
    expect(history?.entries[2]).not.toHaveProperty("firstParent");
    expect(history?.hasMore).toBe(true);

    await fetchWorkspaceGitHistoryFromController({ projectId: "p", limit: 80, routing: "default" });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/history?limit=50`);
  });

  it("history prefers the origin's hasMore", async () => {
    fetchMock().mockResolvedValue(json(200, { supported: true, entries: [historyEntry(1)], hasMore: false }));
    expect((await fetchWorkspaceGitHistoryFromController({ projectId: "p", limit: 1, routing: "default" }))?.hasMore).toBe(false);
    fetchMock().mockResolvedValue(json(200, { supported: true, entries: [historyEntry(1)], has_more: true }));
    expect((await fetchWorkspaceGitHistoryFromController({ projectId: "p", limit: 20, routing: "default" }))?.hasMore).toBe(true);
  });

  it("diff and review read from a recovery ref", async () => {
    fetchMock().mockResolvedValue(json(200, { supported: true, diff: "", entries: [] }));
    await fetchWorkspaceGitDiffFromController({ projectId: "p", path: "a", base: "b", commit: "c", ref: "refs/instafy/recovery/o/n", routing: "default" });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/diff?path=a&commit=c&base=b&ref=refs%2Finstafy%2Frecovery%2Fo%2Fn`);
    await fetchWorkspaceGitHistoryReviewFromController({ projectId: "p", commit: "c", ref: "refs/instafy/salvage/gateway/x", routing: "default" });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/history/review?commit=c&ref=refs%2Finstafy%2Fsalvage%2Fgateway%2Fx`);
    expect(mocks.token.mock.calls[1][0]).not.toHaveProperty("preferHosted");
  });

  it("sync omits the legacy message and parses a Desktop publish report", async () => {
    fetchMock().mockResolvedValue(
      json(200, {
        rev: "p",
        baseRev: "r",
        gitSyncStatus: "partial",
        conflictedPaths: ["b.md"],
        rejectedPaths: [{ path: ".env", reason: "secret", keptSavedVersion: false }],
        recoveryRef: "refs/instafy/recovery/o/n",
        recoveryRefs: [],
        checkoutMoved: true,
        unpushedRefs: 0,
      }),
    );
    const result = await syncWorkspaceGitToRemoteFromController({ projectId: "p", originId: "desk", routing: "default" });
    expect(lastRequest().init.body).toBe("{}");
    expect(mocks.token.mock.calls[0][0]).not.toHaveProperty("preferHosted");
    expect(result).toMatchObject({ ok: true, rev: "p", baseRev: "r" });
    expect(result?.report).toMatchObject({ gitSyncStatus: "partial", conflictedPaths: ["b.md"], recoveryRef: "refs/instafy/recovery/o/n" });
  });

  it("sync reads the stateless answer", async () => {
    fetchMock().mockResolvedValue(json(200, { rev: "m", baseRev: "m", committed: false }));
    const result = await syncWorkspaceGitToRemoteFromController({ projectId: "p", paths: ["a"], message: "Update a", routing: "default" });
    expect(lastRequest().init.body).toBe(JSON.stringify({ message: "Update a", paths: ["a"] }));
    expect(result).toMatchObject({ ok: true, committed: false });
    expect(result?.report).toBeUndefined();
  });

  it("a stateless path discard refusal is a versioning signal", async () => {
    fetchMock().mockResolvedValue(json(400, { error: "discarding changes is not available on a cloud space", code: "not_supported" }));
    const result = await revertWorkspaceGitPathsFromController({ projectId: "p", paths: ["a"] });
    expect(result?.errorInfo?.code).toBe("not_supported");
    expect(mocks.signal).toHaveBeenCalledWith("gateway", "not_supported");
  });
});

describe("revertWorkspaceGitCommitFromController", () => {
  it.each([undefined, "legacy"] as const)(
    "legacy mode (routing %s) never issues a revert-commit request",
    async (routing) => {
      fetchMock().mockResolvedValue(json(200, { rev: "new" }));
      const result = await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", base: "parent", routing });
      expect(fetch).not.toHaveBeenCalled();
      expect(mocks.acquire).not.toHaveBeenCalled();
      expect(mocks.token).not.toHaveBeenCalled();
      expect(mocks.release).not.toHaveBeenCalled();
      // The same failure the legacy drawer has always shown.
      expect(result).toMatchObject({
        ok: false,
        conflict: false,
        routeUnavailable: true,
        code: "not_supported",
        error: "failed to obtain origin token",
      });
    },
  );

  it("acquires a lease before minting and sends X-Instafy-Client (default routing)", async () => {
    fetchMock().mockResolvedValue(json(200, { rev: "new" }));
    const result = await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", originId: "gateway", routing: "default" });
    expect(mocks.acquire).toHaveBeenCalledWith({ projectId: "p", runtimeId: null, leaseSeconds: undefined, metadata: null, accessToken: null });
    expect(mocks.acquire.mock.invocationCallOrder[0]).toBeLessThan(mocks.token.mock.invocationCallOrder[0]);
    expect(mocks.token.mock.calls[0][0]).toEqual({
      projectId: "p",
      protocol: "http",
      scopes: ["fs.write"],
      originId: "gateway",
      leaseId: "lease-1",
      accessToken: null,
    });
    const { url, init } = lastRequest();
    expect(url).toBe(`${ENDPOINT}/git/revert-commit`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ commit: "abc" }));
    expect(init.headers).toEqual(writeHeaders());
    expect((init.headers as Record<string, string>)["x-instafy-client"]).toBe(instafyClientHeaderValue());
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p", leaseId: "lease-1" }));
    expect(result).toMatchObject({ ok: true, rev: "new", conflict: false });
    expect(result).not.toHaveProperty("committed");
  });

  it("sends base on default routing and reads committed", async () => {
    fetchMock().mockResolvedValue(json(200, { rev: "r2", baseRev: "r1", committed: true }));
    const result = await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", base: "parent", originId: "gateway", routing: "default" });
    expect(lastRequest().init.body).toBe(JSON.stringify({ commit: "abc", base: "parent" }));
    expect(mocks.token.mock.calls[0][0]).not.toHaveProperty("preferHosted");
    expect(result).toMatchObject({ ok: true, rev: "r2", baseRev: "r1", committed: true });
    expect(mocks.signal).toHaveBeenCalledWith("gateway", "committed");
  });

  it("reads committed:false and a Desktop report with nothing to publish", async () => {
    fetchMock().mockResolvedValue(json(200, { rev: "m", baseRev: "m", committed: false }));
    expect(await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", routing: "default" })).toMatchObject({ committed: false });
    fetchMock().mockResolvedValue(json(200, { rev: "m", baseRev: "m", gitSyncStatus: "unchanged", conflictedPaths: [], rejectedPaths: [] }));
    const desktop = await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", routing: "default" });
    expect(desktop).toMatchObject({ ok: true, committed: false });
    expect(desktop?.report?.gitSyncStatus).toBe("unchanged");
  });

  it("maps revert conflicts, merge refusals and dirty paths", async () => {
    fetchMock().mockResolvedValue(json(409, { error: "conflict", code: "revert_conflict", paths: ["a.ts"] }));
    expect(await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", routing: "default" })).toMatchObject({
      ok: false,
      conflict: true,
      code: "revert_conflict",
      paths: ["a.ts"],
      routeUnavailable: false,
    });
    fetchMock().mockResolvedValue(json(400, { error: "a merge commit needs a base" }));
    expect(await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", routing: "default" })).toMatchObject({
      ok: false,
      conflict: false,
      errorInfo: { status: 400 },
    });
    fetchMock().mockResolvedValue(json(409, { error: "dirty", code: "dirty_paths", paths: ["b.ts"] }));
    expect(await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", routing: "default" })).toMatchObject({ code: "dirty_paths", paths: ["b.ts"] });
  });

  it("treats the controller's unknown-route 404 as not available", async () => {
    fetchMock().mockResolvedValue(json(404, { message: "origin path not found" }));
    const result = await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", routing: "default" });
    expect(result).toMatchObject({ ok: false, routeUnavailable: true, conflict: false, error: REVERT_ROUTE_UNAVAILABLE_MESSAGE });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("reports a lease held by the agent without a conflict flag", async () => {
    mocks.acquire.mockRejectedValue(
      new ControllerApiError({ status: 409, message: "project currently leased by x until y", code: null, details: null }),
    );
    const result = await revertWorkspaceGitCommitFromController({ projectId: "p", commit: "abc", routing: "default" });
    expect(result).toMatchObject({ ok: false, conflict: false, code: "lease_conflict" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("unsaved work (recovery)", () => {
  const listed = [
    {
      ref: "refs/instafy/recovery/11111111-2222-4333-8444-555555555555/turn-1",
      rev: "r1",
      kind: "conflict",
      subject: "Agent work",
      date: "2026-10-04T09:00:00Z",
      origin: "11111111-2222-4333-8444-555555555555",
      paths: ["a.md"],
      base: "b1",
      dismissible: true,
    },
    {
      ref: "refs/instafy/salvage/gateway/project-1",
      rev: "r2",
      kind: "salvage",
      subject: "Archived",
      date: "2026-10-01T09:00:00Z",
      origin: null,
      paths: ["x", { path: "y" }],
      base: "b2",
      dismissible: false,
      restoredRev: "m9",
    },
  ];

  it("lists entries with and without the newer fields, pinned to the origin", async () => {
    fetchMock().mockResolvedValue(json(200, listed));
    const result = await fetchWorkspaceRecoveryFromController({ projectId: "p", originId: "gateway" });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/recovery`);
    expect(lastRequest().init.headers).toEqual(readHeaders());
    const mint = mocks.token.mock.calls[0][0];
    expect(mint).toMatchObject({ originId: "gateway", scopes: ["fs.read"] });
    expect(mint).not.toHaveProperty("preferHosted");
    expect(result?.status).toBe("ok");
    expect(result?.entries[0]).toEqual({ ...listed[0] });
    expect(result?.entries[0]).not.toHaveProperty("restoredRev");
    expect(result?.entries[1]).toMatchObject({ kind: "salvage", paths: ["x", "y"], dismissible: false, restoredRev: "m9" });
    expect(mocks.signal).toHaveBeenCalledWith("gateway", "recovery_supported");
  });

  it("accepts an {entries} envelope and fills defaults", async () => {
    fetchMock().mockResolvedValue(json(200, { entries: [{ ref: "refs/instafy/salvage/gateway/x", rev: "r" }, { rev: "missing-ref" }] }));
    const result = await fetchWorkspaceRecoveryFromController({ projectId: "p" });
    expect(result?.entries).toEqual([
      { ref: "refs/instafy/salvage/gateway/x", rev: "r", kind: "salvage", subject: "", date: null, origin: null, paths: [], base: null, dismissible: false },
    ]);
  });

  it("treats 404 as unsupported, never as an error", async () => {
    fetchMock().mockResolvedValue(json(404, { message: "origin path not found" }));
    expect(await fetchWorkspaceRecoveryFromController({ projectId: "p" })).toEqual({
      status: "unsupported",
      entries: [],
      originId: "gateway",
      originMode: "hosted",
    });
    expect(mocks.signal).toHaveBeenCalledWith("gateway", "recovery_unsupported");
    fetchMock().mockResolvedValue(new Response("", { status: 404 }));
    expect((await fetchWorkspaceRecoveryFromController({ projectId: "p" }))?.status).toBe("unsupported");
  });

  it("reports a 502 as an error the section can show", async () => {
    fetchMock().mockResolvedValue(json(502, { error: "canonical unreachable", code: "canonical_unreachable" }));
    const result = await fetchWorkspaceRecoveryFromController({ projectId: "p" });
    expect(result).toMatchObject({ status: "error", error: { status: 502, code: "canonical_unreachable" } });
    expect(mocks.signal).not.toHaveBeenCalled();
  });

  it("restores with rev, baseRev and a deduplicated keep list under a lease", async () => {
    fetchMock().mockResolvedValue(json(200, { rev: "m2", baseRev: "m1", committed: true, notRestored: [".env"], refDeleted: true }));
    const result = await restoreWorkspaceRecoveryFromController({
      projectId: "p",
      originId: "gateway",
      ref: listed[0].ref,
      rev: "r1",
      baseRev: "m1",
      keep: ["a.md", "a.md", " "],
    });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/recovery/restore`);
    expect(lastRequest().init.body).toBe(JSON.stringify({ ref: listed[0].ref, rev: "r1", baseRev: "m1", keep: ["a.md"] }));
    expect(mocks.token.mock.calls[0][0]).toMatchObject({ scopes: ["fs.write"], leaseId: "lease-1", originId: "gateway" });
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      rev: "m2",
      baseRev: "m1",
      committed: true,
      notRestored: [".env"],
      refDeleted: true,
      originId: "gateway",
      originMode: "hosted",
    });
  });

  it("omits keep when empty and reads an older answer", async () => {
    fetchMock().mockResolvedValue(json(200, { rev: "m2" }));
    const result = await restoreWorkspaceRecoveryFromController({ projectId: "p", ref: "refs/instafy/salvage/gateway/x", keep: [] });
    expect(lastRequest().init.body).toBe(JSON.stringify({ ref: "refs/instafy/salvage/gateway/x" }));
    expect(result).toMatchObject({ ok: true, committed: null, notRestored: [], refDeleted: false });
  });

  it("returns restore conflicts with head and paths", async () => {
    fetchMock().mockResolvedValue(json(409, { error: "conflict", code: "restore_conflict", head: "m3", paths: ["a.md"] }));
    const result = await restoreWorkspaceRecoveryFromController({ projectId: "p", ref: "r", rev: "x" });
    expect(result).toMatchObject({ ok: false, stage: "response", error: { code: "restore_conflict", head: "m3", paths: ["a.md"] } });
    fetchMock().mockResolvedValue(json(404, { message: "origin path not found" }));
    expect(await restoreWorkspaceRecoveryFromController({ projectId: "p", ref: "r" })).toMatchObject({
      ok: false,
      error: { routeUnavailable: true },
    });
  });

  it("dismisses with ref and rev", async () => {
    fetchMock().mockResolvedValue(json(200, { dismissed: true }));
    expect(await dismissWorkspaceRecoveryFromController({ projectId: "p", ref: "r", rev: "x" })).toMatchObject({ ok: true, dismissed: true, missing: false });
    expect(lastRequest().url).toBe(`${ENDPOINT}/git/recovery/dismiss`);
    expect(lastRequest().init.body).toBe(JSON.stringify({ ref: "r", rev: "x" }));
    fetchMock().mockResolvedValue(json(200, { dismissed: false, missing: true }));
    expect(await dismissWorkspaceRecoveryFromController({ projectId: "p", ref: "r", rev: "x" })).toMatchObject({ ok: true, dismissed: false, missing: true });
    fetchMock().mockResolvedValue(json(409, { error: "kept", code: "salvage_ref_kept" }));
    expect(await dismissWorkspaceRecoveryFromController({ projectId: "p", ref: "r", rev: "x" })).toMatchObject({
      ok: false,
      stage: "response",
      error: { code: "salvage_ref_kept" },
    });
  });
});
