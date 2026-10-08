// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ControllerApiError } from "../../../services/runtimeController/core";
import {
  HostedRuntimeBlockerSpaceError,
  type HostedRuntimeLimitErrorDetails,
} from "../../hostedRuntimeLimitError";
import { clearManualStop, isManualStopHeld, manualStopHold } from "../../idlePauseRegistry";
import { createInitialRuntimeStoreState } from "../../runtimeStore";

// vi.mock is hoisted above module-level consts, so the spy has to be too.
const { stop } = vi.hoisted(() => ({ stop: vi.fn() }));

vi.mock("../../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../../sdk/instafy")>(
    "../../../sdk/instafy",
  );
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      runtimes: { ...actual.controllerClient.runtimes, stop },
    },
  };
});

import { useHostedRuntimeSelectionState } from "../useHostedRuntimeSelectionState";

const BLOCKER_PROJECT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BLOCKER_RUNTIME_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIMIT_ERROR =
  'Instafy Cloud runtime limit reached for this organization (1 active; max 1). Active runtime "Hosted Runtime" is attached to project "Acme" (project bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, runtime aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa). Stop/remove that runtime, then retry.';

function conflict() {
  return new ControllerApiError({
    status: 409,
    message: "provider-managed runtime is missing its active lease generation",
    code: null,
    details: null,
    url: null,
  });
}

const SAVED = { status: "flushed", unpushedRefs: 0, error: null };

/** The stop fenced the blocker off and requeued its turn, then its release failed or ran out of time. */
function releasePending() {
  return new ControllerApiError({
    status: 502,
    message: "runtime provider cleanup is still pending",
    code: "provider_cleanup_pending",
    details: { flush: SAVED },
    url: null,
  });
}

/** The stop fenced the blocker off, then found that another stop had released it first. */
function releasedByAnotherStop() {
  return new ControllerApiError({
    status: 409,
    message: "runtime lease generation is no longer current",
    code: null,
    details: null,
    url: null,
  });
}

