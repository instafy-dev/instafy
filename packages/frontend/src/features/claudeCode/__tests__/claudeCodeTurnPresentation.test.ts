import { describe, expect, it } from "vitest";
import type { TurnEngineFailureInput } from "../../../conversations/runFailurePresentation";
import type { ControllerRuntimeStatusEntry } from "../../../services/runtimeController/runtimes";
import {
  CLAUDE_CODE_FAILURE_SENTENCES,
  CLAUDE_CODE_RESEND_LABEL,
  CLAUDE_CODE_SEND_REFUSAL_SENTENCES,
  CLAUDE_CODE_STEER_REFUSED,
  CLAUDE_CODE_TURN_PRESENTATION,
  claudeCodeSpeakerLine,
  claudeCodeTeammateFailureSentence,
  describeClaudeCodeSendRefusal,
  describeClaudeCodeTurnFailure,
  isClaudeCodeControllerStamped,
  type ClaudeCodeFailureCode,
} from "../claudeCodeTurnPresentation";
import { bannedWordIn } from "./claudeCodeBannedWords";

const plain = (text: string) => !/\b(?:codex|proxy|https?)\b|[{}]/i.test(text);

function failure(
  code: string | null,
  overrides: Partial<TurnEngineFailureInput> = {},
): TurnEngineFailureInput {
  return {
    metadata: {
      aiAccessMode: "claude-code",
      claudeCode: { version: 1 },
      ...(code ? { claudeCodeFailure: code } : {}),
    },
    rawText: "claude exited",
    plainFirstLine: null,
    readsPlainly: plain,
    runtime: null,
    ...overrides,
  };
}

function runtimeEntry(claudeCode: ControllerRuntimeStatusEntry["claudeCode"]): ControllerRuntimeStatusEntry {
  return { runtimeId: "runtime-1", claudeCode } as ControllerRuntimeStatusEntry;
}

// docs/Local-Engine-Turns.md 5.5, one row per code.
const EXPECTED: Record<ClaudeCodeFailureCode, string> = {
  not_signed_in:
    "Claude Code isn't signed in on this computer. Open a terminal, run claude and sign in, then send your message again.",
  plan_limit:
    "Your Claude plan's usage limit was reached, so this turn stopped. Send your message again after it resets.",
  binary_missing:
    "Instafy Desktop can't find Claude Code on this computer. Set it up again in Your AI, then send your message again.",
  binary_unsafe:
    "Instafy Desktop won't start this copy of Claude Code because other accounts on this computer can change it. Set it up again in Your AI.",
  unsupported_version:
    "This version of Claude Code can't take turns from Instafy. Update Claude Code, then send your message again.",
  probe_failed:
    "This version of Claude Code can't take turns from Instafy. Update Claude Code, then send your message again.",
  bare_default:
    "This version of Claude Code no longer lets other apps use your sign-in for a turn, so Instafy can't use it yet.",
  session_unavailable:
    "Claude Code couldn't continue its earlier session on this computer. Send your message again to start a new one.",
  turn_timeout:
    "Claude Code worked past its time limit for one turn, so it was stopped. Its changes stay on this computer and weren't saved to the space.",
  stalled: "Claude Code stopped responding, so this turn was stopped.",
  crashed: "Claude Code stopped unexpectedly, so this turn ended.",
  unexpected_configuration:
    "Claude Code started with settings Instafy didn't ask for, so Instafy stopped this turn.",
  project_config:
    "This space's folder on this computer holds Claude Code files, so Claude Code turns from Instafy can't run here. Move the files that Details names out of the folder, then send your message again.",
  unsafe_import:
    "A CLAUDE.md, CLAUDE.local.md or AGENTS.md file in this space's folder brings in files that aren't part of the space, so Claude Code turns from Instafy can't run here.",
  unsafe_link: "This space links to a file outside it, so Claude Code turns from Instafy can't run here.",
  preflight_failed: "Instafy couldn't check this space's folder on this computer, so Claude Code didn't start.",
  claude_code_machine_stopped:
    "Instafy Desktop stopped on your computer while Claude Code was working, so the turn ended. Send it again to run it.",
  start_by_passed: "This Claude Code turn didn't start in time, so it won't run. Send it again.",
  run_once_interrupted:
    "This Claude Code turn stopped because Instafy on your computer stopped, and it won't run again. Send it again to start over.",
};

