import { describe, expect, it } from "vitest";

import type { ControllerRuntimeStatusEntry } from "../../../sdk/instafy";
import {
  resolveEffectiveRuntimeSelection,
  resolveLastReadyHostedRuntime,
  resolveRuntimeReady,
  resolveShouldPromptCloudFallback,
  sortRuntimeStatuses,
} from "../hostedRuntimePolicySelectors";

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

describe("hostedRuntimePolicySelectors", () => {
  it("sorts healthier runtimes first and prefers cloud runtimes when requested", () => {
    const sorted = sortRuntimeStatuses(
      [
        createRuntimeEntry({
          runtimeId: "local-idle",
          isLocal: true,
          provider: "desktop",
          health: "idle",
        }),
        createRuntimeEntry({
          runtimeId: "cloud-online",
          health: "online",
        }),
        createRuntimeEntry({
          runtimeId: "local-online",
          isLocal: true,
          provider: "desktop",
          health: "online",
        }),
      ],
      true,
    );

    expect(sorted.map((entry) => entry.runtimeId)).toEqual([
      "cloud-online",
      "local-online",
      "local-idle",
    ]);
  });

  it("resolves the effective runtime source and readiness consistently", () => {
    const session = resolveEffectiveRuntimeSelection({
      sessionRuntimeId: "runtime-session",
      preferredRuntimeId: "runtime-pref",
    });
    const preference = resolveEffectiveRuntimeSelection({
      sessionRuntimeId: null,
      preferredRuntimeId: "runtime-pref",
    });
    const auto = resolveEffectiveRuntimeSelection({
      sessionRuntimeId: null,
      preferredRuntimeId: null,
    });

    expect(session).toEqual({
      effectiveRuntimeId: "runtime-session",
      effectiveRuntimeSource: "session",
    });
    expect(preference.effectiveRuntimeSource).toBe("preference");
    expect(auto.effectiveRuntimeSource).toBe("auto");

    expect(
      resolveRuntimeReady({
        waitingForPreferredRuntime: false,
        effectiveRuntimeSource: "session",
        sessionRuntimeEntry: createRuntimeEntry({ runtimeId: "runtime-session" }),
        preferredRuntimeEntry: null,
        readyRuntimeEntries: [],
      }),
    ).toBe(true);

    expect(
      resolveRuntimeReady({
        waitingForPreferredRuntime: true,
        effectiveRuntimeSource: "preference",
        sessionRuntimeEntry: null,
        preferredRuntimeEntry: createRuntimeEntry({ runtimeId: "runtime-pref" }),
        readyRuntimeEntries: [createRuntimeEntry({ runtimeId: "runtime-pref" })],
      }),
    ).toBe(false);
  });

  it("prompts cloud fallback only for the unresolved no-runtime cases", () => {
    expect(
      resolveShouldPromptCloudFallback({
        preferredPromptDismissed: false,
        sessionRuntimeId: null,
        waitingForPreferredRuntime: false,
        runtimeReady: false,
        readyRuntimeCount: 0,
        preferredRuntimeId: "runtime-pref",
        hasLocalRuntime: false,
      }),
    ).toBe(true);

    expect(
      resolveShouldPromptCloudFallback({
        preferredPromptDismissed: false,
        sessionRuntimeId: "runtime-session",
        waitingForPreferredRuntime: false,
        runtimeReady: false,
        readyRuntimeCount: 0,
        preferredRuntimeId: "runtime-pref",
        hasLocalRuntime: false,
      }),
    ).toBe(false);

    expect(
      resolveShouldPromptCloudFallback({
        preferredPromptDismissed: false,
        sessionRuntimeId: null,
        waitingForPreferredRuntime: false,
        runtimeReady: true,
        readyRuntimeCount: 1,
        preferredRuntimeId: null,
        hasLocalRuntime: false,
      }),
    ).toBe(false);
  });

  it("tracks the most recent ready hosted runtime for the active project", () => {
    expect(
      resolveLastReadyHostedRuntime({
        activeProjectId: "project-1",
        sessionRuntimeEntry: createRuntimeEntry({
          runtimeId: "runtime-local",
          isLocal: true,
          provider: "desktop",
        }),
        preferredRuntimeEntry: null,
        readyRuntimeEntries: [
          createRuntimeEntry({ runtimeId: "runtime-cloud" }),
          createRuntimeEntry({
            runtimeId: "runtime-local",
            isLocal: true,
            provider: "desktop",
          }),
        ],
      }),
    ).toEqual({
      projectId: "project-1",
      runtimeId: "runtime-cloud",
    });
  });
});
