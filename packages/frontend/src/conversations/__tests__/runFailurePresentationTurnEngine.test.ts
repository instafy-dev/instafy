import { describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../services/runtimeController/runtimes";
import {
  describeTurnEngineSteerRefusal,
  isRunFailurePromptAutoResendable,
  readControllerStampedTurnEngine,
  resolveRunFailureAutoRetryDelayMs,
  resolveRunFailurePresentation,
  turnEngineIds,
  usesTurnEngine,
} from "../runFailurePresentation";

// The controller's failure message of an admitted Claude Code turn
// (docs/Local-Engine-Turns.md 2.6): its run's stamps and the copied code.
function laneFailure(code: string | null, extra: Record<string, unknown> = {}) {
  return {
    source: "agent",
    outcome: "failed",
    messageType: "error",
    jobId: "job-lane",
    aiAccessMode: "claude-code",
    claudeCode: { version: 1 },
    managedAiUsed: false,
    ...(code ? { claudeCodeFailure: code } : {}),
    ...extra,
  };
}

const NOT_SIGNED_IN =
  "Claude Code isn't signed in on this computer. Open a terminal, run claude and sign in, then send your message again.";

describe("a failed turn-engine turn", () => {
  it("knows the Claude Code engine from the application's feature modules", () => {
    expect(turnEngineIds()).toContain("claude-code");
  });

  it("is worded by its engine for its code, never by the runtime engine's patterns", () => {
    const presentation = resolveRunFailurePresentation({
      metadata: laneFailure("not_signed_in"),
      content: "Error: authentication_failed (status 401) from https://api.example.test",
    });
    expect(presentation?.kind).toBe("turn_engine");
    expect(presentation?.friendlyText).toBe(NOT_SIGNED_IN);
    expect(presentation?.manageAi).toBeUndefined();
    // Details keep the raw text.
    expect(presentation?.rawText).toBe("Error: authentication_failed (status 401) from https://api.example.test");
    expect(presentation?.turnEngine?.engineId).toBe("claude-code");
    expect(presentation?.turnEngine?.resendLabel).toBe("Send again with Claude Code");
    expect(presentation?.turnEngine?.teammateText("Sam")).toBe(
      "Claude Code couldn't finish this turn on Sam's computer.",
    );
  });

  it("gives the sender the runtime's say, from the status entry of the runtime that ran it", () => {
    const presentation = resolveRunFailurePresentation({ metadata: laneFailure("not_signed_in"), content: "x" });
    const runtime = {
      runtimeId: "runtime-1",
      claudeCode: { ready: true, reason: null, cli: "2.2.0", verified: false, planSignIn: true },
    } as ControllerRuntimeStatusEntry;
    expect(presentation?.turnEngine?.authorText(runtime)).toBe(
      `${NOT_SIGNED_IN} If you're signed in, this newer Claude Code may no longer let other apps use your sign-in.`,
    );
    expect(presentation?.turnEngine?.authorText(null)).toBe(NOT_SIGNED_IN);
  });

  it("keeps its wording when its text reads like a usage limit or a dropped reply", () => {
    for (const content of [
      "You've hit your usage limit. Try again at 5pm.",
      "Codex completed without returning a final assistant message after retry.",
      "unexpected status 502 Bad Gateway: upstream request failed",
    ]) {
      const presentation = resolveRunFailurePresentation({ metadata: laneFailure("crashed"), content });
      expect(presentation?.kind, content).toBe("turn_engine");
      expect(presentation?.friendlyText, content).toBe("Claude Code stopped unexpectedly, so this turn ended.");
    }
  });

  it("shows a first line of anything else only when it reads plainly", () => {
    const plainLine = resolveRunFailurePresentation({
      metadata: laneFailure(null),
      content: "Prompt is too long\nmore detail",
    });
    expect(plainLine?.friendlyText).toBe("Claude Code stopped with an error: Prompt is too long");
    for (const content of [
      "runtime exited with status 1",
      "Switch to another model",
      "request to https://api.example.test failed",
      "job 0f0e0d0c-1111-4222-8333-444455556666 failed",
    ]) {
      expect(resolveRunFailurePresentation({ metadata: laneFailure(null), content })?.friendlyText, content).toBe(
        "Claude Code stopped with an error.",
      );
    }
  });

  it("covers the failures a sweep or a runtime stop writes, which carry the mode and the code", () => {
    const presentation = resolveRunFailurePresentation({
      metadata: { aiAccessMode: "claude-code", claudeCodeFailure: "start_by_passed", outcome: "failed", jobId: "job-lane" },
      content: "This turn didn't start in time.",
    });
    expect(presentation?.kind).toBe("turn_engine");
    expect(presentation?.friendlyText).toBe("This Claude Code turn didn't start in time, so it won't run. Send it again.");
  });

  it("leaves every other failure as it was", () => {
    const managed = resolveRunFailurePresentation({
      metadata: { source: "agent", outcome: "failed", jobId: "job-1", aiAccessMode: "managed" },
      content: "Codex completed without returning a final assistant message after retry.",
    });
    expect(managed?.kind).toBe("missing_final_message");
    expect(managed?.turnEngine).toBeUndefined();
    // An engine id this Studio does not know is no turn engine's.
    const unknown = resolveRunFailurePresentation({
      metadata: { source: "agent", outcome: "failed", jobId: "job-1", aiAccessMode: "other-engine" },
      content: "Something odd happened",
    });
    expect(unknown?.kind).toBe("generic");
    expect(unknown?.friendlyText).toBe("Something odd happened");
    // Not a failure at all: nothing to present.
    expect(resolveRunFailurePresentation({ metadata: { aiAccessMode: "claude-code" }, content: "Done." })).toBeNull();
  });

  it("is never sent again automatically, whatever its text", () => {
    const presentation = resolveRunFailurePresentation({
      metadata: laneFailure("crashed"),
      content: "Codex completed without returning a final assistant message after retry.",
    });
    expect(presentation).not.toBeNull();
    expect(resolveRunFailureAutoRetryDelayMs({ presentation: presentation! })).toBeNull();
  });
});

describe("a turn-engine prompt", () => {
  it("is never resent automatically: the sender's copy with the claim, the controller's stamped copy, or any claim", () => {
    expect(isRunFailurePromptAutoResendable({ content: "Fix the test", metadata: { turnEngine: "claude-code" } })).toBe(false);
    expect(isRunFailurePromptAutoResendable({ content: "Fix the test", metadata: { turn_engine: "claude-code" } })).toBe(false);
    expect(
      isRunFailurePromptAutoResendable({
        content: "Fix the test",
        metadata: { prompt_metadata: { aiAccessMode: "claude-code", claudeCode: { version: 1 } } },
      }),
    ).toBe(false);
    expect(
      isRunFailurePromptAutoResendable({
        content: "Fix the test",
        metadata: { aiAccessMode: "claude-code", claudeCode: { version: 1 } },
      }),
    ).toBe(false);
    expect(isRunFailurePromptAutoResendable({ content: "Fix the test", metadata: { turnEngine: "future-engine" } })).toBe(false);
    expect(isRunFailurePromptAutoResendable({ content: "Fix the test", metadata: { aiAccessMode: "managed" } })).toBe(true);
    expect(isRunFailurePromptAutoResendable({ content: "Fix the test", metadata: null })).toBe(true);
  });

  it("is known wherever the chat reads its metadata, whatever its claim holds", () => {
    expect(usesTurnEngine({ turnEngine: "claude-code" })).toBe(true);
    expect(usesTurnEngine({ turnEngine: true })).toBe(true);
    expect(usesTurnEngine({ promptMetadata: { aiAccessMode: "Claude-Code" } })).toBe(true);
    expect(usesTurnEngine({ aiAccessMode: "byoc" })).toBe(false);
    expect(usesTurnEngine({ turnEngine: null })).toBe(false);
    expect(usesTurnEngine(null)).toBe(false);
  });
});

describe("a turn-engine reply's stamp", () => {
  it("counts only when the controller wrote it", () => {
    expect(readControllerStampedTurnEngine({ aiAccessMode: "claude-code", claudeCode: { version: 1 } })?.engineId).toBe(
      "claude-code",
    );
    expect(readControllerStampedTurnEngine({ turnEngine: "claude-code" })).toBeNull();
    expect(readControllerStampedTurnEngine({ aiAccessMode: "claude-code" })).toBeNull();
    expect(readControllerStampedTurnEngine({ claudeCode: { version: 1 } })).toBeNull();
    expect(readControllerStampedTurnEngine(null)).toBeNull();
  });
});

describe("a refused Steer into a turn-engine turn", () => {
  it("is worded by the engine whose refusal it is", () => {
    expect(describeTurnEngineSteerRefusal("claude_code_turn_takes_no_input")).toBe(
      "This Claude Code turn can't take more words while it runs. Queue your message instead.",
    );
    expect(describeTurnEngineSteerRefusal("no_active_job")).toBeNull();
  });
});
