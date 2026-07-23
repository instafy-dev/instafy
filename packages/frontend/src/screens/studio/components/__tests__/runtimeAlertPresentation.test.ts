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