/** Every sentence a Claude Code turn can show, from the module's own functions. */
function everyTurnSentence(): string[] {
  const sentences = Object.keys(EXPECTED).map((code) => describeClaudeCodeTurnFailure(failure(code)));
  sentences.push(
    describeClaudeCodeTurnFailure(
      failure("not_signed_in", { runtime: runtimeEntry({ ready: true, reason: null, cli: "2.1.400", verified: false, planSignIn: true }) }),
    ),
    describeClaudeCodeTurnFailure(failure("plan_limit", { rawText: "5-hour limit reached ∙ resets 2pm" })),
    describeClaudeCodeTurnFailure(failure(null)),
    describeClaudeCodeTurnFailure(failure(null, { plainFirstLine: "Prompt is too long" })),
    claudeCodeTeammateFailureSentence("Sam"),
    claudeCodeTeammateFailureSentence(null),
    ...Object.keys(CLAUDE_CODE_SEND_REFUSAL_SENTENCES).map(
      (code) => describeClaudeCodeSendRefusal({ code, details: null }) ?? "",
    ),
    describeClaudeCodeSendRefusal({ code: "claude_code_turn_active", details: { reason: "start_window_passed" } }) ?? "",
    describeClaudeCodeSendRefusal({ code: "claude_code_turn_engine_unknown", details: null }) ?? "",
    CLAUDE_CODE_STEER_REFUSED,
    CLAUDE_CODE_RESEND_LABEL,
    claudeCodeSpeakerLine({ isViewer: true, name: null }),
    claudeCodeSpeakerLine({ isViewer: false, name: "Sam" }),
    claudeCodeSpeakerLine(null),
  );
  return sentences;
}

