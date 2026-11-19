import { describe, expect, it } from "vitest";
// Registers the application's turn engines, as the application does when it
// builds its feature composition at startup (features/turnEngineRegistry.ts).
import "../../features/applicationFrontendFeatureComposition";
import type { ChatMessage } from "../../screens/studio/types";
import type { ControllerRuntimeStatusEntry } from "../../services/runtimeController/runtimes";
import {
  describeTurnEngineSendRefusal,
  describeTurnEngineSteerRefusal,
  isRunFailurePromptAutoResendable,
  newestTurnEngineStartingLine,
  newestWaitingTurnEngine,
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
    expect(presentation?.turnEngine?.teammateText("Sam")).toBe(
      "Claude Code couldn't finish this turn on Sam's computer.",
    );
  });

  it("gives its person the runtime's say, from the status entry of the runtime that ran it", () => {
    const presentation = resolveRunFailurePresentation({ metadata: laneFailure("not_signed_in"), content: "x" });
    const runtime = {
      runtimeId: "runtime-1",
      claudeCode: { ready: true, reason: null, cli: "2.2.0", verified: false, planSignIn: true, resetsAt: null },
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
        claudeCodeFailure: "run_once_interrupted",
        outcome: "failed",
        jobId: "job-lane",
      },
      content: "This turn stopped because its machine stopped.",
    });
    expect(presentation?.kind).toBe("turn_engine");
    expect(presentation?.friendlyText).toBe(
      "This Claude Code turn stopped because Instafy on your computer stopped, and it won't run again. Send it again to start over.",
    );
    // A turn waits with no start window in version 2 (11.7), so a code a
    // version 1 sweep wrote reads as any other failure of the engine's.
    expect(
      resolveRunFailurePresentation({
        metadata: laneFailure("start_by_passed"),
        content: "This turn didn't start in time.",
      })?.friendlyText,
    ).toBe("Claude Code stopped with an error: This turn didn't start in time.");
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
      // Still a turn-engine turn's for the automatic resend, which passes it over.
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
  // docs/Local-Engine-Turns.md 11.14: none of a Claude Code turn's failures
  // clears by itself within seconds, so Studio's automatic resend passes it
  // over; its person sends it again with Try again.
  it("is never resent automatically, by the controller's stamped copy", () => {
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
    expect(isRunFailurePromptAutoResendable({ content: "Fix the test", metadata: { aiAccessMode: "managed" } })).toBe(true);
    expect(isRunFailurePromptAutoResendable({ content: "Fix the test", metadata: null })).toBe(true);
    // Version 1's claim is gone: a key of that name is nothing now.
    expect(isRunFailurePromptAutoResendable({ content: "Fix the test", metadata: { turnEngine: "claude-code" } })).toBe(true);
  });

  it("is known wherever the chat reads its metadata", () => {
    expect(usesTurnEngine({ promptMetadata: { aiAccessMode: "Claude-Code" } })).toBe(true);
    expect(usesTurnEngine({ prompt_metadata: { aiAccessMode: "claude-code" } })).toBe(true);
    expect(usesTurnEngine({ aiAccessMode: "byoc" })).toBe(false);
    expect(usesTurnEngine({ aiAccessMode: "managed" })).toBe(false);
    expect(usesTurnEngine({ prompt_metadata: { aiAccessMode: "Managed" } })).toBe(false);
    expect(usesTurnEngine({ turnEngine: "claude-code" })).toBe(false);
    expect(usesTurnEngine(null)).toBe(false);
  });

  // A Studio built without an engine's module (the hosted one before it
  // lists it, or a tab opened before the deploy) still never resends that
  // engine's turns by itself.
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

