import { afterEach, describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import { ControllerApiError } from "../../../services/runtimeController/core";
import { clearManualStop, manualStopHold, markManualStop } from "../../idlePauseRegistry";
import { removeUnderManualHold, stopLeavesNoLiveHostedRuntime, stopUnderManualHold } from "../manualStopDecisions";

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

describe("stopUnderManualHold", () => {
  const PROJECT_ID = "project-stop";
  const SAVED = { status: "flushed", unpushedRefs: 0, error: null };

  afterEach(() => clearManualStop(PROJECT_ID));

  function stopError(status: number, message: string, code: string | null = null, details: unknown = null) {
    return new ControllerApiError({ status, message, code, details });
  }

  it("keeps the hold and what the stop answered", async () => {
    const hold = markManualStop(PROJECT_ID);
    await expect(stopUnderManualHold(PROJECT_ID, hold, async () => ({ flush: SAVED }))).resolves.toEqual({
      flush: SAVED,
    });
    expect(manualStopHold(PROJECT_ID)).toBe(hold);
    expect(hold?.flush).toEqual(SAVED);
  });

  it("keeps the hold when the stop took effect though it answered an error", async () => {
    // The machine is fenced off and its turn is back in the queue; lifting
    // the hold would let this tab start it again on the next status read.
    const pending = markManualStop(PROJECT_ID);
    await expect(
      stopUnderManualHold(PROJECT_ID, pending, async () => {
        throw stopError(502, "runtime provider cleanup is still pending", "provider_cleanup_pending", {
          flush: SAVED,
        });
      }),
    ).resolves.toEqual({ flush: SAVED });
    expect(manualStopHold(PROJECT_ID)).toBe(pending);
    expect(pending?.flush).toEqual(SAVED);

    const raced = markManualStop(PROJECT_ID);
    await expect(
      stopUnderManualHold(PROJECT_ID, raced, async () => {
        throw stopError(409, "runtime lease generation is no longer current");
      }),
    ).resolves.toEqual({ flush: null });
    expect(manualStopHold(PROJECT_ID)).toBe(raced);
  });

  it("keeps the hold but rethrows when the stop may have taken effect", async () => {
    // The controller can commit the stop and still answer 500, and a proxy
    // or the browser can give up while the provider releases the machine.
    for (const failure of [
      stopError(500, "failed to finalize runtime stop"),
      stopError(502, "stop runtime failed (502): <html>Bad Gateway</html>"),
      stopError(503, "stop runtime failed (503)"),
      stopError(504, "stop runtime failed (504): <html>Gateway Timeout</html>"),
      new TypeError("Failed to fetch"),
      new DOMException("signal timed out", "TimeoutError"),
    ]) {
      const hold = markManualStop(PROJECT_ID);
      await expect(
        stopUnderManualHold(PROJECT_ID, hold, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(manualStopHold(PROJECT_ID), failure.message).toBe(hold);
      // Nothing says where the work went.
      expect(hold?.flush, failure.message).toBeNull();
    }
  });

  it("lifts the hold and rethrows when the controller refused the stop", async () => {
    for (const failure of [
      stopError(409, "provider-managed runtime is missing its active lease generation"),
      stopError(403, "forbidden"),
      stopError(404, "runtime not found"),
    ]) {
      const hold = markManualStop(PROJECT_ID);
      await expect(
        stopUnderManualHold(PROJECT_ID, hold, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(manualStopHold(PROJECT_ID), failure.message).toBeNull();
    }
  });

  it("leaves a later Stop's hold to that Stop", async () => {
    const first = markManualStop(PROJECT_ID);
    const second = markManualStop(PROJECT_ID);
    await expect(
      stopUnderManualHold(PROJECT_ID, first, async () => {
        throw stopError(409, "provider-managed runtime is missing its active lease generation");
      }),
    ).rejects.toThrow("missing its active lease generation");
    expect(manualStopHold(PROJECT_ID)).toBe(second);
  });

  it("holds nothing when the Stop set no hold", async () => {
    await expect(stopUnderManualHold(PROJECT_ID, null, async () => ({ flush: SAVED }))).resolves.toEqual({
      flush: SAVED,
    });
    expect(manualStopHold(PROJECT_ID)).toBeNull();
    await expect(
      stopUnderManualHold(PROJECT_ID, null, async () => {
        throw stopError(500, "failed to commit runtime stop");
      }),
    ).rejects.toThrow("failed to commit runtime stop");
  });
});

describe("removeUnderManualHold", () => {
  const PROJECT_ID = "project-remove";
  const SAVED = { status: "flushed", unpushedRefs: 0, error: null };

  afterEach(() => clearManualStop(PROJECT_ID));

  function removeError(status: number, message: string, code: string | null = null) {
    return new ControllerApiError({ status, message, code, details: code ? { flush: null } : null });
  }

  it("keeps the hold and what the removal kept", async () => {
    // The runtime leaves the space's list; without the hold the next status
    // read finds no machine and starts a new one.
    const hold = markManualStop(PROJECT_ID);
    await expect(removeUnderManualHold(PROJECT_ID, hold, async () => ({ flush: SAVED }))).resolves.toEqual({
      flush: SAVED,
    });
    expect(manualStopHold(PROJECT_ID)).toBe(hold);
    expect(hold?.flush).toEqual(SAVED);
  });

  it("keeps the hold, and still says so, when the removal took effect but did not finish", async () => {
    // The machine is fenced off and its turn is back in the queue, but the
    // runtime is still listed, so the person removes it again.
    for (const failure of [
      removeError(502, "runtime provider cleanup is still pending; retry removal", "provider_cleanup_pending"),
      removeError(409, "runtime lease generation is no longer current"),
    ]) {
      const hold = markManualStop(PROJECT_ID);
      await expect(
        removeUnderManualHold(PROJECT_ID, hold, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(manualStopHold(PROJECT_ID), failure.message).toBe(hold);
    }
  });

  it("keeps the hold when the removal may have taken effect", async () => {
    for (const failure of [
      removeError(500, "failed to finalize runtime removal"),
      removeError(502, "remove runtime failed (502): <html>Bad Gateway</html>"),
      removeError(504, "remove runtime failed (504)"),
      new TypeError("Failed to fetch"),
    ]) {
      const hold = markManualStop(PROJECT_ID);
      await expect(
        removeUnderManualHold(PROJECT_ID, hold, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(manualStopHold(PROJECT_ID), failure.message).toBe(hold);
    }
  });

  it("lifts the hold when the controller refused the removal, unless a later Stop set its own", async () => {
    for (const failure of [
      removeError(409, "provider-managed runtime is missing its active lease generation"),
      removeError(403, "forbidden"),
      removeError(404, "runtime not found"),
    ]) {
      const hold = markManualStop(PROJECT_ID);
      await expect(
        removeUnderManualHold(PROJECT_ID, hold, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(manualStopHold(PROJECT_ID), failure.message).toBeNull();
    }

    const first = markManualStop(PROJECT_ID);
    const second = markManualStop(PROJECT_ID);
    await expect(
      removeUnderManualHold(PROJECT_ID, first, async () => {
        throw removeError(404, "runtime not found");
      }),
    ).rejects.toThrow("runtime not found");
    expect(manualStopHold(PROJECT_ID)).toBe(second);
  });
});
