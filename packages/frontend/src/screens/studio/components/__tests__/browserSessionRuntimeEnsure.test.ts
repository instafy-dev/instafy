import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController";
import {
  coalesceBrowserRuntimeEnsure,
  isManagedInstafyCloudProvider,
  resolveAutoRecyclableBrowserRuntimeIdentity,
  resolveAutoRecyclableBrowserRuntimeId,
  resolveBrowserRuntimeCandidate,
  waitForBrowserRuntimeOrigin,
} from "../browserSessionRuntimeEnsure";

function createRuntimeEntry(
  overrides: Partial<ControllerRuntimeStatusEntry> = {},
): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "runtime-1",
    status: "ready",
    provider: "instafy-cloud",
    idleTtlSeconds: 300,
    lastSeenAt: "2026-07-13T11:59:00.000Z",
    isLocal: false,
    isPreferred: false,
    health: "idle",
    displayName: "Hosted Runtime",
    ...overrides,
  };
}

function resolveCandidate(
  overrides: Partial<Parameters<typeof resolveAutoRecyclableBrowserRuntimeId>[0]> = {},
): string | null {
  return resolveAutoRecyclableBrowserRuntimeId({
    activeProjectId: "project-1",
    blockerProjectId: "project-1",
    blockerRuntimeId: "runtime-1",
    blockerRuntimeLabel: "Hosted Runtime",
    projectStatusSnapshot: {
      projectId: "project-1",
      runtimes: [createRuntimeEntry()],
    },
    ...overrides,
  });
}

describe("resolveBrowserRuntimeCandidate", () => {
  it.each(["instafy-cloud", "instafy_cloud", " Instafy Cloud "])(
    "accepts the exact managed provider id %s",
    (provider) => {
    expect(isManagedInstafyCloudProvider(provider)).toBe(true);
    },
  );

  it.each([
    "self_hosted",
    "runtime",
    "docker",
    "instafy-clouded",
    "instafy-cloud-large",
    "Instafy Cloud Webdev",
    "instafy",
  ])(
    "rejects the non-managed provider id %s",
    (provider) => {
      expect(isManagedInstafyCloudProvider(provider)).toBe(false);
    },
  );

  it("never reuses a browser-capable self-hosted runtime", () => {
    const origin = {
      originId: "origin-1",
      endpoint: "https://origin.example.test",
      protocols: ["http"],
    };
    const selfHosted = createRuntimeEntry({
      runtimeId: "self-hosted-runtime",
      provider: "self_hosted",
      displayName: "Browser session",
      lastSeenAt: null,
      origin,
    });
    const managed = createRuntimeEntry({
      runtimeId: "managed-runtime",
      provider: "instafy-cloud",
      displayName: "Browser session",
      lastSeenAt: null,
      origin: { ...origin, originId: "origin-2" },
    });

    expect(
      resolveBrowserRuntimeCandidate([selfHosted, managed], selfHosted.runtimeId),
    ).toEqual({
      runtimeId: "managed-runtime",
      originId: "origin-2",
      endpoint: "https://origin.example.test",
    });
    expect(resolveBrowserRuntimeCandidate([selfHosted], selfHosted.runtimeId)).toBeNull();
  });

  it("rejects a controller-classified local runtime with a cloud-looking provider id", () => {
    const disguisedSelfHosted = createRuntimeEntry({
      runtimeId: "disguised-self-hosted",
      provider: "instafy-cloud-custom",
      isPrivateSelfHosted: true,
      displayName: "Browser session",
      origin: {
        originId: "private-origin",
        endpoint: "https://private-origin.example.test",
        protocols: ["http"],
      },
    });

    expect(
      resolveBrowserRuntimeCandidate(
        [disguisedSelfHosted],
        disguisedSelfHosted.runtimeId,
      ),
    ).toBeNull();
  });

  it("rejects an otherwise usable custom provider with a cloud-looking id", () => {
    const cloudLookingCustom = createRuntimeEntry({
      runtimeId: "custom-runtime",
      provider: "instafy-cloud-custom",
      isPrivateSelfHosted: false,
      displayName: "Browser session",
      origin: {
        originId: "custom-origin",
        endpoint: "https://custom-origin.example.test",
        protocols: ["http"],
      },
    });

    expect(
      resolveBrowserRuntimeCandidate([cloudLookingCustom], cloudLookingCustom.runtimeId),
    ).toBeNull();
  });
});

