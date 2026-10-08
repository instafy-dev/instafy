// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import {
  clearIdlePaused,
  clearManualStop,
  clearRestoredAwaitingIntent,
  isIdlePaused,
  isManualStopHeld,
  isRestoredAwaitingIntent,
  markIdlePaused,
  markManualStop,
  markRestoredAwaitingIntent,
} from "../../idlePauseRegistry";

// vi.mock is hoisted above module-level consts, so the spy has to be too.
const { ensure } = vi.hoisted(() => ({ ensure: vi.fn() }));

vi.mock("../../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../../sdk/instafy")>(
    "../../../sdk/instafy",
  );
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      runtimes: { ...actual.controllerClient.runtimes, ensure },
    },
  };
});

import { ControllerApiError } from "../../../services/runtimeController/core";
import { stopUnderManualHold } from "../manualStopDecisions";
import {
  STALLED_LAUNCH_RETRY_FAILED_MESSAGE,
  useHostedRuntimeEnsure,
} from "../useHostedRuntimeEnsure";

const PROJECT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// The row the controller leaves behind when a queued prompt asked for a
// machine and the org slot check refused it: requested, never seen, and
// young enough to still read as booting.
function staleRequestedRow(): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    status: "requested",
    provider: "instafy-cloud",
    idleTtlSeconds: 300,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    lastSeenAt: null,
    endpointUrl: null,
    taskRef: null,
    isLocal: false,
    isPrivateSelfHosted: false,
    isPreferred: false,
    health: "offline",
  } as ControllerRuntimeStatusEntry;
}

