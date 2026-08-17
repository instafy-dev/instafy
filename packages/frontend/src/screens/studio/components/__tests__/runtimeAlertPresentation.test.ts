import { describe, expect, it } from "vitest";

import {
  isRecoverableRuntimeStartAlert,
  resolveAgentWaitingActivityCopy,
} from "../runtimeAlertPresentation";

describe("isRecoverableRuntimeStartAlert", () => {
  it("recognizes the legacy queued-runtime copy as recoverable", () => {
    expect(
      isRecoverableRuntimeStartAlert(
        { reason: "runtime_not_ready" },
        "Runtime agent has not connected yet. Start the runtime so queued jobs can proceed.",
      ),
    ).toBe(true);
  });
});

describe("resolveAgentWaitingActivityCopy", () => {
  it("reserves workspace-starting copy for a real cold-start state", () => {
    expect(
      resolveAgentWaitingActivityCopy({
        displayNames: ["Octo"],
        workspaceStarting: true,
        queued: true,
      }),
    ).toEqual({
      label: "Octo is starting its workspace…",
      ariaLabel: "Octo is starting its workspace",
    });
  });

  it("describes a ready-runtime queue as waiting for a turn", () => {
    expect(
      resolveAgentWaitingActivityCopy({
        displayNames: ["Octo"],
        workspaceStarting: false,
        queued: true,
      }),
    ).toEqual({
      label: "Octo is waiting for its turn…",
      ariaLabel: "Octo is waiting for its turn",
    });
  });

  it("uses neutral copy while no run state has arrived", () => {
    expect(
      resolveAgentWaitingActivityCopy({
        displayNames: ["Octo"],
        workspaceStarting: false,
        queued: false,
      }).label,
    ).toBe("Octo is getting ready…");
  });
});

describe("resolveAgentWaitingActivityCopy runtime slot wall", () => {
  it("names the blocking project instead of pretending to start", () => {
    const copy = resolveAgentWaitingActivityCopy({
      displayNames: ["Octo"],
      workspaceStarting: true,
      queued: true,
      runtimeLimit: {
        limitReached: true,
        blockerProjectLabel: "My other app",
        blockerRuntimeLabel: null,
      },
    });
    expect(copy.label).toContain('"My other app"');
    expect(copy.label).toContain("Stop it there");
    expect(copy.label).not.toContain("starting its workspace");
  });

  it("falls back to a generic location when the blocker is unnamed", () => {
    const copy = resolveAgentWaitingActivityCopy({
      displayNames: ["Octo"],
      workspaceStarting: false,
      queued: true,
      runtimeLimit: {
        limitReached: true,
        blockerProjectLabel: null,
        blockerRuntimeLabel: null,
      },
    });
    expect(copy.label).toContain("another project");
  });

  it("keeps the ordinary copy when no limit is reached", () => {
    const copy = resolveAgentWaitingActivityCopy({
      displayNames: ["Octo"],
      workspaceStarting: true,
      queued: false,
      runtimeLimit: null,
    });
    expect(copy.label).toContain("starting its workspace");
  });
});
