import { describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../sdk/instafy";
import {
  runtimeEntryIsBooting,
  runtimeEntryIsStaleBooting,
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
