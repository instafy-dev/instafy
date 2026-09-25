import { describe, expect, it } from "vitest";
import type { RunRecord } from "../../types";
import {
  hasPendingRunInProject,
  isRuntimeLimitReclaimStopReason,
  shouldAttemptUnexpectedHostedRuntimeRecovery,
  shouldTrackHostedRuntimeLifecycleEvent,
  UNEXPECTED_HOSTED_RUNTIME_RECOVERY_WINDOW_MS,
} from "../unexpectedHostedRuntimeRecovery";

function run(id: string, projectId: string, status: RunRecord["status"]): RunRecord {
  return {
    id,
    projectId,
    sessionId: null,
    conversationId: null,
    promptId: null,
    runType: "prompt",
    status,
    progress: 0,
    progressStage: null,
    previewUrl: null,
    lastMessage: null,
    metadata: null,
    createdAt: null,
    updatedAt: null,
  };
}

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

  it("holds a runtime-limit reclaim stop unless this client has work of its own there", () => {
    for (const reason of ["runtime_limit_reclaim", "idle_runtime_limit_reclaim", " Runtime_Limit_Reclaim "]) {
      expect(isRuntimeLimitReclaimStopReason(reason)).toBe(true);
      expect(
        shouldTrackHostedRuntimeLifecycleEvent({
          kind: "runtime.stopped",
          projectId: "project-1",
          reason,
        }),
      ).toBe(false);
      expect(
        shouldTrackHostedRuntimeLifecycleEvent({
          kind: "runtime.stopped",
          projectId: "project-1",
          reason,
          hasPendingWork: false,
        }),
      ).toBe(false);
      expect(
        shouldTrackHostedRuntimeLifecycleEvent({
          kind: "runtime.stopped",
          projectId: "project-1",
          reason,
          hasPendingWork: true,
        }),
      ).toBe(true);
    }
    // Pending work never overrides a deliberate stop the user asked for.
    expect(
      shouldTrackHostedRuntimeLifecycleEvent({
        kind: "runtime.stopped",
        projectId: "project-1",
        reason: "user_stop",
        hasPendingWork: true,
      }),
    ).toBe(false);
    expect(isRuntimeLimitReclaimStopReason("runtime_limit_takeover")).toBe(false);
    expect(isRuntimeLimitReclaimStopReason(null)).toBe(false);
  });

  it("counts only this space's queued or open runs as pending work", () => {
    const runs = {
      done: run("done", "project-1", "success"),
      failed: run("failed", "project-1", "failed"),
      elsewhere: run("elsewhere", "project-2", "in_progress"),
    };
    expect(hasPendingRunInProject(runs, "project-1")).toBe(false);
    expect(hasPendingRunInProject(runs, "project-2")).toBe(true);
    for (const status of ["queued", "in_progress", "awaiting_approval"] as const) {
      expect(
        hasPendingRunInProject({ ...runs, open: run("open", "project-1", status) }, "project-1"),
      ).toBe(true);
    }
    expect(hasPendingRunInProject(runs, null)).toBe(false);
    expect(hasPendingRunInProject(null, "project-1")).toBe(false);
  });
});
