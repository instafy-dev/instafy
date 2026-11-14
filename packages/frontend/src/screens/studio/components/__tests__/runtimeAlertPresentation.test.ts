import { describe, expect, it } from "vitest";

import {
  isRecoverableRuntimeStartAlert,
  isRuntimeAlertSupersededByStart,
  RUNTIME_ALERT_SUPERSEDE_GRACE_MS,
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

describe("isRuntimeAlertSupersededByStart", () => {
  const since = 1_700_000_000_000;

  it("never demotes without a live workspace start", () => {
    expect(
      isRuntimeAlertSupersededByStart({
        alertTimestamp: since - 60 * 60 * 1000,
        workspaceStarting: false,
        workspaceStartingSince: null,
      }),
    ).toBe(false);
    expect(
      isRuntimeAlertSupersededByStart({
        alertTimestamp: since - 60 * 60 * 1000,
        workspaceStarting: false,
        workspaceStartingSince: since,
      }),
    ).toBe(false);
  });

  it("never demotes when the start has no recorded edge", () => {
    expect(
      isRuntimeAlertSupersededByStart({
        alertTimestamp: since - 60 * 60 * 1000,
        workspaceStarting: true,
        workspaceStartingSince: null,
      }),
    ).toBe(false);
  });

  it("keeps an alert produced by the live start itself at full volume", () => {
    expect(
      isRuntimeAlertSupersededByStart({
        alertTimestamp: since + 2_000,
        workspaceStarting: true,
        workspaceStartingSince: since,
      }),
    ).toBe(false);
    expect(
      isRuntimeAlertSupersededByStart({
        alertTimestamp: since - RUNTIME_ALERT_SUPERSEDE_GRACE_MS + 1,
        workspaceStarting: true,
        workspaceStartingSince: since,
      }),
    ).toBe(false);
  });

  it("demotes an alert that clearly predates the live start", () => {
    expect(
      isRuntimeAlertSupersededByStart({
        alertTimestamp: since - RUNTIME_ALERT_SUPERSEDE_GRACE_MS - 1,
        workspaceStarting: true,
        workspaceStartingSince: since,
      }),
    ).toBe(true);
    expect(
      isRuntimeAlertSupersededByStart({
        alertTimestamp: since - 45 * 60 * 1000,
        workspaceStarting: true,
        workspaceStartingSince: since,
      }),
    ).toBe(true);
  });

  it("keeps an alert without a usable timestamp visible", () => {
    expect(
      isRuntimeAlertSupersededByStart({
        alertTimestamp: undefined,
        workspaceStarting: true,
        workspaceStartingSince: since,
      }),
    ).toBe(false);
  });
});

describe("resolveAgentWaitingActivityCopy", () => {
  // A local test: "Octo is starting its workspace…", "Octo is waiting for its
  // turn…" and "Thinking…" inside 1.1 s. A turn opens with one label.
  it("says Starting… whether the workspace starts, the turn waits or no run state has arrived", () => {
    for (const state of [
      { workspaceStarting: true, queued: true },
      { workspaceStarting: true, queued: false },
      { workspaceStarting: false, queued: true },
      { workspaceStarting: false, queued: false },
    ]) {
      expect(resolveAgentWaitingActivityCopy({ displayNames: ["Octo"], ...state }), JSON.stringify(state)).toEqual({
        label: "Starting…",
        ariaLabel: "Octo is starting",
      });
    }
    expect(
      resolveAgentWaitingActivityCopy({ displayNames: ["Octo", "Reviewer"], workspaceStarting: true, queued: false }),
    ).toEqual({ label: "Starting…", ariaLabel: "Octo, Reviewer are starting" });
  });

  // docs/Local-Engine-Turns.md 5.7: a turn a turn engine runs words its own
  // start, for whoever views it (newestTurnEngineStartingLine). It runs on
  // its sender's computer, so a cloud runtime's slot wall is never what it
  // waits on.
  it("says a turn engine's own words for its turn, also over the runtime slot wall", () => {
    const startingLine = "Starting Claude Code on this computer…";
    expect(
      resolveAgentWaitingActivityCopy({
        displayNames: ["Octo"],
        workspaceStarting: false,
        queued: true,
        turnEngineStartingLine: startingLine,
      }),
    ).toEqual({ label: startingLine, ariaLabel: `Octo: ${startingLine}` });
    expect(
      resolveAgentWaitingActivityCopy({
        displayNames: ["Octo"],
        workspaceStarting: true,
        queued: true,
        runtimeLimit: { limitReached: true, blockerProjectLabel: "My other app", blockerRuntimeLabel: null },
        turnEngineStartingLine: startingLine,
      }).label,
    ).toBe(startingLine);
    expect(
      resolveAgentWaitingActivityCopy({
        displayNames: ["Octo"],
        workspaceStarting: false,
        queued: false,
        turnEngineStartingLine: null,
      }).label,
    ).toBe("Starting…");
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
    expect(copy.label).not.toContain("Starting");
  });

  it("promises the send with the controller's give-up bound", () => {
    const copy = resolveAgentWaitingActivityCopy({
      displayNames: ["Octo"],
      workspaceStarting: false,
      queued: true,
      runtimeLimit: {
        limitReached: true,
        blockerProjectLabel: "My other app",
        blockerRuntimeLabel: null,
      },
    });
    expect(copy.label).toContain("sends once a runtime is free");
    expect(copy.label).toContain("waits up to 30 minutes");
    expect(copy.ariaLabel).toBe(copy.label);
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
    expect(copy.label).toBe("Starting…");
  });
});
