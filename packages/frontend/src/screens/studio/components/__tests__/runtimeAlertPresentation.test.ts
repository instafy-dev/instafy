import { describe, expect, it } from "vitest";

import { resolveControllerConversationNoticeContent } from "../controllerConversationNotice";
import {
  isRecoverableRuntimeStartAlert,
  isRuntimeAlertSupersededByStart,
  RUNTIME_ALERT_SUPERSEDE_GRACE_MS,
  resolveAgentWaitingActivityCopy,
  resolveWorkspaceStarting,
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

  // What the controller stores for a notice that is not a start in progress
  // (runtime_alert_fallback_message and RUNTIME_LIMIT_WAIT_MESSAGE in
  // dispatch.rs). A notice with no status is read by its text alone.
  it("reads the controller's stored terminal sentences as terminal", () => {
    for (const stored of [
      "Workspace startup failed. Open Machines to reconnect this space's machine.",
      "No machine is connected to this space. Open Machines to start one.",
      "Instafy couldn't check this space's machine. Open Machines to inspect or reconnect it.",
      "Instafy couldn't reach this space's machine. Open Machines to inspect or reconnect it.",
      "Waiting for a free hosted machine. All of this team’s hosted machines are in use; stop one in Machines and this request will send.",
    ]) {
      expect(isRecoverableRuntimeStartAlert({ reason: "runtime_not_ready" }, stored), stored).toBe(false);
    }
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
  it("says Starting… while the workspace starts, queued or not", () => {
    for (const state of [
      { workspaceStarting: true, queued: true },
      { workspaceStarting: true, queued: false },
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

  // Every turn used to open with "Starting…", also when the space's machine
  // was already running and nothing started. On a running machine the turn is
  // the model at work from the send, also while it waits for its lease or
  // behind another turn, and before its run state arrives.
  it("says Thinking… on a running machine, whether the turn waits or no run state has arrived", () => {
    for (const state of [
      { workspaceStarting: false, queued: true },
      { workspaceStarting: false, queued: false },
    ]) {
      expect(resolveAgentWaitingActivityCopy({ displayNames: ["Octo"], ...state }), JSON.stringify(state)).toEqual({
        label: "Thinking…",
        ariaLabel: "Octo is thinking",
      });
    }
    expect(
      resolveAgentWaitingActivityCopy({ displayNames: ["Octo", "Reviewer"], workspaceStarting: false, queued: false }),
    ).toEqual({ label: "Thinking…", ariaLabel: "Octo, Reviewer are thinking" });
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
    ).toBe("Thinking…");
    expect(
      resolveAgentWaitingActivityCopy({
        displayNames: ["Octo"],
        workspaceStarting: true,
        queued: false,
        turnEngineStartingLine: null,
      }).label,
    ).toBe("Starting…");
  });
});

// The send that found the space's machine stopped read nothing for 3 s and
// then "Starting…", and every other turn read "Starting…" too. The chat now
// knows from its own machine status which word is true, before the
// controller answers the send.
describe("resolveWorkspaceStarting", () => {
  const base = {
    waitingForPreferredRuntime: false,
    hostedRuntimeEnsuring: false,
    runtimeReady: true,
    activeRunStatus: null,
    turnPending: true,
  };

  it("is false on a running machine, from the send to the reply", () => {
    for (const activeRunStatus of [null, "queued", "in_progress"]) {
      expect(resolveWorkspaceStarting({ ...base, activeRunStatus }), String(activeRunStatus)).toBe(false);
    }
  });

  it("is true while a send or a queued run waits for a machine that is not up", () => {
    // The send is still on its way, or its run's record has not arrived.
    expect(resolveWorkspaceStarting({ ...base, runtimeReady: false })).toBe(true);
    expect(resolveWorkspaceStarting({ ...base, runtimeReady: false, activeRunStatus: "queued" })).toBe(true);
    // A queued run says so also for a viewer whose page sent nothing.
    expect(resolveWorkspaceStarting({ ...base, runtimeReady: false, activeRunStatus: "queued", turnPending: false })).toBe(true);
    // A start this page asked for, whatever the machine status still says.
    expect(resolveWorkspaceStarting({ ...base, hostedRuntimeEnsuring: true })).toBe(true);
    expect(resolveWorkspaceStarting({ ...base, waitingForPreferredRuntime: true })).toBe(true);
  });

  it("is false once the run is at work, or when no turn waits at all", () => {
    expect(resolveWorkspaceStarting({ ...base, runtimeReady: false, activeRunStatus: "in_progress" })).toBe(false);
    expect(resolveWorkspaceStarting({ ...base, runtimeReady: false, turnPending: false })).toBe(false);
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
    expect(copy.label).toBe(
      'Waiting for a free hosted machine. Stop one in "My other app" and this message sends. It waits up to 30 minutes.',
    );
    expect(copy.label).not.toContain("Starting");
  });

  // The chat's "Waiting for a machine" card opens with the same sentence, in
  // the words the controller stores for it (RUNTIME_LIMIT_WAIT_MESSAGE).
  it("opens with the sentence of the chat's card and says machine, never runtime", () => {
    const card = resolveControllerConversationNoticeContent({
      id: "limit-wait",
      role: "assistant",
      content: "",
      timestamp: 0,
      metadata: {
        source: "controller",
        kind: "runtime_alert",
        details: { reason: "runtime_not_ready", reconnect: { status: "failed", code: "runtime_limit_reached" } },
      },
    });
    const cardOpening = card.slice(0, card.indexOf(".") + 1);
    expect(cardOpening).toBe("Waiting for a free hosted machine.");
    for (const blockerProjectLabel of ["My other app", null]) {
      const copy = resolveAgentWaitingActivityCopy({
        displayNames: ["Octo"],
        workspaceStarting: true,
        queued: true,
        runtimeLimit: { limitReached: true, blockerProjectLabel, blockerRuntimeLabel: "Hosted Runtime" },
      });
      expect(copy.label.startsWith(cardOpening)).toBe(true);
      expect(copy.label).not.toMatch(/runtime|instafy cloud|project/i);
    }
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
    expect(copy.label).toContain("this message sends");
    expect(copy.label).toContain("waits up to 30 minutes");
    expect(copy.ariaLabel).toBe(copy.label);
  });

  // The machine holding the slot can be in this same space, so an unnamed
  // blocker gets no place, and a machine's own name is no place to stop it in.
  it("points to Machines when the blocker's space is unnamed", () => {
    for (const blockerRuntimeLabel of [null, "Hosted Runtime"]) {
      const copy = resolveAgentWaitingActivityCopy({
        displayNames: ["Octo"],
        workspaceStarting: false,
        queued: true,
        runtimeLimit: {
          limitReached: true,
          blockerProjectLabel: null,
          blockerRuntimeLabel,
        },
      });
      expect(copy.label).toBe(
        "Waiting for a free hosted machine. Stop one in Machines and this message sends. It waits up to 30 minutes.",
      );
      expect(copy.label).not.toContain("another");
    }
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
