import { describe, expect, it } from "vitest";
import { resolveAgentWaitingActivityCopy } from "../runtimeAlertPresentation";
import { COMPACTION_STATUS_LABEL, resolveSingleAgentTypingStatus } from "../typingIndicatorState";

const waiting = resolveAgentWaitingActivityCopy({ displayNames: ["Octo"], workspaceStarting: false, queued: false });

describe("the typing row before a turn's first step", () => {
  // A local test: a turn's typing row read "Starting…", then "Thinking…" 3 s
  // later, before its first step; another showed "Trying again…" for 0.8 s.
  it("says Starting… however long the turn takes to its first step, retries included", () => {
    for (const state of [
      { phase: "waiting" as const, label: null },
      { phase: "thinking" as const, label: "Thinking…" },
      { phase: "thinking" as const, label: "Trying again…" },
      { phase: "typing" as const, label: null },
      { phase: "finalizing" as const, label: null },
      null,
    ]) {
      for (const runStatus of ["queued", "in_progress", null] as const) {
        expect(resolveSingleAgentTypingStatus({ state, runStatus, agentName: "Octo", waiting }), JSON.stringify(state)).toEqual({
          label: "Starting…",
          ariaLabel: "Octo is starting",
        });
      }
    }
  });

  it("says a run held for an approval waits for it, and a context rewrite what it is", () => {
    expect(
      resolveSingleAgentTypingStatus({
        state: { phase: "waiting", label: "Waiting for approval to continue…" },
        runStatus: "awaiting_approval",
        agentName: "Octo",
        waiting,
      }),
    ).toEqual({ label: "Waiting for approval to continue…", ariaLabel: "Octo status: Waiting for approval to continue…" });
    expect(
      resolveSingleAgentTypingStatus({
        state: { phase: "compacting", label: COMPACTION_STATUS_LABEL },
        runStatus: "in_progress",
        agentName: "Octo",
        waiting,
      }).label,
    ).toBe(COMPACTION_STATUS_LABEL);
  });

  it("keeps the runtime-busy notice, which asks the person to act", () => {
    const busy = resolveAgentWaitingActivityCopy({
      displayNames: ["Octo"],
      workspaceStarting: true,
      queued: true,
      runtimeLimit: { limitReached: true, blockerProjectLabel: "Space B", blockerRuntimeLabel: null },
    });
    expect(
      resolveSingleAgentTypingStatus({ state: { phase: "waiting", label: null }, runStatus: "queued", agentName: "Octo", waiting: busy })
        .label,
    ).toBe(busy.label);
  });
});
