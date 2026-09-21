import { describe, expect, it } from "vitest";

import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import {
  resolveHostedStatusPollInterval,
  shouldAutoEnsureHostedForEmptyState,
  shouldAutoEnsureHostedForFallback,
  shouldAutoEnsurePreferredHostedRuntime,
  shouldPollHostedBootingRuntime,
} from "../hostedRuntimeRecoveryDecisions";

function createRuntimeEntry(
  overrides: Partial<ControllerRuntimeStatusEntry> = {},
): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "runtime-1",
    status: "ready",
    provider: "instafy-cloud",
    idleTtlSeconds: 60,
    isLocal: false,
    isPreferred: false,
    health: "online",
    ...overrides,
  };
}

describe("hostedRuntimeRecoveryDecisions", () => {
  it("polls more aggressively while a hosted runtime is booting", () => {
    expect(
      shouldPollHostedBootingRuntime({
        runtimeControllerEnabled: true,
        activeProjectId: "project-1",
        projectReadyForRuntime: true,
        runtimeStatuses: [
          createRuntimeEntry({
            status: "launching",
            health: "offline",
          }),
        ],
        runtimeReady: false,
      }),
    ).toBe(true);

    expect(
      resolveHostedStatusPollInterval({
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        waitingForPreferredRuntime: false,
      }),
    ).toBe(15_000);

    expect(
      resolveHostedStatusPollInterval({
        hostedRuntimeEnsuring: true,
        hasHostedRuntimeInProgress: false,
        waitingForPreferredRuntime: false,
      }),
    ).toBe(5_000);
  });

  it("auto-ensures a hosted runtime for empty fallback states only when allowed", () => {
    expect(
      shouldAutoEnsureHostedForFallback({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: false,
        projectReadyForRuntime: true,
        runtimeControllerEnabled: true,
        activeProjectId: "project-1",
        runtimeReady: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        preferredRuntimeId: null,
        readyRuntimeCount: 0,
        runtimeStatusesResolved: true,
      }),
    ).toBe(true);

    expect(
      shouldAutoEnsureHostedForEmptyState({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: false,
        projectAccessResolved: true,
        runtimeControllerEnabled: true,
        activeProjectId: "project-1",
        runtimeReady: false,
        runtimeStatusesResolved: true,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        runtimeStatusCount: 0,
      }),
    ).toBe(true);

    // A brand-new project that is still materializing its workspace must
    // still warm the runtime: boot and workspace init are independent, and
    // serializing them costs every first reply ~10 seconds.
    expect(
      shouldAutoEnsureHostedForEmptyState({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: false,
        projectAccessResolved: true,
        runtimeControllerEnabled: true,
        activeProjectId: "project-just-created",
        runtimeReady: false,
        runtimeStatusesResolved: true,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        runtimeStatusCount: 0,
      }),
    ).toBe(true);

    // Pending or blocked access must never launch a runtime.
    expect(
      shouldAutoEnsureHostedForEmptyState({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: false,
        projectAccessResolved: false,
        runtimeControllerEnabled: true,
        activeProjectId: "project-1",
        runtimeReady: false,
        runtimeStatusesResolved: true,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        runtimeStatusCount: 0,
      }),
    ).toBe(false);

    expect(
      shouldAutoEnsureHostedForFallback({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: false,
        projectReadyForRuntime: true,
        runtimeControllerEnabled: true,
        activeProjectId: "project-1",
        runtimeReady: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: true,
        preferredRuntimeId: null,
        readyRuntimeCount: 0,
        runtimeStatusesResolved: true,
      }),
    ).toBe(false);
  });

  it("auto-restarts a preferred hosted runtime only when it is actually offline", () => {
    expect(
      shouldAutoEnsurePreferredHostedRuntime({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: false,
        runtimeControllerEnabled: true,
        projectReadyForRuntime: true,
        activeProjectId: "project-1",
        preferredRuntimeEntry: createRuntimeEntry({
          status: "stopped",
          health: "offline",
        }),
        waitingForPreferredRuntime: true,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
      }),
    ).toBe(true);

    expect(
      shouldAutoEnsurePreferredHostedRuntime({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: false,
        runtimeControllerEnabled: true,
        projectReadyForRuntime: true,
        activeProjectId: "project-1",
        preferredRuntimeEntry: createRuntimeEntry({
          status: "running",
          health: "online",
        }),
        waitingForPreferredRuntime: true,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
      }),
    ).toBe(false);
  });

  it("does not relaunch a machine the user stopped on purpose", () => {
    // A user Stop produces exactly the state auto-ensure exists to repair:
    // no ready machine, nothing booting, no local runtime. The hold is the
    // only thing that says the absence is intentional.
    expect(
      shouldAutoEnsureHostedForFallback({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: true,
        projectReadyForRuntime: true,
        runtimeControllerEnabled: true,
        activeProjectId: "project-1",
        runtimeReady: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        preferredRuntimeId: null,
        readyRuntimeCount: 0,
        runtimeStatusesResolved: true,
      }),
    ).toBe(false);

    expect(
      shouldAutoEnsureHostedForEmptyState({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: true,
        projectAccessResolved: true,
        runtimeControllerEnabled: true,
        activeProjectId: "project-1",
        runtimeReady: false,
        runtimeStatusesResolved: true,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        runtimeStatusCount: 0,
      }),
    ).toBe(false);

    // A stopped preferred machine is normally restartable; not after a Stop.
    expect(
      shouldAutoEnsurePreferredHostedRuntime({
        disableAutoRuntimeEnsure: false,
        manualStopHeld: true,
        runtimeControllerEnabled: true,
        projectReadyForRuntime: true,
        activeProjectId: "project-1",
        preferredRuntimeEntry: createRuntimeEntry({
          status: "stopped",
          health: "offline",
        }),
        waitingForPreferredRuntime: true,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
      }),
    ).toBe(false);
  });
});