describe("Claude Code turn wording", () => {
  it("has the design's sentence for every failure code", () => {
    expect(Object.keys(CLAUDE_CODE_FAILURE_SENTENCES).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [code, sentence] of Object.entries(EXPECTED)) {
      expect(describeClaudeCodeTurnFailure(failure(code)), code).toBe(sentence);
    }
  });

  it("never uses a word the banned-word fixture lists", () => {
    for (const sentence of everyTurnSentence()) {
      expect(sentence.length, "empty sentence").toBeGreaterThan(0);
      expect(bannedWordIn(sentence), sentence).toBeNull();
    }
  });

  it("adds the newer-version sentence to not_signed_in only when the runtime says the version is not verified", () => {
    const unverified = runtimeEntry({ ready: true, reason: null, cli: "2.1.400", verified: false, planSignIn: true });
    expect(describeClaudeCodeTurnFailure(failure("not_signed_in", { runtime: unverified }))).toBe(
      `${EXPECTED.not_signed_in} If you're signed in, this newer Claude Code may no longer let other apps use your sign-in.`,
    );
    const verified = runtimeEntry({ ready: true, reason: null, cli: "2.1.314", verified: true, planSignIn: true });
    expect(describeClaudeCodeTurnFailure(failure("not_signed_in", { runtime: verified }))).toBe(EXPECTED.not_signed_in);
    // Unknown is not unverified.
    const unknown = runtimeEntry({ ready: true, reason: null, cli: null, verified: null, planSignIn: false });
    expect(describeClaudeCodeTurnFailure(failure("not_signed_in", { runtime: unknown }))).toBe(EXPECTED.not_signed_in);
    // The flag belongs to not_signed_in alone.
    expect(describeClaudeCodeTurnFailure(failure("crashed", { runtime: unverified }))).toBe(EXPECTED.crashed);
  });

  it("adds the reset time to plan_limit when the failure's text gives one", () => {
    const sentence = (rawText: string) => describeClaudeCodeTurnFailure(failure("plan_limit", { rawText }));
    const base = "Your Claude plan's usage limit was reached, so this turn stopped. Send your message again after it resets";
    expect(sentence("5-hour limit reached ∙ resets 2pm")).toBe(`${base} at 2pm.`);
    expect(sentence("Claude usage limit reached. Your limit will reset at 5pm (America/Los_Angeles).")).toBe(
      `${base} at 5pm (America/Los_Angeles).`,
    );
    expect(sentence("Usage limit reached, resets in 3 hours")).toBe(`${base} in 3 hours.`);
    // No time, a time that names the plumbing, or one too long: the plain sentence.
    expect(sentence("Usage limit reached.")).toBe(EXPECTED.plan_limit);
    expect(sentence("limit reached, resets 2pm {\"type\":\"rate_limit\"}")).toBe(EXPECTED.plan_limit);
    expect(sentence(`resets 1${"0".repeat(60)}`)).toBe(EXPECTED.plan_limit);
  });

  it("says anything else stopped with an error, with its first line only when that line reads plainly", () => {
    expect(describeClaudeCodeTurnFailure(failure(null))).toBe("Claude Code stopped with an error.");
    expect(describeClaudeCodeTurnFailure(failure("some_future_code"))).toBe("Claude Code stopped with an error.");
    expect(describeClaudeCodeTurnFailure(failure(null, { plainFirstLine: "Prompt is too long" }))).toBe(
      "Claude Code stopped with an error: Prompt is too long",
    );
  });

  it("tells everyone else only that it couldn't finish on the sender's computer", () => {
    expect(claudeCodeTeammateFailureSentence("Sam")).toBe("Claude Code couldn't finish this turn on Sam's computer.");
    expect(claudeCodeTeammateFailureSentence("  ")).toBe(
      "Claude Code couldn't finish this turn on the sender's computer.",
    );
    expect(claudeCodeTeammateFailureSentence(null)).toBe(
      "Claude Code couldn't finish this turn on the sender's computer.",
    );
  });

  it("words every send refusal by its code, and the busy chat's when the send claimed Claude Code", () => {
    const refusal = (code: string, details: unknown = null) => describeClaudeCodeSendRefusal({ code, details });
    expect(refusal("claude_code_turn_not_allowed")).toBe("Claude Code turns aren't on for your account yet.");
    expect(refusal("claude_code_turn_not_person")).toBe("Claude Code takes only a message you send yourself.");
    expect(refusal("claude_code_turn_not_plain")).toBe(
      "Claude Code takes only a plain message to Octo, of at most 100,000 characters, without attachments or a command.",
    );
    expect(refusal("claude_code_conversation_granted")).toBe(
      "In this chat, Octo takes turns only from the person who started the chat, so Claude Code can't run your message here.",
    );
    expect(refusal("claude_code_turn_active", { reason: "turn_active" })).toBe(
      "You already have a Claude Code turn running. Send this when it ends.",
    );
    expect(refusal("claude_code_turn_active", { reason: "start_window_passed" })).toBe(
      "Your last Claude Code turn didn't start in time. Send this again in a few seconds.",
    );
    expect(refusal("claude_code_machine_busy", { reason: "machine_busy" })).toBe(
      "Your computer is busy with another turn. Send this when it's done.",
    );
    expect(refusal("claude_code_runtime_not_ready", { reason: "not_attested" })).toBe(
      "Your computer isn't connected to this space. Open this space in Instafy Desktop, then send your message again.",
    );
    expect(refusal("dispatch_lane_busy")).toBe(
      "Octo is still working on another message in this chat. Send this when it's done.",
    );
    // A Claude Code refusal this client does not know yet never shows the
    // controller's raw text; any other code is not Claude Code's to word.
    expect(refusal("claude_code_turn_engine_unknown")).toBe("Claude Code couldn't take this message.");
    expect(refusal("project_not_found")).toBeNull();
  });

  it("words a refused Steer, and only Claude Code's own refusal", () => {
    expect(CLAUDE_CODE_TURN_PRESENTATION.describeSteerRefusal("claude_code_turn_takes_no_input")).toBe(
      "This Claude Code turn can't take more words while it runs. Queue your message instead.",
    );
    expect(CLAUDE_CODE_TURN_PRESENTATION.describeSteerRefusal("no_active_job")).toBeNull();
  });

  it("says whose own Claude Code ran a reply, in plain words", () => {
    expect(claudeCodeSpeakerLine({ isViewer: false, name: "Sam" })).toBe(
      "Ran on Sam's own Claude Code, on their computer",
    );
    expect(claudeCodeSpeakerLine({ isViewer: true, name: "Sam" })).toBe("Ran on your own Claude Code, on your computer");
    expect(claudeCodeSpeakerLine(null)).toBe("Ran on the sender's own Claude Code, on their computer");
  });

  it("counts only the controller's own stamp as a Claude Code turn's", () => {
    expect(isClaudeCodeControllerStamped({ aiAccessMode: "claude-code", claudeCode: { version: 1 } })).toBe(true);
    expect(isClaudeCodeControllerStamped({ turnEngine: "claude-code" })).toBe(false);
    expect(isClaudeCodeControllerStamped({ aiAccessMode: "claude-code" })).toBe(false);
    expect(isClaudeCodeControllerStamped({ claudeCode: { version: 1 } })).toBe(false);
    expect(isClaudeCodeControllerStamped({ aiAccessMode: "claude-code", claudeCode: { version: 2 } })).toBe(false);
    expect(isClaudeCodeControllerStamped({ aiAccessMode: "byoc", claudeCode: { version: 1 } })).toBe(false);
  });
});
