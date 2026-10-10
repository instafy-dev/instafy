import { describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import { getRuntimeLabel } from "../runtimeLabels";
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
