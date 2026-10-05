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

import { useHostedRuntimeEnsure } from "../useHostedRuntimeEnsure";

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
});
