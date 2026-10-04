import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  platform: vi.fn(() => "web"),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: mocks.platform } }));
vi.mock("../../config/buildInfo", () => ({
  instafyBuildInfo: { gitCommitShort: "abc1234", packageVersion: "1.2.3" },
}));
vi.mock("../runtimeController/origins", () => ({ requestOriginAccessToken: mocks.token }));
vi.mock("../runtimeController/workspaceLeases", () => ({
  acquireWorkspaceLease: mocks.acquire,
  releaseWorkspaceLease: mocks.release,
}));

import { ControllerApiError } from "../runtimeController/core";
import {
  instafyClientHeaderValue,
  originHeaders,
  resetInstafyClientHeaderValueForTests,
  withWorkspaceWriteLease,
} from "../runtimeController/originRequest";

function originToken(overrides: Record<string, unknown> = {}) {
  return {
    originId: "origin-1",
    endpoint: "https://controller.test/origin/origin-1",
    mode: "hosted",
    token: "write-token",
    expiresIn: 60,
    scopes: ["fs.write"],
    leaseId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetInstafyClientHeaderValueForTests();
  mocks.platform.mockReturnValue("web");
  mocks.acquire.mockResolvedValue({ leaseId: "lease-1" });
  mocks.release.mockResolvedValue(undefined);
  mocks.token.mockResolvedValue(originToken());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("X-Instafy-Client", () => {
  it("names the web build by its short commit", () => {
    expect(instafyClientHeaderValue()).toBe("web/abc1234");
  });

  it("names the Desktop shell and native platforms", () => {
    vi.stubGlobal("window", { instafyDesktop: {} });
    expect(instafyClientHeaderValue()).toBe("desktop/abc1234");
    vi.unstubAllGlobals();
    resetInstafyClientHeaderValueForTests();
    mocks.platform.mockReturnValue("ios");
    expect(instafyClientHeaderValue()).toBe("ios/abc1234");
  });

  it("adds the header next to the bearer token", () => {
    expect(originHeaders("t", { accept: "application/json" })).toEqual({
      authorization: "Bearer t",
      accept: "application/json",
      "x-instafy-client": "web/abc1234",
    });
  });
});

describe("withWorkspaceWriteLease", () => {
  it("acquires a lease, mints one write token pinned to the origin, runs, and releases", async () => {
    const result = await withWorkspaceWriteLease(
      { projectId: "project-1", originId: "origin-1" },
      async (context) => {
        const response = await context.fetch("git/sync", { method: "POST", headers: { accept: "application/json" } });
        return { status: response.status, leaseId: context.leaseId, originMode: context.originMode };
      },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { status: 200, leaseId: "lease-1", originMode: "hosted" },
      originId: "origin-1",
    });
    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", metadata: null }),
    );
    expect(mocks.token).toHaveBeenCalledTimes(1);
    const mint = mocks.token.mock.calls[0][0];
    expect(mint).toMatchObject({ projectId: "project-1", protocol: "http", scopes: ["fs.write"], originId: "origin-1", leaseId: "lease-1" });
    expect(mint).not.toHaveProperty("preferHosted");
    expect(mint).not.toHaveProperty("preferRuntime");
    expect(mocks.acquire.mock.invocationCallOrder[0]).toBeLessThan(mocks.token.mock.invocationCallOrder[0]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://controller.test/origin/origin-1/git/sync");
    expect(init?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer write-token",
      "x-instafy-client": "web/abc1234",
    });
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", leaseId: "lease-1" }));
  });

  it("forwards preferHosted for legacy routing", async () => {
    await withWorkspaceWriteLease({ projectId: "p", preferHosted: true }, async () => null);
    expect(mocks.token.mock.calls[0][0]).toMatchObject({ preferHosted: true, originId: null });
  });

  it("uses a caller-held lease and never releases it", async () => {
    await withWorkspaceWriteLease({ projectId: "p", leaseId: "held" }, async () => null);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.token.mock.calls[0][0]).toMatchObject({ leaseId: "held" });
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("maps a lease held by someone else to lease_conflict without the holder id", async () => {
    mocks.acquire.mockRejectedValue(
      new ControllerApiError({
        status: 409,
        message: "project currently leased by 0f8b2c1e-1111-4222-8333-444455556666 until 2026-10-04T10:00:00Z",
        code: null,
        details: null,
      }),
    );
    const run = vi.fn();
    const result = await withWorkspaceWriteLease({ projectId: "p" }, run);
    expect(result).toMatchObject({ ok: false, stage: "lease", error: { status: 409, code: "lease_conflict" } });
    expect(JSON.stringify(result)).not.toContain("0f8b2c1e");
    expect(run).not.toHaveBeenCalled();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("retries a refused lease once after the delay", async () => {
    vi.useFakeTimers();
    mocks.acquire
      .mockRejectedValueOnce(new Error("project currently leased by someone until later"))
      .mockResolvedValueOnce({ leaseId: "lease-2" });
    const pending = withWorkspaceWriteLease(
      { projectId: "p", leaseConflictRetryDelayMs: 1500 },
      async (context) => context.leaseId,
    );
    await vi.advanceTimersByTimeAsync(1499);
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, value: "lease-2" });
  });

  it("reports other lease failures as lease_failed", async () => {
    mocks.acquire.mockRejectedValue(new ControllerApiError({ status: 500, message: "db down", code: null, details: null }));
    const result = await withWorkspaceWriteLease({ projectId: "p", leaseConflictRetryDelayMs: 1 }, async () => null);
    expect(result).toMatchObject({ ok: false, stage: "lease", error: { status: 500, code: "lease_failed", message: "db down" } });
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
  });

  it("reports a failed mint and still releases the lease", async () => {
    mocks.token.mockResolvedValue(null);
    const result = await withWorkspaceWriteLease({ projectId: "p" }, async () => null);
    expect(result).toMatchObject({ ok: false, stage: "token", error: { code: "token_unavailable" } });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("maps a request that throws and releases the lease", async () => {
    const result = await withWorkspaceWriteLease({ projectId: "p" }, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toMatchObject({ ok: false, stage: "request", error: { code: "network_error" }, originId: "origin-1" });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("re-mints once on 401 for the same origin and lease", async () => {
    mocks.token
      .mockResolvedValueOnce(originToken({ token: "stale" }))
      .mockResolvedValueOnce(originToken({ token: "fresh" }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await withWorkspaceWriteLease({ projectId: "p" }, async (context) => (await context.fetch("apply")).status);
    expect(result).toMatchObject({ ok: true, value: 200 });
    expect(mocks.token.mock.calls[1][0]).toMatchObject({ originId: "origin-1", leaseId: "lease-1", forceRefresh: true });
    expect((vi.mocked(fetch).mock.calls[1][1]?.headers as Record<string, string>).authorization).toBe("Bearer fresh");
  });

  it("never follows a re-mint to a different origin", async () => {
    mocks.token
      .mockResolvedValueOnce(originToken())
      .mockResolvedValueOnce(originToken({ originId: "origin-2", token: "other" }));
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 401 }));
    const result = await withWorkspaceWriteLease({ projectId: "p" }, async (context) => (await context.fetch("apply")).status);
    expect(result).toMatchObject({ ok: true, value: 401, originId: "origin-1" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
