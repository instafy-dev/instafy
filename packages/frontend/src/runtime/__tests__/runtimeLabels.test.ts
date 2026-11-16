import { describe, expect, it } from "vitest";
import type {
  ControllerRuntimeStatusEntry,
  ControllerTunnelGrant,
  LocalWorkspacePresence,
} from "../../sdk/instafy";
import { getRuntimeLabel, hostedMachineOwnName } from "../runtimeLabels";
import { resolveRuntimeStateStyles } from "../runtimeMenuShared";

/**
 * A hosted runtime as a stop's release leaves it: `requested` on its launch,
 * offline, never seen, no origin or endpoint. `launchedAgoMs` sets how long
 * ago that launch (and the runtime row) was.
 */
function releasing(
  launchedAgoMs: number,
  overrides: Partial<ControllerRuntimeStatusEntry> = {},
): ControllerRuntimeStatusEntry {
  const launchedAt = new Date(Date.now() - launchedAgoMs).toISOString();
  return {
    runtimeId: "11111111-1111-4111-8111-111111111111",
    status: "requested",
    provider: "instafy-cloud",
    idleTtlSeconds: 300,
    createdAt: launchedAt,
    lastSeenAt: null,
    launchRequestedAt: launchedAt,
    endpointUrl: null,
    origin: null,
    isLocal: false,
    isPreferred: false,
    health: "offline",
    ...overrides,
  };
}

describe("getRuntimeLabel for a stop's release", () => {
  const stopAtMs = () => Date.now() - 10_000;

  it.each([
    ["a recent launch", 2 * 60_000],
    ["an older launch", 30 * 60_000],
  ])("shows the machine stopping, without a spinner or Offline (%s)", (_label, launchedAgoMs) => {
    for (const [entry, knownStopAtMs] of [
      // This tab's Stop, or a turn a person's stop put back in the queue.
      [releasing(launchedAgoMs), stopAtMs()],
      // The controller's own mark on the runtime.
      [
        releasing(launchedAgoMs, {
          stopRequestedAt: new Date(stopAtMs()).toISOString(),
          stopReason: "user_stop",
        }),
        null,
      ],
    ] as const) {
      const info = getRuntimeLabel(entry, null, null, knownStopAtMs);
      expect(info.statusBadge).toEqual({ text: "Stopping", tone: "neutral" });
      expect(info.statusState).toBe("offline");
      expect(resolveRuntimeStateStyles(info.statusState).indicator).not.toBe("spinner");
      expect(info.detail ?? "").not.toContain("Offline");
    }
  });

  it("still shows a launch with no stop known as one", () => {
    const recent = getRuntimeLabel(releasing(2 * 60_000), null, null, null);
    expect(recent.statusState).toBe("booting");
    expect(recent.statusBadge).toBeNull();

    const old = getRuntimeLabel(releasing(30 * 60_000), null, null, null);
    expect(old.statusBadge).toBeNull();
    expect(old.detail).toContain("Offline");

    // A launch requested after the stop is a launch again.
    const relaunched = getRuntimeLabel(releasing(2 * 60_000), null, null, Date.now() - 5 * 60_000);
    expect(relaunched.statusState).toBe("booting");
    expect(relaunched.statusBadge).toBeNull();
  });
});

describe("machine names in rows", () => {
  const running = (overrides: Partial<ControllerRuntimeStatusEntry> = {}) =>
    releasing(10 * 60_000, {
      status: "ready",
      health: "online",
      lastSeenAt: new Date().toISOString(),
      ...overrides,
    });

  it("names a hosted machine Instafy Cloud, also under the name Studio stores", () => {
    for (const displayName of [null, "Hosted Runtime", "Instafy Cloud runtime"]) {
      const info = getRuntimeLabel(running({ displayName }), null, null, null);
      expect(info.label).toBe("Instafy Cloud");
      expect(info.detail ?? "").not.toMatch(/runtime/i);
    }
    expect(getRuntimeLabel(running({ displayName: "Browser session" }), null, null, null).label)
      .toBe("Browser session");
    // A local stack's hosted machine answers on this computer's address.
    const onThisComputer = running({
      displayName: "Hosted Runtime",
      isLocal: true,
      endpointUrl: "http://127.0.0.1:4823",
    });
    expect(getRuntimeLabel(onThisComputer, null, null, null).label).toBe("Instafy Cloud (127.0.0.1)");
  });

  it("names other machines without the word runtime", () => {
    const selfHosted = running({ provider: "self-hosted", displayName: null });
    expect(getRuntimeLabel(selfHosted, null, null, null).label).toBe("Self-hosted machine");
    const local = running({
      provider: "self-hosted",
      displayName: null,
      isLocal: true,
      endpointUrl: "http://studio-box.local:4823",
    });
    expect(getRuntimeLabel(local, null, null, null).label).toBe(
      "Self-hosted machine (studio-box.local)",
    );
    expect(getRuntimeLabel(running({ provider: "lima-box" }), null, null, null).label).toBe(
      "lima-box machine",
    );
    expect(getRuntimeLabel(running({ provider: "" }), null, null, null).label).toBe("Machine");
    const thisComputer: LocalWorkspacePresence = {
      deviceId: "this-computer",
      runtimeId: "11111111-1111-4111-8111-111111111111",
      status: "online",
    };
    const mine = getRuntimeLabel(
      running({ provider: "self-hosted", isLocal: true }),
      thisComputer,
      null,
      null,
    );
    expect(mine.label).toBe("Your machine");
  });

  it("gives a blocking hosted machine's own name, and none for the generic one", () => {
    for (const generic of [
      "Hosted Runtime",
      " hosted runtime ",
      "Instafy Cloud",
      "Instafy Cloud runtime",
      "",
      "  ",
      null,
      undefined,
    ]) {
      expect(hostedMachineOwnName(generic)).toBeNull();
    }
    expect(hostedMachineOwnName(" Team research machine ")).toBe("Team research machine");
    expect(hostedMachineOwnName("Browser session")).toBe("Browser session");
  });
});

describe("getRuntimeLabel with a revoked tunnel", () => {
  function tunnel(status: string): ControllerTunnelGrant {
    return {
      id: "tunnel-1",
      projectId: null,
      runtimeId: "11111111-1111-4111-8111-111111111111",
      runtimeLeaseId: null,
      provider: "instafy-cloud",
      tunnelId: "tunnel-1",
      hostname: null,
      url: null,
      status,
      expiresAt: null,
    };
  }

  it("shows a stopped machine as stopped, not as a tunnel warning", () => {
    const stopped = releasing(10 * 60_000, { status: "stopped" });
    for (const status of ["revoked", "expired"]) {
      const info = getRuntimeLabel(stopped, null, tunnel(status), null);
      expect(info.statusBadge).toBeNull();
      expect(info.statusState).toBe("offline");
      expect(info.detail).toContain("Offline");
    }
  });

  it("keeps a stopping machine's label", () => {
    const info = getRuntimeLabel(
      releasing(2 * 60_000),
      null,
      tunnel("revoked"),
      Date.now() - 10_000,
    );
    expect(info.statusBadge).toEqual({ text: "Stopping", tone: "neutral" });
  });

  it("still warns about a revoked tunnel on a running machine", () => {
    const running = releasing(10 * 60_000, {
      status: "ready",
      health: "online",
      lastSeenAt: new Date().toISOString(),
    });
    const info = getRuntimeLabel(running, null, tunnel("revoked"), null);
    expect(info.statusBadge).toEqual({ text: "Tunnel revoked", tone: "warning" });
    expect(info.statusState).toBe("idle");
  });
});
