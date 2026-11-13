import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../screens/studio/types";
import type { ControllerRuntimeStatusEntry } from "../../services/runtimeController/runtimes";
import {
  describeTurnEngineSteerRefusal,
  isRunFailurePromptAutoResendable,
  newestTurnEngineStartingLine,
  readControllerStampedTurnEngine,
  resolveNewestTurnPrompt,
  resolveRunFailureAutoRetryDelayMs,
  resolveRunFailurePresentation,
  showsTurnEngineSpeakerLine,
  turnEngineIds,
  turnEngineStartingLine,
  turnEngineTurnOwner,
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

  it("covers the failures a sweep or a runtime stop writes, which carry the controller's stamp and the code", () => {
    // The controller's stamp_failure: the mode, its stamp and the code.
    const presentation = resolveRunFailurePresentation({
      metadata: {
        aiAccessMode: "claude-code",
        claudeCode: { version: 1 },
        managedAiUsed: false,
        claudeCodeFailure: "start_by_passed",
        outcome: "failed",
        jobId: "job-lane",
      },
      content: "This turn didn't start in time.",
    });
    expect(presentation?.kind).toBe("turn_engine");
    expect(presentation?.friendlyText).toBe("This Claude Code turn didn't start in time, so it won't run. Send it again.");
  });

  // Any member can record an assistant message, and the controller keeps its
  // aiAccessMode (it strips only the claim, the stamp and the code): only
  // the controller's stamp makes a failure read as the engine's.
  it("reads a failure without the controller's stamp as any other failure", () => {
    for (const metadata of [
      { source: "agent", messageType: "error", outcome: "failed", aiAccessMode: "claude-code" },
      { source: "agent", outcome: "failed", jobId: "job-x", aiAccessMode: "claude-code", claudeCodeFailure: "not_signed_in" },
      { source: "agent", outcome: "failed", jobId: "job-x", aiAccessMode: "claude-code", claudeCode: { version: 2 } },
    ]) {
      const presentation = resolveRunFailurePresentation({
        metadata,
        content: "The build script stopped halfway",
        assumeFailed: true,
      });
      expect(presentation?.kind, JSON.stringify(metadata)).toBe("generic");
      expect(presentation?.turnEngine, JSON.stringify(metadata)).toBeUndefined();
      expect(presentation?.friendlyText).toBe("The build script stopped halfway");
      // Still a turn-engine turn's for everything that resends or retries.
      expect(usesTurnEngine(metadata)).toBe(true);
    }
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
    expect(usesTurnEngine({ aiAccessMode: "managed" })).toBe(false);
    expect(usesTurnEngine({ prompt_metadata: { aiAccessMode: "Managed" } })).toBe(false);
    expect(usesTurnEngine({ turnEngine: null })).toBe(false);
    expect(usesTurnEngine(null)).toBe(false);
  });

  // A Studio built without an engine's module (the hosted one before it
  // lists it, or a tab opened before the deploy) still never resends,
  // retries or titles from that engine's turns.
  it("is known by any aiAccessMode but the runtime's own engine's, also of an engine this Studio was not built with", () => {
    expect(usesTurnEngine({ aiAccessMode: "future-engine" })).toBe(true);
    expect(usesTurnEngine({ prompt_metadata: { aiAccessMode: "future-engine" } })).toBe(true);
    expect(isRunFailurePromptAutoResendable({ content: "Fix the test", metadata: { aiAccessMode: "future-engine" } })).toBe(
      false,
    );
    // Its wording stays the runtime's own: only an engine this Studio knows words a failure.
    const failure = resolveRunFailurePresentation({
      metadata: { source: "agent", outcome: "failed", jobId: "job-1", aiAccessMode: "future-engine", claudeCode: { version: 1 } },
      content: "Something odd happened",
    });
    expect(failure?.kind).toBe("generic");
    expect(failure?.turnEngine).toBeUndefined();
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

describe("a turn-engine reply's speaker line", () => {
  it("shows for a reply the controller stamped, never for a failure, a claim or another mode", () => {
    const stamped = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, outcome: "succeeded" };
    expect(showsTurnEngineSpeakerLine(stamped)).toBe(true);
    expect(showsTurnEngineSpeakerLine(laneFailure("plan_limit"))).toBe(false);
    expect(showsTurnEngineSpeakerLine({ turnEngine: "claude-code" })).toBe(false);
    expect(showsTurnEngineSpeakerLine({ aiAccessMode: "claude-code" })).toBe(false);
    expect(showsTurnEngineSpeakerLine({ aiAccessMode: "managed", claudeCode: { version: 1 } })).toBe(false);
    expect(showsTurnEngineSpeakerLine(null)).toBe(false);
  });
});

// docs/Local-Engine-Turns.md 5.7: "Starting Claude Code on this computer…"
// until the first step arrives, for the turn's sender. It starts on the
// sender's computer, never on a teammate's.
describe("a turn-engine turn's start", () => {
  const STARTING = "Starting Claude Code on this computer…";
  const STAMP = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };
  const SENDER = { isViewer: true, name: "Sam" };
  const TEAMMATE_VIEWS = { isViewer: false, name: "Sam" };

  it("is worded by the engine its run's controller stamp names", () => {
    expect(turnEngineStartingLine({ runMetadata: { ...STAMP, jobId: "job-1" }, owner: SENDER })).toBe(STARTING);
    // The run says it runs on another engine: its prompt is not asked.
    expect(
      turnEngineStartingLine({ runMetadata: { aiAccessMode: "managed" }, promptMetadata: STAMP, owner: SENDER }),
    ).toBeNull();
    // A mode a client could write never counts on the run.
    expect(turnEngineStartingLine({ runMetadata: { aiAccessMode: "claude-code" }, owner: SENDER })).toBeNull();
  });

  it("is worded by its prompt until the page has the run's metadata", () => {
    // The sender's own copy, before the controller's arrives.
    expect(
      turnEngineStartingLine({ runMetadata: null, promptMetadata: { turnEngine: "claude-code" }, owner: SENDER }),
    ).toBe(STARTING);
    // The controller's stamped copy (a teammate's page, whose run has no metadata).
    expect(turnEngineStartingLine({ runMetadata: { jobId: "job-1" }, promptMetadata: STAMP, owner: SENDER })).toBe(
      STARTING,
    );
    // An engine this Studio does not know, or a mode a client could record, never does.
    expect(turnEngineStartingLine({ promptMetadata: { turnEngine: "another-engine" }, owner: SENDER })).toBeNull();
    expect(turnEngineStartingLine({ promptMetadata: { aiAccessMode: "claude-code" }, owner: SENDER })).toBeNull();
    expect(turnEngineStartingLine({ promptMetadata: { input: { kind: "person" } }, owner: SENDER })).toBeNull();
    expect(turnEngineStartingLine({ owner: SENDER })).toBeNull();
    expect(turnEngineStartingLine({})).toBeNull();
  });

  it("is worded for whoever views it, by who sent the turn", () => {
    // A teammate's page: the turn starts on its sender's computer.
    expect(turnEngineStartingLine({ runMetadata: { jobId: "job-1" }, promptMetadata: STAMP, owner: TEAMMATE_VIEWS })).toBe(
      "Starting Claude Code on Sam's computer…",
    );
    expect(
      turnEngineStartingLine({ promptMetadata: STAMP, owner: { isViewer: false, name: null } }),
    ).toBe("Starting Claude Code on the sender's computer…");
    // Nobody the chat can tell: no computer is named.
    expect(turnEngineStartingLine({ runMetadata: { ...STAMP, jobId: "job-1" }, owner: null })).toBe(
      "Starting Claude Code…",
    );
    expect(turnEngineStartingLine({ promptMetadata: STAMP })).toBe("Starting Claude Code…");
  });
});

describe("who sent a turn-engine turn", () => {
  const STAMP = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };
  const names = new Map([
    ["user-sam", "Sam"],
    ["user-alex", "Alex"],
  ]);
  const viewer = (currentUserId: string | null) => ({ currentUserId, nameOf: (userId: string) => names.get(userId) });
  function prompt(authorId: string | null, metadata: Record<string, unknown> | null) {
    return { authorId, metadata };
  }

  it("is the viewer on the page that sent it: its copy still carries the claim", () => {
    // The controller takes the claim from every send, so no stored copy has one.
    expect(turnEngineTurnOwner(prompt("user-sam", { turnEngine: "claude-code" }), viewer("user-sam"))).toEqual({
      isViewer: true,
      name: "Sam",
    });
    // Also before the page knows who is signed in, or when the copy names nobody.
    expect(turnEngineTurnOwner(prompt(null, { turnEngine: "claude-code" }), viewer(null))).toEqual({
      isViewer: true,
      name: null,
    });
  });

  it("is the stored copy's author, the viewer or someone else, by the name the chat shows", () => {
    const stored = { ...STAMP, prompt_metadata: STAMP };
    expect(turnEngineTurnOwner(prompt("user-sam", stored), viewer("user-sam"))).toEqual({ isViewer: true, name: "Sam" });
    expect(turnEngineTurnOwner(prompt("user-sam", stored), viewer("user-alex"))).toEqual({
      isViewer: false,
      name: "Sam",
    });
    expect(turnEngineTurnOwner(prompt("user-kim", stored), viewer("user-alex"))).toEqual({ isViewer: false, name: null });
    // Before the page knows who is signed in, nobody is the viewer.
    expect(turnEngineTurnOwner(prompt("user-sam", stored), viewer(null))).toEqual({ isViewer: false, name: "Sam" });
  });

  it("is nobody the chat can tell for any other prompt, or one that names nobody", () => {
    expect(turnEngineTurnOwner(prompt("user-sam", null), viewer("user-sam"))).toBeNull();
    expect(turnEngineTurnOwner(prompt("user-sam", { aiAccessMode: "managed" }), viewer("user-sam"))).toBeNull();
    expect(turnEngineTurnOwner(prompt(null, STAMP), viewer("user-sam"))).toBeNull();
    expect(turnEngineTurnOwner(null, viewer("user-sam"))).toBeNull();
  });
});

