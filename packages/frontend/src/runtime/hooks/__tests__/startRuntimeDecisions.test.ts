import { describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import { resolveStartRuntimeParams } from "../startRuntimeDecisions";

const REQUESTED_AT = "2026-10-05T12:00:00.000Z";
const MINUTE = 60_000;

function entry(overrides: Partial<ControllerRuntimeStatusEntry> = {}): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "runtime-1",
    status: "requested",
    provider: "instafy-cloud",
    idleTtlSeconds: 600,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: null,
    launchRequestedAt: REQUESTED_AT,
    isLocal: false,
    isPreferred: true,
    health: "offline",
    displayName: "Hosted Runtime",
    origin: { mode: "hosted", protocols: ["http"], metadata: { sizeId: "small" } },
    ...overrides,
  };
}

describe("resolveStartRuntimeParams", () => {
  it("asks for a stalled launch to be replaced, and starts everything else as before", () => {
    const sixMinutesIn = Date.parse(REQUESTED_AT) + 6 * MINUTE;
    const base = {
      projectId: "project-1",
      runtimeId: "runtime-1",
      displayName: "Hosted Runtime",
      originMode: "hosted",
      originProtocols: ["http"],
      originMetadata: { sizeId: "small" },
    };

    expect(resolveStartRuntimeParams("project-1", entry(), sixMinutesIn)).toEqual({
      ...base,
      replaceStalledLaunch: true,
    });

    // Under the bound, already seen, stopped, or from a controller that does
    // not say when the launch began: the request is unchanged.
    for (const [overrides, nowMs] of [
      [{}, Date.parse(REQUESTED_AT) + 2 * MINUTE],
      [{ lastSeenAt: REQUESTED_AT }, sixMinutesIn],
      [{ status: "stopped" }, sixMinutesIn],
      [{ launchRequestedAt: undefined }, sixMinutesIn],
    ] as const) {
      const params = resolveStartRuntimeParams("project-1", entry(overrides), nowMs);
      expect(params).toEqual(base);
      expect(params).not.toHaveProperty("replaceStalledLaunch");
    }
  });
});
