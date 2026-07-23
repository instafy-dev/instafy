import { describe, expect, it } from "vitest";
import {
  shouldAttemptUnexpectedHostedRuntimeRecovery,
  shouldTrackHostedRuntimeLifecycleEvent,
  UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS,
} from "../unexpectedHostedRuntimeRecovery";

describe("unexpectedHostedRuntimeRecovery", () => {
  it("tracks origin expiry and unexpected hosted runtime stops", () => {
    expect(
      shouldTrackHostedRuntimeLifecycleEvent({
        kind: "origin.expired",
        projectId: "project-1",
      }),
    ).toBe(true);

    expect(
      shouldTrackHostedRuntimeLifecycleEvent({
        kind: "runtime.stopped",
        projectId: "project-1",
        reason: "heartbeat_timeout",
      }),
    ).toBe(true);
  });

  it("ignores manual runtime stop reasons", () => {
    expect(
      shouldTrackHostedRuntimeLifecycleEvent({
        kind: "runtime.stopped",
        projectId: "project-1",
        reason: "user_stop",
      }),
    ).toBe(false);

    expect(
      shouldTrackHostedRuntimeLifecycleEvent({
        kind: "runtime.stopped",
        projectId: "project-1",
        reason: "runtime_limit_takeover",
      }),
    ).toBe(false);

    expect(
      shouldTrackHostedRuntimeLifecycleEvent({
        kind: "runtime.stopped",
        projectId: "project-1",
        reason: "browser_session_runtime_limit_takeover",
      }),
    ).toBe(false);
  });

  it("attempts recovery only while the project is active and still missing a runtime", () => {
    expect(
      shouldAttemptUnexpectedHostedRuntimeRecovery({
        activeProjectId: "project-1",
        runtimeControllerEnabled: true,
        projectReadyForRuntime: true,
        runtimeReady: false,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        eventProjectId: "project-1",
        eventAgeMs: 1_000,
      }),
    ).toBe(true);

    expect(
      shouldAttemptUnexpectedHostedRuntimeRecovery({
        activeProjectId: "project-1",
        runtimeControllerEnabled: true,
        projectReadyForRuntime: true,
        runtimeReady: true,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        eventProjectId: "project-1",
        eventAgeMs: 1_000,
      }),
    ).toBe(false);

    expect(
      shouldAttemptUnexpectedHostedRuntimeRecovery({
        activeProjectId: "project-1",
        runtimeControllerEnabled: true,
        projectReadyForRuntime: true,
        runtimeReady: false,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: true,
        eventProjectId: "project-1",
        eventAgeMs: 1_000,
      }),
    ).toBe(false);

    expect(
      shouldAttemptUnexpectedHostedRuntimeRecovery({
        activeProjectId: "project-1",
        runtimeControllerEnabled: true,
        projectReadyForRuntime: true,
        runtimeReady: false,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        eventProjectId: "project-2",
        eventAgeMs: 1_000,
      }),
    ).toBe(false);

    expect(
      shouldAttemptUnexpectedHostedRuntimeRecovery({
        activeProjectId: "project-1",
        runtimeControllerEnabled: true,
        projectReadyForRuntime: true,
        runtimeReady: false,
        hostedRuntimeEnsuring: false,
        hasHostedRuntimeInProgress: false,
        hasLocalRuntime: false,
        eventProjectId: "project-1",
        eventAgeMs: UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS + 1,
      }),
    ).toBe(false);
  });
});