// The typing row before the newest turn's first step (ChatPanel).
describe("the typing row's start of a turn-engine turn", () => {
  const STAMP = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };
  const names = new Map([["user-sam", "Sam"]]);
  const viewer = (currentUserId: string) => ({ currentUserId, nameOf: (userId: string) => names.get(userId) });
  function userMessage(id: string, metadata: Record<string, unknown>): ChatMessage {
    return { id, role: "user", authorId: "user-sam", content: "@octo fix the login test", timestamp: 1, metadata };
  }

  it("reads the sender's own computer on the page that sent it", () => {
    // The sender's page has the run's stamp, and its own copy of the message.
    expect(
      newestTurnEngineStartingLine({
        conversationMessages: [userMessage("prompt-local", { turnEngine: "claude-code" })],
        run: { id: "run-1", metadata: { ...STAMP, jobId: "run-1" } },
        viewer: viewer("user-sam"),
      }),
    ).toBe("Starting Claude Code on this computer…");
  });

  it("reads the sender's computer by name on a teammate's page", () => {
    // A teammate's page has no metadata for another person's run, only its stamped prompt.
    expect(
      newestTurnEngineStartingLine({
        conversationMessages: [userMessage("prompt-1", { ...STAMP, runId: "run-1" })],
        run: { id: "run-1", metadata: null },
        viewer: viewer("user-alex"),
      }),
    ).toBe("Starting Claude Code on Sam's computer…");
  });

  it("is null for any other turn", () => {
    expect(
      newestTurnEngineStartingLine({
        conversationMessages: [userMessage("prompt-1", { runId: "run-1" })],
        run: { id: "run-1", metadata: { aiAccessMode: "managed" } },
        viewer: viewer("user-sam"),
      }),
    ).toBeNull();
    expect(newestTurnEngineStartingLine({ conversationMessages: [], run: null, viewer: viewer("user-sam") })).toBeNull();
  });
});

describe("the newest turn's prompt", () => {
  function chatMessage(id: string, role: "user" | "assistant", metadata: Record<string, unknown> | null = null) {
    return { id, role, content: `${id} text`, timestamp: 1, metadata } as ChatMessage;
  }

  it("is the prompt that names the run, else the newest prompt that is not a steer", () => {
    const messages = [
      chatMessage("prompt-1", "user", { runId: "run-1" }),
      chatMessage("reply-1", "assistant"),
      chatMessage("prompt-2", "user"),
      chatMessage("steer-1", "user", { sendIntent: { mode: "steer" } }),
    ];
    expect(resolveNewestTurnPrompt(messages, "run-1")?.id).toBe("prompt-1");
    expect(resolveNewestTurnPrompt(messages, "run-9")?.id).toBe("prompt-2");
    expect(resolveNewestTurnPrompt(messages, null)?.id).toBe("prompt-2");
    expect(resolveNewestTurnPrompt([chatMessage("reply-1", "assistant")], null)).toBeNull();
  });
});