describe("useHostedRuntimeEnsure force", () => {
  let container: HTMLDivElement;
  let root: Root;
  let ensureHostedRuntime: ReturnType<typeof useHostedRuntimeEnsure>["ensureHostedRuntime"] | null = null;
  const showStatus = vi.fn();

  function Harness({ statuses }: { statuses: ControllerRuntimeStatusEntry[] }) {
    const result = useHostedRuntimeEnsure({
      enabled: true,
      projectId: PROJECT_ID,
      runtimeStatuses: statuses,
      runtimeStatusesResolved: true,
      refreshRuntimeStatuses: async () => {},
      showStatus,
      setRuntimeEnsureError: () => {},
      setRuntimeEnsureLimit: () => {},
      showDesktopRuntimeHelp: () => {},
    });
    ensureHostedRuntime = result.ensureHostedRuntime;
    return null;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ensure.mockReset();
    ensure.mockResolvedValue({ runtimeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
    showStatus.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness statuses={[staleRequestedRow()]} />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reuses a young requested row on a plain ensure and requests nothing", async () => {
    let result: boolean | undefined;
    await act(async () => {
      result = await ensureHostedRuntime!();
    });
    expect(result).toBe(true);
    expect(ensure).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith("Instafy Cloud runtime is starting…", "info", 3000);
  });

  it("requests a machine anyway when forced", async () => {
    let result: boolean | undefined;
    await act(async () => {
      result = await ensureHostedRuntime!({ force: true });
    });
    expect(result).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, provider: "instafy-cloud" }),
    );
  });

  it("answers a second request for the space with the one already on its way", async () => {
    // Send in a held space lifts the holds, which wakes the auto-start; it
    // calls back in before the first request has asked the controller.
    await act(async () => {
      root.render(<Harness statuses={[]} />);
    });
    let results: boolean[] = [];
    await act(async () => {
      results = await Promise.all([ensureHostedRuntime!(), ensureHostedRuntime!()]);
    });
    expect(results).toEqual([true, true]);
    expect(ensure).toHaveBeenCalledTimes(1);

    // Once it has settled, the next request asks again.
    await act(async () => {
      await ensureHostedRuntime!();
    });
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("does not let a forced request wait on a plain one", async () => {
    let results: boolean[] = [];
    await act(async () => {
      results = await Promise.all([ensureHostedRuntime!(), ensureHostedRuntime!({ force: true })]);
    });
    expect(results).toEqual([true, true]);
    // The plain one reuses the young requested row; only the forced one asks.
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("lifts every hold on the space, since only an explicit request gets here", async () => {
    markManualStop(PROJECT_ID);
    markRestoredAwaitingIntent(PROJECT_ID);
    markIdlePaused(PROJECT_ID);
    try {
      await act(async () => {
        await ensureHostedRuntime!();
      });
      expect(isManualStopHeld(PROJECT_ID)).toBe(false);
      expect(isRestoredAwaitingIntent(PROJECT_ID)).toBe(false);
      expect(isIdlePaused(PROJECT_ID)).toBe(false);
    } finally {
      clearManualStop(PROJECT_ID);
      clearRestoredAwaitingIntent(PROJECT_ID);
      clearIdlePaused(PROJECT_ID);
    }
  });

  it("lifts the hold a Stop kept after an error answer", async () => {
    const hold = markManualStop(PROJECT_ID);
    try {
      await expect(
        stopUnderManualHold(PROJECT_ID, hold, async () => {
          throw new ControllerApiError({ status: 500, message: "failed to finalize runtime stop", code: null, details: null });
        }),
      ).rejects.toThrow("failed to finalize runtime stop");
      expect(isManualStopHeld(PROJECT_ID)).toBe(true);

      await act(async () => {
        await ensureHostedRuntime!();
      });
      expect(isManualStopHeld(PROJECT_ID)).toBe(false);
    } finally {
      clearManualStop(PROJECT_ID);
    }
  });

  it("asks the controller to replace a stalled launch only on the retry that says so", async () => {
    await act(async () => {
      await ensureHostedRuntime!({ force: true, replaceStalledLaunch: true });
    });
    await act(async () => {
      await ensureHostedRuntime!({ force: true });
    });

    expect(ensure).toHaveBeenCalledTimes(2);
    expect(ensure.mock.calls[0][0]).toMatchObject({ provider: "instafy-cloud", replaceStalledLaunch: true });
    expect(ensure.mock.calls[1][0]).not.toHaveProperty("replaceStalledLaunch");
  });

  it("answers a failed retry in plain words unless the refusal already explained itself", async () => {
    const retry = async () => {
      let result: boolean | undefined;
      await act(async () => {
        result = await ensureHostedRuntime!({ force: true, replaceStalledLaunch: true });
      });
      return result;
    };

    ensure.mockRejectedValue(new Error("provider launch failed"));
    await expect(retry()).resolves.toBe(false);
    expect(showStatus).toHaveBeenCalledWith(STALLED_LAUNCH_RETRY_FAILED_MESSAGE, "warning", 5000);
    // One press, one replacement request: no immediate second attempt.
    expect(ensure).toHaveBeenCalledTimes(1);

    // Credits and capacity carry their own message and action.
    for (const code of ["insufficient_credits", "platform_at_capacity"]) {
      showStatus.mockReset();
      ensure.mockRejectedValue(Object.assign(new Error(`refused: ${code}`), { code }));
      await expect(retry()).resolves.toBe(false);
      expect(showStatus).toHaveBeenCalledTimes(1);
      expect(showStatus).not.toHaveBeenCalledWith(STALLED_LAUNCH_RETRY_FAILED_MESSAGE, "warning", 5000);
    }

    // The runtime limit is explained where the message waits.
    showStatus.mockReset();
    ensure.mockRejectedValue(
      Object.assign(new Error("Runtime limit reached"), {
        code: "runtime_limit_reached",
        details: { activeCount: 1, maxActiveCount: 1 },
      }),
    );
    await expect(retry()).resolves.toBe(false);
    expect(showStatus).not.toHaveBeenCalled();

    // An ordinary forced ensure keeps its old, quiet failure and its
    // immediate second attempt.
    ensure.mockClear();
    ensure.mockRejectedValue(new Error("provider launch failed"));
    let result: boolean | undefined;
    await act(async () => {
      result = await ensureHostedRuntime!({ force: true });
    });
    expect(result).toBe(false);
    expect(showStatus).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});
