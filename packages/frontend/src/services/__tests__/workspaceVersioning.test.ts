import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: vi.fn() }));

vi.mock("../runtimeController/workspaceGit", () => ({
  fetchWorkspaceGitStatusFromController: mocks.status,
}));

import {
  getCachedWorkspaceVersioning,
  noteVersioningSignal,
  probeWorkspaceVersioning,
  readLastVersioningMode,
  resetWorkspaceVersioningProbesForTests,
  subscribeWorkspaceVersioning,
  VERSIONING_STALE_MS,
} from "../runtimeController/workspaceVersioning";
import { resetWorkspaceVersioningCacheForTests } from "../runtimeController/workspaceVersioningCache";

const gateway = { originId: "gateway", mode: "hosted" };

function statusResult(extra: Record<string, unknown> = {}) {
  return { supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [], ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceVersioningCacheForTests();
  resetWorkspaceVersioningProbesForTests();
  mocks.status.mockResolvedValue(statusResult());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probeWorkspaceVersioning", () => {
  it.each(["desktop", "efs", "Desktop"])("a %s origin is desktop without a status call", async (mode) => {
    const result = await probeWorkspaceVersioning({ projectId: "p", origin: { originId: "desk", mode } });
    expect(result).toMatchObject({ mode: "desktop", stateless: false, recovery: "unknown" });
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("a hosted origin that says stateless: true is stateless", async () => {
    mocks.status.mockResolvedValue(statusResult({ stateless: true }));
    const result = await probeWorkspaceVersioning({ projectId: "p", origin: gateway });
    expect(result).toMatchObject({ projectId: "p", originId: "gateway", originMode: "hosted", mode: "stateless", stateless: true, stale: false });
    expect(mocks.status).toHaveBeenCalledWith({
      projectId: "p",
      originId: "gateway",
      limit: 1,
      routing: "default",
      accessToken: null,
    });
  });

  it.each([
    ["no stateless field", statusResult()],
    ["stateless: false", statusResult({ stateless: false })],
    ["404 (supported: false)", { ...statusResult({ supported: false }), error: "git status unavailable" }],
    ["an error answer", statusResult({ error: "Unable to load changes right now. Try Refresh." })],
    ["no answer", null],
  ])("a hosted origin with %s is legacy", async (_label, answer) => {
    mocks.status.mockResolvedValue(answer);
    expect((await probeWorkspaceVersioning({ projectId: "p", origin: gateway }))?.mode).toBe("legacy");
  });

  it("a status call that throws is legacy", async () => {
    mocks.status.mockRejectedValue(new Error("network"));
    expect((await probeWorkspaceVersioning({ projectId: "p", origin: gateway }))?.mode).toBe("legacy");
  });

  it("an unknown origin mode is legacy without a request", async () => {
    expect((await probeWorkspaceVersioning({ projectId: "p", origin: { originId: "o", mode: "unknown" } }))?.mode).toBe("legacy");
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("returns null without a project or an origin", async () => {
    expect(await probeWorkspaceVersioning({ projectId: "p", origin: null })).toBeNull();
    expect(await probeWorkspaceVersioning({ projectId: "", origin: gateway })).toBeNull();
  });

  it("reuses a fresh result, joins a probe on the wire, and probes again when forced or old", async () => {
    vi.useFakeTimers();
    const [first, second] = await Promise.all([
      probeWorkspaceVersioning({ projectId: "p", origin: gateway }),
      probeWorkspaceVersioning({ projectId: "p", origin: gateway }),
    ]);
    expect(first).toBe(second);
    expect(mocks.status).toHaveBeenCalledTimes(1);

    await probeWorkspaceVersioning({ projectId: "p", origin: gateway });
    expect(mocks.status).toHaveBeenCalledTimes(1);

    await probeWorkspaceVersioning({ projectId: "p", origin: gateway, force: true });
    expect(mocks.status).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(VERSIONING_STALE_MS);
    await probeWorkspaceVersioning({ projectId: "p", origin: gateway });
    expect(mocks.status).toHaveBeenCalledTimes(3);
  });

  it("probes again when the origin's mode changes", async () => {
    await probeWorkspaceVersioning({ projectId: "p", origin: { originId: "o", mode: "hosted" } });
    const desktop = await probeWorkspaceVersioning({ projectId: "p", origin: { originId: "o", mode: "desktop" } });
    expect(desktop?.mode).toBe("desktop");
  });

  it("keeps entries per project and origin", async () => {
    mocks.status.mockResolvedValueOnce(statusResult({ stateless: true }));
    await probeWorkspaceVersioning({ projectId: "p1", origin: gateway });
    await probeWorkspaceVersioning({ projectId: "p2", origin: { originId: "desk", mode: "desktop" } });
    expect(getCachedWorkspaceVersioning("p1", "gateway")?.mode).toBe("stateless");
    expect(getCachedWorkspaceVersioning("p2", "desk")?.mode).toBe("desktop");
    expect(getCachedWorkspaceVersioning("p2", "gateway")).toBeNull();
  });

  it("remembers the last mode per project as a first-paint guess", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    mocks.status.mockResolvedValue(statusResult({ stateless: true }));
    await probeWorkspaceVersioning({ projectId: "p", origin: gateway });
    expect(store.get("instafy.versioning.mode.p")).toBe("stateless");
    expect(readLastVersioningMode("p")).toBe("stateless");
    expect(readLastVersioningMode("other")).toBeNull();
  });

  it("tolerates storage that throws", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect((await probeWorkspaceVersioning({ projectId: "p", origin: gateway }))?.mode).toBe("legacy");
    expect(readLastVersioningMode("p")).toBeNull();
  });
});

describe("contradicting responses", () => {
  it.each(["committed", "stateless", "not_supported", "delete_requires_base_rev"] as const)(
    "%s marks a legacy entry stale and the next probe asks again",
    async (signal) => {
      await probeWorkspaceVersioning({ projectId: "p", origin: gateway });
      const listener = vi.fn();
      subscribeWorkspaceVersioning(listener);

      noteVersioningSignal("gateway", signal);

      expect(getCachedWorkspaceVersioning("p", "gateway")?.stale).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      mocks.status.mockResolvedValue(statusResult({ stateless: true }));
      const reprobed = await probeWorkspaceVersioning({ projectId: "p", origin: gateway });
      expect(mocks.status).toHaveBeenCalledTimes(2);
      expect(reprobed).toMatchObject({ mode: "stateless", stale: false });
    },
  );

  it("does not disturb entries the signal agrees with", async () => {
    mocks.status.mockResolvedValue(statusResult({ stateless: true }));
    await probeWorkspaceVersioning({ projectId: "p", origin: gateway });
    await probeWorkspaceVersioning({ projectId: "p", origin: { originId: "desk", mode: "desktop" } });
    const listener = vi.fn();
    subscribeWorkspaceVersioning(listener);
    noteVersioningSignal("gateway", "committed");
    noteVersioningSignal("desk", "committed");
    noteVersioningSignal("someone-else", "stateless");
    noteVersioningSignal(null, "stateless");
    expect(listener).not.toHaveBeenCalled();
    expect(getCachedWorkspaceVersioning("p", "gateway")?.stale).toBe(false);
  });

  it("a legacy-mode save always asks again", async () => {
    mocks.status.mockResolvedValue(statusResult({ stateless: true }));
    await probeWorkspaceVersioning({ projectId: "p", origin: gateway });
    noteVersioningSignal("gateway", "legacy_saved");
    expect(getCachedWorkspaceVersioning("p", "gateway")?.stale).toBe(true);
  });

  it("applies the signal to every project on the same origin", async () => {
    await probeWorkspaceVersioning({ projectId: "p1", origin: gateway });
    await probeWorkspaceVersioning({ projectId: "p2", origin: gateway });
    noteVersioningSignal("gateway", "stateless");
    expect(getCachedWorkspaceVersioning("p1", "gateway")?.stale).toBe(true);
    expect(getCachedWorkspaceVersioning("p2", "gateway")?.stale).toBe(true);
  });
});

describe("recovery support", () => {
  it("is recorded from the recovery list, before or after a probe", async () => {
    noteVersioningSignal("desk", "recovery_unsupported");
    expect((await probeWorkspaceVersioning({ projectId: "p", origin: { originId: "desk", mode: "desktop" } }))?.recovery).toBe("unsupported");

    const listener = vi.fn();
    subscribeWorkspaceVersioning(listener);
    noteVersioningSignal("desk", "recovery_supported");
    expect(getCachedWorkspaceVersioning("p", "desk")).toMatchObject({ recovery: "supported", stale: false });
    expect(listener).toHaveBeenCalledTimes(1);

    const reprobed = await probeWorkspaceVersioning({ projectId: "p", origin: { originId: "desk", mode: "desktop" }, force: true });
    expect(reprobed?.recovery).toBe("supported");
  });
});
