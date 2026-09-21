import { describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import { stopLeavesNoLiveHostedRuntime } from "../manualStopDecisions";

function entry(
  overrides: Partial<ControllerRuntimeStatusEntry> & { runtimeId: string },
): ControllerRuntimeStatusEntry {
  return {
    status: "ready",
    provider: "instafy-cloud",
    idleTtlSeconds: 600,
    isLocal: false,
    isPreferred: false,
    health: "online",
    ...overrides,
  };
}

describe("stopLeavesNoLiveHostedRuntime", () => {
  it("holds when the stopped machine is the only hosted one", () => {
    expect(stopLeavesNoLiveHostedRuntime([entry({ runtimeId: "a" })], "a")).toBe(true);
  });

  it("holds when the status list is empty or does not list the machine", () => {
    expect(stopLeavesNoLiveHostedRuntime([], "a")).toBe(true);
    expect(
      stopLeavesNoLiveHostedRuntime(
        [entry({ runtimeId: "b", status: "stopped", health: "offline" })],
        "a",
      ),
    ).toBe(true);
  });

  it("does not hold while another hosted machine is ready", () => {
    expect(
      stopLeavesNoLiveHostedRuntime(
        [entry({ runtimeId: "a" }), entry({ runtimeId: "b" })],
        "a",
      ),
    ).toBe(false);
  });

  it("does not hold while another hosted machine is still booting", () => {
    expect(
      stopLeavesNoLiveHostedRuntime(
        [
          entry({ runtimeId: "a" }),
          entry({ runtimeId: "b", status: "launching", health: "offline" }),
        ],
        "a",
      ),
    ).toBe(false);
  });

  it("ignores hosted machines that are stopped or offline", () => {
    expect(
      stopLeavesNoLiveHostedRuntime(
        [
          entry({ runtimeId: "a" }),
          entry({ runtimeId: "b", status: "stopped", health: "offline" }),
          entry({ runtimeId: "c", status: "failed", health: "offline" }),
        ],
        "a",
      ),
    ).toBe(true);
  });

  it("ignores self-hosted machines, which the hold never covers", () => {
    expect(
      stopLeavesNoLiveHostedRuntime(
        [
          entry({ runtimeId: "a" }),
          entry({ runtimeId: "desktop", isLocal: true, provider: "desktop" }),
        ],
        "a",
      ),
    ).toBe(true);
  });
});
