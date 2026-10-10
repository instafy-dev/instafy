import { describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import {
  latestHostedLaunchRequestedAtMs,
  resolveStalledHostedLaunch,
  runtimeEntryIsBooting,
  runtimeEntryIsStaleBooting,
  runtimeEntryIsStopping,
  runtimeEntryLaunchedAt,
  STALLED_LAUNCH_AFTER_MS,
  stalledLaunchDeadlineMs,
} from "./runtimeEntry";

function createEntry(
  overrides: Partial<ControllerRuntimeStatusEntry> = {},
): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "11111111-1111-4111-8111-111111111111",
    status: "requested",
    provider: "instafy-cloud",
    idleTtlSeconds: 300,
    isLocal: false,
    isPreferred: false,
    health: "offline",
    ...overrides,
  };
}

describe("runtimeEntry booting state", () => {
  it("treats recent requested runtimes as booting", () => {
    const nowMs = Date.parse("2026-02-12T12:00:00.000Z");
    const entry = createEntry({
      status: "requested",
      createdAt: "2026-02-12T11:58:30.000Z",
    });

    expect(runtimeEntryIsStaleBooting(entry, { nowMs })).toBe(false);
    expect(runtimeEntryIsBooting(entry, { nowMs })).toBe(true);
  });

  it("treats old requested runtimes as stale, not booting", () => {
    const nowMs = Date.parse("2026-02-12T12:00:00.000Z");
    const entry = createEntry({
      status: "requested",
      createdAt: "2026-02-12T11:54:00.000Z",
    });

    expect(runtimeEntryIsStaleBooting(entry, { nowMs })).toBe(true);
    expect(runtimeEntryIsBooting(entry, { nowMs })).toBe(false);
  });

  it("ignores stale logic for non-booting statuses", () => {
    const nowMs = Date.parse("2026-02-12T12:00:00.000Z");
    const entry = createEntry({
      status: "ready",
      health: "online",
      createdAt: "2026-02-12T11:40:00.000Z",
    });

    expect(runtimeEntryIsStaleBooting(entry, { nowMs })).toBe(false);
    expect(runtimeEntryIsBooting(entry, { nowMs })).toBe(false);
  });
});

describe("stalled hosted launch", () => {
  const requestedAt = "2026-10-05T12:00:00.000Z";
  const requestedAtMs = Date.parse(requestedAt);
  const launching = (overrides: Partial<ControllerRuntimeStatusEntry> = {}) =>
    createEntry({
      createdAt: "2026-10-01T00:00:00.000Z",
      lastSeenAt: null,
      launchRequestedAt: requestedAt,
      ...overrides,
    });

  it("is stalled five minutes after the lease was requested, and not before", () => {
    expect(STALLED_LAUNCH_AFTER_MS).toBe(5 * 60_000);
    expect(stalledLaunchDeadlineMs(launching())).toBe(requestedAtMs + STALLED_LAUNCH_AFTER_MS);
    expect(resolveStalledHostedLaunch(launching(), requestedAtMs + STALLED_LAUNCH_AFTER_MS - 1)).toBe(false);
    expect(resolveStalledHostedLaunch(launching(), requestedAtMs + STALLED_LAUNCH_AFTER_MS)).toBe(true);
    // The runtime row's own age does not count: a reused row gets a new lease.
    expect(
      resolveStalledHostedLaunch(launching({ createdAt: "2026-01-01T00:00:00.000Z" }), requestedAtMs + 60_000),
    ).toBe(false);
    for (const status of ["requested", "launching", "starting", "REQUESTED"]) {
      expect(resolveStalledHostedLaunch(launching({ status }), requestedAtMs + 6 * 60_000)).toBe(true);
    }
  });

  it("never stalls without the controller's launch time", () => {
    const late = requestedAtMs + 60 * 60_000;
    expect(stalledLaunchDeadlineMs(launching({ launchRequestedAt: undefined }))).toBeNull();
    expect(resolveStalledHostedLaunch(launching({ launchRequestedAt: undefined }), late)).toBe(false);
    expect(resolveStalledHostedLaunch(launching({ launchRequestedAt: null }), late)).toBe(false);
    expect(resolveStalledHostedLaunch(launching({ launchRequestedAt: "not a time" }), late)).toBe(false);
  });

  it("never stalls a runtime that has been seen, or one that is not launching", () => {
    const late = requestedAtMs + 60 * 60_000;
    expect(resolveStalledHostedLaunch(launching({ lastSeenAt: requestedAt }), late)).toBe(false);
    for (const status of ["ready", "running", "stopped", "failed"]) {
      expect(stalledLaunchDeadlineMs(launching({ status }))).toBeNull();
      expect(resolveStalledHostedLaunch(launching({ status }), late)).toBe(false);
    }
  });

  it("leaves desktop and self-hosted runtimes alone", () => {
    const late = requestedAtMs + 60 * 60_000;
    expect(resolveStalledHostedLaunch(launching({ isLocal: true }), late)).toBe(false);
    expect(resolveStalledHostedLaunch(launching({ provider: "self-hosted" }), late)).toBe(false);
    expect(resolveStalledHostedLaunch(launching({ endpointUrl: "http://127.0.0.1:8080" }), late)).toBe(false);
    expect(resolveStalledHostedLaunch(null, late)).toBe(false);
  });
});