// docs/Local-Engine-Turns.md 11.6: a send the controller refuses because a
// turn it would start runs on Claude Code, keyed on the refusal's code alone.
describe("a send refused for a turn-engine turn", () => {
  it("is worded by the engine whose code it is, and only then", () => {
    expect(describeTurnEngineSendRefusal({ code: "claude_code_turn_not_allowed", details: null })).toEqual({
      engineId: "claude-code",
      sentence: "Claude Code turns aren't on for your account. Choose another AI for this agent in Your AI.",
    });
    expect(
      describeTurnEngineSendRefusal({ code: "claude_code_turn_unsupported", details: { reason: "attachments" } })?.sentence,
    ).toBe("Claude Code can't take attachments yet. Send your message without them.");
    expect(describeTurnEngineSendRefusal({ code: "dispatch_lane_busy", details: null })).toBeNull();
    expect(describeTurnEngineSendRefusal({ code: "project_not_found", details: null })).toBeNull();
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
  it("shows for a reply the controller stamped, never for a failure or another mode", () => {
    const stamped = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, outcome: "succeeded" };
    expect(showsTurnEngineSpeakerLine(stamped)).toBe(true);
    expect(showsTurnEngineSpeakerLine(laneFailure("plan_limit"))).toBe(false);
    expect(showsTurnEngineSpeakerLine({ turnEngine: "claude-code" })).toBe(false);
    expect(showsTurnEngineSpeakerLine({ aiAccessMode: "claude-code" })).toBe(false);
    expect(showsTurnEngineSpeakerLine({ aiAccessMode: "managed", claudeCode: { version: 1 } })).toBe(false);
    expect(showsTurnEngineSpeakerLine(null)).toBe(false);
  });
});

// docs/Local-Engine-Turns.md 5.7, 11.14: while no computer has taken it, the
// turn waits for its person's computer; once one did, until its first step,
// "Starting Claude Code on this computer…" for its person. It waits for, and
// starts on, that person's computer, never on a teammate's.
describe("a turn-engine turn's start", () => {
  const STARTING = "Starting Claude Code on this computer…";
  const STAMP = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };
  const PERSON = { isViewer: true, name: "Sam" };
  const TEAMMATE_VIEWS = { isViewer: false, name: "Sam" };

  it("is worded by the engine its run's controller stamp names", () => {
    expect(turnEngineStartingLine({ runMetadata: { ...STAMP, jobId: "job-1" }, owner: PERSON })).toBe(STARTING);
    // The run says it runs on another engine: its prompt is not asked.
    expect(
      turnEngineStartingLine({ runMetadata: { aiAccessMode: "managed" }, promptMetadata: STAMP, owner: PERSON }),
    ).toBeNull();
    // A mode a client could write never counts on the run.
    expect(turnEngineStartingLine({ runMetadata: { aiAccessMode: "claude-code" }, owner: PERSON })).toBeNull();
  });

  it("waits for a computer while its run is queued, and starts once one took it", () => {
    const run = { ...STAMP, jobId: "job-1" };
    expect(turnEngineStartingLine({ runMetadata: run, runStatus: "queued", owner: PERSON })).toBe(
      "Waiting for your computer…",
    );
    expect(turnEngineStartingLine({ runMetadata: run, runStatus: "queued", owner: TEAMMATE_VIEWS })).toBe(
      "Waiting for Sam's computer…",
    );
    expect(turnEngineStartingLine({ runMetadata: run, runStatus: "queued", owner: null })).toBe(
      "Waiting for the sender's computer…",
    );
    expect(turnEngineStartingLine({ runMetadata: run, runStatus: "in_progress", owner: PERSON })).toBe(STARTING);
  });

  it("waits for its person's Claude plan's limit while one of their computers holds it", () => {
    const resetsAt = new Date(Date.now() + 2 * 60 * 60_000);
    const holding = {
      runtimeId: "runtime-1",
      claudeCode: { ready: false, reason: null, cli: "2.1.325", verified: true, planSignIn: true, resetsAt: resetsAt.toISOString() },
    } as ControllerRuntimeStatusEntry;
    const line = turnEngineStartingLine({
      runMetadata: { ...STAMP, jobId: "job-1" },
      runStatus: "queued",
      owner: PERSON,
      runtimes: [holding],
    });
    expect(line).toMatch(/^Waiting for your Claude plan's limit to reset at .+…$/u);
    expect(line).toContain(new Intl.DateTimeFormat(undefined, { minute: "2-digit" }).format(resetsAt));
  });

  it("is worded by its prompt until the page has the run's metadata", () => {
    // The controller's stamped copy (a page whose run has no metadata yet).
    expect(turnEngineStartingLine({ runMetadata: { jobId: "job-1" }, promptMetadata: STAMP, owner: PERSON })).toBe(
      STARTING,
    );
    // A mode a client could record, or no engine, never does.
    expect(turnEngineStartingLine({ promptMetadata: { aiAccessMode: "claude-code" }, owner: PERSON })).toBeNull();
    expect(turnEngineStartingLine({ promptMetadata: { input: { kind: "person" } }, owner: PERSON })).toBeNull();
    expect(turnEngineStartingLine({ owner: PERSON })).toBeNull();
    expect(turnEngineStartingLine({})).toBeNull();
  });

  it("is worded for whoever views it, by whose turn it is", () => {
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

describe("whose turn-engine turn it is", () => {
  const names = new Map([
    ["user-sam", "Sam"],
    ["user-alex", "Alex"],
  ]);
  const viewer = (currentUserId: string | null) => ({ currentUserId, nameOf: (userId: string) => names.get(userId) });

  // The run names its job's person (the controller's initiatingUserId), who
  // owns the agent: also an automation's or a goal's turn, which no person wrote.
  it("is the person the run names, the viewer or someone else", () => {
    expect(turnEngineTurnOwner({ runMetadata: { initiatingUserId: "user-sam" } }, viewer("user-sam"))).toEqual({
      isViewer: true,
      name: "Sam",
    });
    expect(
      turnEngineTurnOwner({ runMetadata: { initiatingUserId: "user-sam" }, prompt: { authorId: "user-alex" } }, viewer("user-alex")),
    ).toEqual({ isViewer: false, name: "Sam" });
  });

  it("is the prompt's author when the page has no run that names its person", () => {
    expect(turnEngineTurnOwner({ prompt: { authorId: "user-sam" } }, viewer("user-sam"))).toEqual({
      isViewer: true,
      name: "Sam",
    });
    expect(turnEngineTurnOwner({ runMetadata: {}, prompt: { authorId: "user-sam" } }, viewer("user-alex"))).toEqual({
      isViewer: false,
      name: "Sam",
    });
    expect(turnEngineTurnOwner({ prompt: { authorId: "user-kim" } }, viewer("user-alex"))).toEqual({
      isViewer: false,
      name: null,
    });
    // Before the page knows who is signed in, nobody is the viewer.
    expect(turnEngineTurnOwner({ prompt: { authorId: "user-sam" } }, viewer(null))).toEqual({
      isViewer: false,
      name: "Sam",
    });
  });

  it("is nobody the chat can tell when neither names anyone", () => {
    expect(turnEngineTurnOwner({ prompt: { authorId: null } }, viewer("user-sam"))).toBeNull();
    expect(turnEngineTurnOwner({ runMetadata: { initiatingUserId: "  " } }, viewer("user-sam"))).toBeNull();
    expect(turnEngineTurnOwner({}, viewer("user-sam"))).toBeNull();
  });
});

// The typing row before the newest turn's first step (ChatPanel).
describe("the typing row of a turn-engine turn", () => {
  const STAMP = { aiAccessMode: "claude-code", claudeCode: { version: 1 }, managedAiUsed: false };
  const names = new Map([["user-sam", "Sam"]]);
  const viewer = (currentUserId: string) => ({ currentUserId, nameOf: (userId: string) => names.get(userId) });
  function userMessage(id: string, metadata: Record<string, unknown>): ChatMessage {
    return { id, role: "user", authorId: "user-sam", content: "@reviewer fix the login test", timestamp: 1, metadata };
  }

  it("reads its person's own computer on their page, and by name on a teammate's", () => {
    const run = { id: "run-1", status: "in_progress", metadata: { ...STAMP, jobId: "run-1", initiatingUserId: "user-sam" } };
    expect(
      newestTurnEngineStartingLine({
        conversationMessages: [userMessage("prompt-1", { runId: "run-1" })],
        run,
        viewer: viewer("user-sam"),
      }),
    ).toBe("Starting Claude Code on this computer…");
    expect(
      newestTurnEngineStartingLine({
        conversationMessages: [userMessage("prompt-1", { runId: "run-1" })],
        run,
        viewer: viewer("user-alex"),
      }),
    ).toBe("Starting Claude Code on Sam's computer…");
  });

  it("reads the wait for a computer while the run is queued, and says whose turn waits", () => {
    const run = { id: "run-1", status: "queued", metadata: { ...STAMP, jobId: "run-1", initiatingUserId: "user-sam" } };
    const chat = { conversationMessages: [userMessage("prompt-1", { runId: "run-1" })], run };
    expect(newestTurnEngineStartingLine({ ...chat, viewer: viewer("user-sam") })).toBe("Waiting for your computer…");
    expect(newestTurnEngineStartingLine({ ...chat, viewer: viewer("user-alex") })).toBe("Waiting for Sam's computer…");
    expect(newestWaitingTurnEngine({ ...chat, viewer: viewer("user-sam") })).toEqual({
      engineId: "claude-code",
      owner: { isViewer: true, name: "Sam" },
    });
    expect(newestWaitingTurnEngine({ ...chat, viewer: viewer("user-alex") })?.owner?.isViewer).toBe(false);
    // Taken by a computer, or no engine's turn: nothing waits.
    expect(newestWaitingTurnEngine({ ...chat, run: { ...run, status: "in_progress" }, viewer: viewer("user-sam") })).toBeNull();
    expect(
      newestWaitingTurnEngine({ ...chat, run: { ...run, metadata: { aiAccessMode: "managed" } }, viewer: viewer("user-sam") }),
    ).toBeNull();
    expect(newestWaitingTurnEngine({ conversationMessages: [], run: null, viewer: viewer("user-sam") })).toBeNull();
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
