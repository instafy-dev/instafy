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
        projectInitialized: true,
        projectReadyForRuntime: true,
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

    expect(
      shouldAutoEnsureHostedForFallback({
        disableAutoRuntimeEnsure: false,
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
});