describe("resolveAutoRecyclableBrowserRuntimeId", () => {
  it("selects the matching dispatchable generic Instafy Cloud runtime", () => {
    expect(resolveCandidate()).toBe("runtime-1");
    expect(
      resolveAutoRecyclableBrowserRuntimeIdentity({
        activeProjectId: "project-1",
        blockerProjectId: "project-1",
        blockerRuntimeId: "runtime-1",
        blockerRuntimeLabel: "Hosted Runtime",
        projectStatusSnapshot: {
          projectId: "project-1",
          runtimes: [createRuntimeEntry()],
        },
      }),
    ).toEqual({
      runtimeId: "runtime-1",
      projectId: "project-1",
      provider: "instafy-cloud",
      displayName: "Hosted Runtime",
    });
  });

  it("requires the structured blocker label to match the current runtime label", () => {
    expect(resolveCandidate({ blockerRuntimeLabel: null })).toBeNull();
    expect(resolveCandidate({ blockerRuntimeLabel: "Browser session" })).toBeNull();
    expect(
      resolveCandidate({
        blockerRuntimeLabel: "Hosted Runtime",
        projectStatusSnapshot: {
          projectId: "project-1",
          runtimes: [createRuntimeEntry({ displayName: "hosted runtime changed" })],
        },
      }),
    ).toBeNull();
  });

  it("never selects a blocker or status snapshot from another project", () => {
    expect(resolveCandidate({ blockerProjectId: "project-2" })).toBeNull();
    expect(
      resolveCandidate({
        projectStatusSnapshot: {
          projectId: "project-2",
          runtimes: [createRuntimeEntry()],
        },
      }),
    ).toBeNull();
  });

  it("requires the exact blocker runtime in the project status snapshot", () => {
    expect(
      resolveCandidate({
        projectStatusSnapshot: {
          projectId: "project-1",
          runtimes: [createRuntimeEntry({ runtimeId: "runtime-2" })],
        },
      }),
    ).toBeNull();
  });

  it.each([
    ["still starting", { status: "requested", health: "offline" as const }],
    ["temporarily unhealthy", { status: "ready", health: "offline" as const }],
    [
      "past its heartbeat TTL",
      { lastSeenAt: "2026-07-13T11:50:00.000Z", idleTtlSeconds: 300 },
    ],
  ])("selects a matching generic runtime that is %s", (_label, entryOverrides) => {
    expect(
      resolveCandidate({
        projectStatusSnapshot: {
          projectId: "project-1",
          runtimes: [createRuntimeEntry(entryOverrides)],
        },
      }),
    ).toBe("runtime-1");
  });

  it.each([
    ["browser runtime name", { displayName: "Browser session" }],
    ["custom runtime name", { displayName: "Production worker" }],
    ["local runtime", { isLocal: true }],
    ["non-Instafy provider", { provider: "docker" }],
  ])("rejects a %s", (_label, entryOverrides) => {
    expect(
      resolveCandidate({
        projectStatusSnapshot: {
          projectId: "project-1",
          runtimes: [createRuntimeEntry(entryOverrides)],
        },
      }),
    ).toBeNull();
  });
});