describe("useHostedRuntimeSelectionState takeover", () => {
  let container: HTMLDivElement;
  let root: Root;
  let takeOver: (() => Promise<boolean>) | null = null;
  let refreshRuntimeStatuses: Mock<() => Promise<void>>;
  let ensureHostedRuntime: Mock<(options?: { force?: boolean }) => Promise<boolean>>;
  // Stands in for the ensure hook's ref: the mocked ensure writes what its
  // failure was, the way the real one does before it resolves.
  const lastHostedEnsureLimitRef: { current: HostedRuntimeLimitErrorDetails | null } = {
    current: null,
  };

  function Harness() {
    const result = useHostedRuntimeSelectionState({
      activeProjectId: "current-project",
      state: createInitialRuntimeStoreState(),
      dispatch: vi.fn(),
      runtimeEnsureError: LIMIT_ERROR,
      runtimeEnsureLimit: null,
      refreshRuntimeStatuses,
      ensureHostedRuntime,
      lastHostedEnsureLimitRef,
    });
    takeOver = result.takeOverHostedRuntimeLimit;
    return null;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    stop.mockReset();
    lastHostedEnsureLimitRef.current = null;
    refreshRuntimeStatuses = vi.fn<() => Promise<void>>(async () => {});
    ensureHostedRuntime = vi.fn<(options?: { force?: boolean }) => Promise<boolean>>(async () => true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    clearManualStop(BLOCKER_PROJECT_ID);
    clearManualStop("current-project");
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("stops the blocker, holds its space, then ensures the current project", async () => {
    stop.mockResolvedValue(true);

    let result: boolean | undefined;
    await act(async () => {
      result = await takeOver?.();
    });

    expect(result).toBe(true);
    expect(stop).toHaveBeenCalledWith({
      runtimeId: BLOCKER_RUNTIME_ID,
      reason: "runtime_limit_takeover",
    });
    expect(refreshRuntimeStatuses).toHaveBeenCalledTimes(1);
    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    // The retry is forced: the stale `requested` row this project may still hold must not make it report "starting…" (instafy-dev/instafy#372).
    expect(ensureHostedRuntime).toHaveBeenCalledWith({ force: true });
    // The blocker's space stays stopped; the current project is not held
    // because the user is asking for its machine.
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(true);
    expect(isManualStopHeld("current-project")).toBe(false);
  });

  it("still refreshes and ensures when the controller refuses the stop with 409", async () => {
    stop.mockRejectedValue(conflict());

    let result: boolean | undefined;
    await act(async () => {
      result = await takeOver?.();
    });

    expect(result).toBe(true);
    expect(refreshRuntimeStatuses).toHaveBeenCalledTimes(1);
    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    // The retry is forced: the stale `requested` row this project may still hold must not make it report "starting…" (instafy-dev/instafy#372).
    expect(ensureHostedRuntime).toHaveBeenCalledWith({ force: true });
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(false);
  });

  it("names the blocking space when the 409 stop is followed by the same limit", async () => {
    stop.mockRejectedValue(conflict());
    ensureHostedRuntime.mockImplementation(async () => {
      lastHostedEnsureLimitRef.current = {
        limitReached: true,
        activeCount: 1,
        maxActiveCount: 1,
        blockerRuntimeId: BLOCKER_RUNTIME_ID,
        blockerProjectId: BLOCKER_PROJECT_ID,
        blockerRuntimeLabel: "Hosted Runtime",
        blockerProjectLabel: "Acme",
      };
      return false;
    });

    let thrown: unknown = null;
    await act(async () => {
      try {
        await takeOver?.();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(HostedRuntimeBlockerSpaceError);
    expect((thrown as HostedRuntimeBlockerSpaceError).blockerProjectId).toBe(BLOCKER_PROJECT_ID);
    expect((thrown as Error).message).toBe(
      'The blocking machine in "Acme" can\'t be stopped from here. Open that space and stop it there.',
    );
    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
  });

  it("names the space the retried limit reports, not the one from before the stop", async () => {
    const otherProjectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    stop.mockRejectedValue(conflict());
    ensureHostedRuntime.mockImplementation(async () => {
      lastHostedEnsureLimitRef.current = {
        limitReached: true,
        activeCount: 1,
        maxActiveCount: 1,
        blockerRuntimeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        blockerProjectId: otherProjectId,
        blockerRuntimeLabel: null,
        blockerProjectLabel: "Beta",
      };
      return false;
    });

    let thrown: unknown = null;
    await act(async () => {
      try {
        await takeOver?.();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(HostedRuntimeBlockerSpaceError);
    expect((thrown as HostedRuntimeBlockerSpaceError).blockerProjectId).toBe(otherProjectId);
    expect((thrown as Error).message).toContain('"Beta"');
  });

  it("falls back to the original blocker when the retried limit does not name one", async () => {
    stop.mockRejectedValue(conflict());
    ensureHostedRuntime.mockImplementation(async () => {
      lastHostedEnsureLimitRef.current = {
        limitReached: true,
        activeCount: 1,
        maxActiveCount: 1,
        blockerRuntimeId: null,
        blockerProjectId: null,
        blockerRuntimeLabel: null,
        blockerProjectLabel: null,
      };
      return false;
    });

    let thrown: unknown = null;
    await act(async () => {
      try {
        await takeOver?.();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(HostedRuntimeBlockerSpaceError);
    expect((thrown as HostedRuntimeBlockerSpaceError).blockerProjectId).toBe(BLOCKER_PROJECT_ID);
    expect((thrown as Error).message).toContain('"Acme"');
  });

  it("returns false without naming a space when the retried ensure fails for another reason", async () => {
    stop.mockRejectedValue(conflict());
    // Credits exhausted, capacity, a 5xx: the ensure hook records no limit.
    ensureHostedRuntime.mockImplementation(async () => {
      lastHostedEnsureLimitRef.current = null;
      return false;
    });

    let result: boolean | undefined;
    let thrown: unknown = null;
    await act(async () => {
      try {
        result = await takeOver?.();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeNull();
    expect(result).toBe(false);
    expect(refreshRuntimeStatuses).toHaveBeenCalledTimes(1);
    expect(ensureHostedRuntime).toHaveBeenCalledTimes(1);
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(false);
  });

  it("keeps the blocker's space held when its stop took effect but the release is still pending", async () => {
    stop.mockRejectedValue(releasePending());

    let result: boolean | undefined;
    await act(async () => {
      result = await takeOver?.();
    });

    // The blocker is fenced off; lifting the hold would let that space start
    // it again. The current project still asks for its own machine.
    expect(result).toBe(true);
    expect(refreshRuntimeStatuses).toHaveBeenCalledTimes(1);
    expect(ensureHostedRuntime).toHaveBeenCalledWith({ force: true });
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(true);
    expect(manualStopHold(BLOCKER_PROJECT_ID)?.flush).toEqual(SAVED);
  });

  it("answers a plain false while the pending release still holds the slot", async () => {
    stop.mockRejectedValue(releasePending());
    ensureHostedRuntime.mockImplementation(async () => {
      lastHostedEnsureLimitRef.current = {
        limitReached: true,
        activeCount: 1,
        maxActiveCount: 1,
        blockerRuntimeId: BLOCKER_RUNTIME_ID,
        blockerProjectId: BLOCKER_PROJECT_ID,
        blockerRuntimeLabel: "Hosted Runtime",
        blockerProjectLabel: "Acme",
      };
      return false;
    });

    let result: boolean | undefined;
    let thrown: unknown = null;
    await act(async () => {
      try {
        result = await takeOver?.();
      } catch (error) {
        thrown = error;
      }
    });

    // The stop worked, so the blocking space is not named as one this tab
    // cannot stop; the takeover is simply not done yet.
    expect(thrown).toBeNull();
    expect(result).toBe(false);
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(true);
  });

  it("keeps the blocker's space held when another stop released it first", async () => {
    stop.mockRejectedValue(releasedByAnotherStop());

    let result: boolean | undefined;
    await act(async () => {
      result = await takeOver?.();
    });

    expect(result).toBe(true);
    expect(ensureHostedRuntime).toHaveBeenCalledWith({ force: true });
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(true);
  });

  it("still names the blocking space when that 409 is followed by the same limit", async () => {
    stop.mockRejectedValue(releasedByAnotherStop());
    ensureHostedRuntime.mockImplementation(async () => {
      lastHostedEnsureLimitRef.current = {
        limitReached: true,
        activeCount: 1,
        maxActiveCount: 1,
        blockerRuntimeId: BLOCKER_RUNTIME_ID,
        blockerProjectId: BLOCKER_PROJECT_ID,
        blockerRuntimeLabel: "Hosted Runtime",
        blockerProjectLabel: "Acme",
      };
      return false;
    });

    let thrown: unknown = null;
    await act(async () => {
      try {
        await takeOver?.();
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(HostedRuntimeBlockerSpaceError);
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(true);
  });

  it("gives up on other stop failures without ensuring", async () => {
    stop.mockRejectedValue(
      new ControllerApiError({
        status: 500,
        message: "provider unavailable",
        code: null,
        details: null,
        url: null,
      }),
    );

    let thrown: unknown = null;
    await act(async () => {
      try {
        await takeOver?.();
      } catch (error) {
        thrown = error;
      }
    });

    expect((thrown as Error).message).toBe("provider unavailable");
    expect(thrown).not.toBeInstanceOf(HostedRuntimeBlockerSpaceError);
    expect(refreshRuntimeStatuses).not.toHaveBeenCalled();
    expect(ensureHostedRuntime).not.toHaveBeenCalled();
    // The stop may have fenced the blocker off before that answer, so its
    // space stays held until someone there asks for a machine.
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(true);
  });

  it("keeps the blocker's space held when the stop got no answer", async () => {
    stop.mockRejectedValue(new TypeError("Failed to fetch"));

    let thrown: unknown = null;
    await act(async () => {
      try {
        await takeOver?.();
      } catch (error) {
        thrown = error;
      }
    });

    expect((thrown as Error).message).toBe("Failed to fetch");
    expect(ensureHostedRuntime).not.toHaveBeenCalled();
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(true);
  });

  it("lifts the blocker's hold when the controller refused the stop", async () => {
    stop.mockRejectedValue(
      new ControllerApiError({
        status: 403,
        message: "forbidden",
        code: null,
        details: null,
        url: null,
      }),
    );

    let thrown: unknown = null;
    await act(async () => {
      try {
        await takeOver?.();
      } catch (error) {
        thrown = error;
      }
    });

    expect((thrown as Error).message).toBe("forbidden");
    expect(ensureHostedRuntime).not.toHaveBeenCalled();
    expect(isManualStopHeld(BLOCKER_PROJECT_ID)).toBe(false);
  });
});