describe("a stop's release", () => {
  // What the status answer showed during a stop's release (Oct 10): the old
  // launch, offline, never seen, no origin or endpoint.
  const launchedAt = "2026-10-10T10:52:00.000Z";
  const stopAtMs = Date.parse("2026-10-10T10:58:43.000Z");
  const releasing = (overrides: Partial<ControllerRuntimeStatusEntry> = {}) =>
    createEntry({
      createdAt: launchedAt,
      lastSeenAt: null,
      launchRequestedAt: launchedAt,
      endpointUrl: null,
      origin: null,
      ...overrides,
    });

  it("is a stop when a stop newer than the launch is known", () => {
    expect(runtimeEntryIsStopping(releasing(), stopAtMs)).toBe(true);
    // A controller that dates the stop on the runtime itself.
    expect(
      runtimeEntryIsStopping(
        releasing({ stopRequestedAt: new Date(stopAtMs).toISOString(), stopReason: "user_stop" }),
        null,
      ),
    ).toBe(true);
    expect(runtimeEntryIsStopping(releasing({ stopReason: "user_stop" }), null)).toBe(true);
    // Without a launch time to compare, the known stop is the newer fact.
    expect(runtimeEntryIsStopping(releasing({ launchRequestedAt: null }), stopAtMs)).toBe(true);
  });

  it("is a launch when no stop is known, or the launch came after it", () => {
    expect(runtimeEntryIsStopping(releasing(), null)).toBe(false);
    expect(runtimeEntryIsStopping(releasing({ launchRequestedAt: "2026-10-10T11:00:00.000Z" }), stopAtMs)).toBe(false);
    expect(
      runtimeEntryIsStopping(
        releasing({
          launchRequestedAt: "2026-10-10T11:00:00.000Z",
          stopRequestedAt: new Date(stopAtMs).toISOString(),
          stopReason: "user_stop",
        }),
        null,
      ),
    ).toBe(false);
    // The fields alone cannot tell: the same row is what a stalled launch shows.
    expect(resolveStalledHostedLaunch(releasing(), stopAtMs)).toBe(true);
  });

  it("leaves the release of a stop nobody chose to read as a launch that stalled", () => {
    // The controller marks every stop's release, and after a failed one keeps
    // the mark until it retries, up to 15 minutes later. A machine that
    // crashed must still be started again, or offered Try again.
    const stopRequestedAt = new Date(stopAtMs).toISOString();
    for (const stopReason of ["heartbeat_timeout", "launch_timeout", "idle", "other", "", null]) {
      expect(runtimeEntryIsStopping(releasing({ stopRequestedAt, stopReason }), null)).toBe(false);
    }
    expect(runtimeEntryIsStopping(releasing({ stopRequestedAt }), null)).toBe(false);
    for (const stopReason of ["user_stop", "user_remove", "runtime_limit_takeover"]) {
      expect(runtimeEntryIsStopping(releasing({ stopRequestedAt, stopReason }), null)).toBe(true);
    }
  });

  it("only applies to a hosted runtime that still reads as launching", () => {
    for (const status of ["stopped", "ready", "failed"]) {
      expect(runtimeEntryIsStopping(releasing({ status }), stopAtMs)).toBe(false);
    }
    expect(runtimeEntryIsStopping(releasing({ isLocal: true }), stopAtMs)).toBe(false);
    expect(runtimeEntryIsStopping(releasing({ provider: "self-hosted" }), stopAtMs)).toBe(false);
    expect(runtimeEntryIsStopping(null, stopAtMs)).toBe(false);
  });
});

describe("latestHostedLaunchRequestedAtMs", () => {
  it("is the latest launch of a hosted runtime", () => {
    expect(
      latestHostedLaunchRequestedAtMs([
        createEntry({ launchRequestedAt: "2026-10-10T10:52:00.000Z" }),
        createEntry({ launchRequestedAt: "2026-10-10T11:01:00.000Z" }),
        // A desktop runtime's launch is no hosted machine.
        createEntry({ isLocal: true, launchRequestedAt: "2026-10-10T11:05:00.000Z" }),
        createEntry({ launchRequestedAt: null }),
        null,
      ]),
    ).toBe(Date.parse("2026-10-10T11:01:00.000Z"));
    expect(latestHostedLaunchRequestedAtMs([createEntry()])).toBeNull();
    expect(latestHostedLaunchRequestedAtMs([])).toBeNull();
  });
});

describe("runtimeEntryLaunchedAt", () => {
  const rowCreatedAt = "2026-10-07T12:40:54.000Z";
  const launchRequestedAt = "2026-10-10T16:22:07.000Z";

  it("is the current launch of a hosted runtime, not when its row was created", () => {
    const entry = createEntry({ status: "ready", createdAt: rowCreatedAt, launchRequestedAt });
    expect(runtimeEntryLaunchedAt(entry)).toBe(launchRequestedAt);
  });

  it("falls back to the row's creation without a launch time", () => {
    expect(runtimeEntryLaunchedAt(createEntry({ createdAt: rowCreatedAt }))).toBe(rowCreatedAt);
  });

  it("keeps a self-hosted runtime's creation time", () => {
    const entry = createEntry({
      provider: "self-hosted",
      isLocal: true,
      createdAt: rowCreatedAt,
      launchRequestedAt,
    });
    expect(runtimeEntryLaunchedAt(entry)).toBe(rowCreatedAt);
  });
});