describe("coalesceBrowserRuntimeEnsure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares concurrent and recently resolved ensures", async () => {
    vi.useFakeTimers();
    const operation = vi.fn(async () => ({ runtimeId: "runtime-1" }));

    const options = { graceMs: 100 };
    const first = coalesceBrowserRuntimeEnsure("project-1:auto", operation, options);
    const concurrent = coalesceBrowserRuntimeEnsure("project-1:auto", operation, options);
    expect(concurrent).toBe(first);
    await expect(first).resolves.toEqual({ runtimeId: "runtime-1" });

    const recent = coalesceBrowserRuntimeEnsure("project-1:auto", operation, options);
    expect(recent).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    const afterGrace = coalesceBrowserRuntimeEnsure("project-1:auto", operation, options);
    expect(afterGrace).not.toBe(first);
    expect(operation).toHaveBeenCalledTimes(2);
    await afterGrace;
  });

  it("allows an immediate retry after a failed ensure", async () => {
    const operation = vi
      .fn<() => Promise<{ runtimeId: string }>>()
      .mockRejectedValueOnce(new Error("allocator unavailable"))
      .mockResolvedValueOnce({ runtimeId: "runtime-2" });

    await expect(
      coalesceBrowserRuntimeEnsure("project-2:auto", operation),
    ).rejects.toThrow("allocator unavailable");
    await expect(
      coalesceBrowserRuntimeEnsure("project-2:auto", operation),
    ).resolves.toEqual({ runtimeId: "runtime-2" });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("bypasses a recently resolved ensure when reconnecting", async () => {
    const operation = vi
      .fn<() => Promise<{ runtimeId: string }>>()
      .mockResolvedValueOnce({ runtimeId: "runtime-stale" })
      .mockResolvedValueOnce({ runtimeId: "runtime-fresh" });

    await expect(
      coalesceBrowserRuntimeEnsure("project-3:auto", operation),
    ).resolves.toEqual({ runtimeId: "runtime-stale" });
    await expect(
      coalesceBrowserRuntimeEnsure("project-3:auto", operation, { reuseResolved: false }),
    ).resolves.toEqual({ runtimeId: "runtime-fresh" });
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe("waitForBrowserRuntimeOrigin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off status refreshes while preserving fast initial discovery", async () => {
    vi.useFakeTimers();
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({
        runtimes: [createRuntimeEntry({ origin: null })],
        preferredRuntimeId: null,
      })
      .mockResolvedValueOnce({
        runtimes: [createRuntimeEntry({ origin: null })],
        preferredRuntimeId: null,
      })
      .mockResolvedValueOnce({
        runtimes: [createRuntimeEntry({ origin: null })],
        preferredRuntimeId: null,
      })
      .mockResolvedValueOnce({
        runtimes: [
          createRuntimeEntry({
            origin: {
              originId: " origin-1 ",
              endpoint: " https://runtime.example.test ",
              protocols: ["http"],
            },
          }),
        ],
        preferredRuntimeId: null,
      });

    const result = waitForBrowserRuntimeOrigin({
      projectId: "project-1",
      runtimeId: "runtime-1",
      fetchStatus,
      timeoutMs: 10_000,
      initialPollIntervalMs: 500,
      maxPollIntervalMs: 4_000,
    });

    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({
      originId: "origin-1",
      endpoint: "https://runtime.example.test",
    });
    expect(fetchStatus).toHaveBeenCalledTimes(4);
  });

  it("caps the backoff interval until the discovery deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pollTimes: number[] = [];
    const fetchStatus = vi.fn(async () => {
      pollTimes.push(Date.now());
      return {
        runtimes: [createRuntimeEntry({ origin: null })],
        preferredRuntimeId: null,
      };
    });

    const result = waitForBrowserRuntimeOrigin({
      projectId: "project-1",
      runtimeId: "runtime-1",
      fetchStatus,
      timeoutMs: 1_500,
      initialPollIntervalMs: 100,
      maxPollIntervalMs: 400,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ originId: null, endpoint: null });
    expect(pollTimes).toEqual([0, 100, 300, 700, 1_100]);
  });

  it("cancels a pending backoff without another status refresh", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const fetchStatus = vi.fn(async () => ({
      runtimes: [createRuntimeEntry({ origin: null })],
      preferredRuntimeId: null,
    }));

    const result = waitForBrowserRuntimeOrigin({
      projectId: "project-1",
      runtimeId: "runtime-1",
      fetchStatus,
      signal: abortController.signal,
      timeoutMs: 10_000,
    });
    await Promise.resolve();
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    abortController.abort();

    await expect(result).resolves.toEqual({ originId: null, endpoint: null });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
