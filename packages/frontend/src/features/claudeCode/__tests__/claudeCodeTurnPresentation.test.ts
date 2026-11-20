import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TurnEngineFailureInput } from "../../../conversations/runFailurePresentation";
import type { ControllerRuntimeStatusEntry } from "../../../services/runtimeController/runtimes";
import {
  CLAUDE_CODE_FAILURE_SENTENCES,
  CLAUDE_CODE_SEND_REFUSAL_SENTENCES,
  CLAUDE_CODE_STEER_REFUSED,
  CLAUDE_CODE_TURN_PRESENTATION,
  CLAUDE_CODE_UNSUPPORTED_SENTENCES,
  claudeCodePlanLimitResetsAt,
  claudeCodeSpeakerLine,
  claudeCodeTeammateFailureSentence,
  claudeCodeWaitingLine,
  describeClaudeCodeSendRefusal,
  describeClaudeCodeTurnFailure,
  isClaudeCodeControllerStamped,
  type ClaudeCodeFailureCode,
} from "../claudeCodeTurnPresentation";
import { bannedWordIn } from "./claudeCodeBannedWords";

// The codes a failed turn carries are runtime-contracts' lists: the same file
// the runtime's and the controller's tests read, so a code renamed on one
// side and not here fails at once.
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../../..");
const LANE = JSON.parse(
  readFileSync(resolve(repo, "packages/runtime-contracts/src/claude_code_lane_fixtures.json"), "utf8"),
) as { runtimeFailureCodes: string[]; stopAndSweepFailureCodes: string[] };

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

function runtimeEntry(
  claudeCode: Omit<NonNullable<ControllerRuntimeStatusEntry["claudeCode"]>, "resetsAt"> & { resetsAt?: string | null },
  runtimeId = "runtime-1",
): ControllerRuntimeStatusEntry {
  return { runtimeId, claudeCode: { resetsAt: null, ...claudeCode } } as ControllerRuntimeStatusEntry;
}

// docs/Local-Engine-Turns.md 5.5, one row per code.
const EXPECTED: Record<ClaudeCodeFailureCode, string> = {
  not_signed_in:
    "Claude Code isn't signed in on this computer. Open a terminal, run claude and sign in, then send your message again.",
  plan_limit:
    "Your Claude plan's usage limit was reached, so this turn stopped. Send your message again after it resets.",
  binary_missing:
    "Instafy Desktop can't find Claude Code on this computer. Set it up again in Your AI, then send your message again.",
  // The runtime gives this one code for the copy and for a login-shell
  // setting Desktop granted with it (D26), so the sentence names both.
  binary_unsafe:
    "Instafy Desktop won't start this copy of Claude Code because other accounts on this computer can change it, or a setting from your login shell (CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS) points somewhere it can't use. Set it up again in Your AI.",
  unsupported_version:
    "This version of Claude Code can't take turns from Instafy. Update Claude Code, then send your message again.",
  probe_failed:
    "This version of Claude Code can't take turns from Instafy. Update Claude Code, then send your message again.",
  bare_default:
    "This version of Claude Code no longer lets other apps use your sign-in for a turn, so Instafy can't use it yet.",
  turn_timeout:
    "Claude Code worked past its time limit for one turn, so it was stopped. Its changes stay on this computer and weren't saved to the space.",
  stalled: "Claude Code stopped responding, so this turn was stopped.",
  crashed: "Claude Code stopped unexpectedly, so this turn ended.",
  unexpected_configuration:
    "Claude Code started with settings Instafy didn't ask for, so Instafy stopped this turn.",
  unsafe_import:
    "A CLAUDE.md, CLAUDE.local.md or AGENTS.md file in this space's folder brings in files that aren't part of the space, so Claude Code turns from Instafy can't run here.",
  unsafe_link: "This space links to a file outside it, so Claude Code turns from Instafy can't run here.",
  preflight_failed: "Instafy couldn't check this space's folder on this computer, so Claude Code didn't start.",
  claude_code_machine_stopped:
    "Instafy Desktop stopped on your computer while Claude Code was working, so the turn ended. Send it again to run it.",
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
    ...Object.keys(CLAUDE_CODE_UNSUPPORTED_SENTENCES).map(
      (reason) => describeClaudeCodeSendRefusal({ code: "claude_code_turn_unsupported", details: { reason } }) ?? "",
    ),
    describeClaudeCodeSendRefusal({ code: "claude_code_turn_engine_unknown", details: null }) ?? "",
    CLAUDE_CODE_STEER_REFUSED,
    claudeCodeWaitingLine({ isViewer: true, name: null }),
    claudeCodeWaitingLine({ isViewer: false, name: "Sam" }),
    claudeCodeWaitingLine(null),
    claudeCodeWaitingLine({ isViewer: true, name: null }, [
      runtimeEntry({ ready: false, reason: null, cli: null, verified: null, planSignIn: true, resetsAt: "2099-01-01T10:00:00Z" }),
    ]),
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

  it("words exactly the codes runtime-contracts lists: the runtime's, and the controller's stops and sweeps", () => {
    const codes = [...LANE.runtimeFailureCodes, ...LANE.stopAndSweepFailureCodes];
    expect(codes.length).toBeGreaterThan(0);
    expect(Object.keys(CLAUDE_CODE_FAILURE_SENTENCES).sort()).toEqual([...codes].sort());
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
    // The moment the runtime adds in UTC reads in the reader's own clock, never as UTC.
    const utc = sentence("Claude AI usage limit reached\nThe limit resets at 2026-11-14 23:03 UTC.");
    expect(utc).not.toContain("UTC");
    expect(utc).toMatch(new RegExp(`^${base} at .+\\.$`, "u"));
    expect(utc).toContain(
      new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(Date.UTC(2026, 10, 14, 23, 3))),
    );
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

  // docs/Local-Engine-Turns.md 11.4, 11.6: the refusals a send to a Claude
  // Code agent can get, before anything is recorded.
  it("words every send refusal by its code, and a turn Claude Code can't take by its reason", () => {
    const refusal = (code: string, details: unknown = null) => describeClaudeCodeSendRefusal({ code, details });
    expect(refusal("claude_code_turn_not_allowed")).toBe(
      "Claude Code turns aren't on for your account. Choose another AI for this agent in Your AI.",
    );
    const unsupported = (reason: unknown) => refusal("claude_code_turn_unsupported", { reason });
    expect(unsupported("browser")).toBe("Claude Code can't use Instafy's browser. Ask an agent that uses another AI.");
    expect(unsupported("team_plan")).toBe("Claude Code agents can't take part in a team plan yet.");
    expect(unsupported("attachments")).toBe("Claude Code can't take attachments yet. Send your message without them.");
    expect(unsupported("command")).toBe(
      "Claude Code reads a message that starts with / as its own command, so it wasn't sent. Start your message another way.",
    );
    expect(unsupported("empty")).toBe("There's nothing to send.");
    expect(unsupported("too_long")).toBe("Claude Code takes messages of at most 100,000 characters.");
    expect(unsupported("execution_mode")).toBe("Claude Code can't take a turn that waits for your approval.");
    expect(unsupported("write_scope")).toBe(
      "Claude Code can't be held to part of the space's files while other agents write, so it can't take this turn. Send it the message on its own.",
    );
    expect(unsupported("instafy_feature")).toBe("Claude Code can't do this: it needs one of Instafy's own tools.");
    expect(unsupported("delegated")).toBe(
      "Claude Code takes turns only from its own person, never from another agent's job.",
    );
    // A reason this client does not know yet, or none, never shows the
    // controller's raw text.
    expect(unsupported("something_new")).toBe("Claude Code couldn't take this message.");
    expect(unsupported(null)).toBe("Claude Code couldn't take this message.");
    expect(refusal("claude_code_turn_unsupported")).toBe("Claude Code couldn't take this message.");
    expect(Object.keys(CLAUDE_CODE_UNSUPPORTED_SENTENCES).sort()).toEqual(
      [
        "attachments",
        "browser",
        "command",
        "delegated",
        "empty",
        "execution_mode",
        "instafy_feature",
        "team_plan",
        "too_long",
        "write_scope",
      ],
    );
  });

  // Version 1's refusals are gone (11.14): any other Claude Code code reads
  // the one plain sentence, and a code that is not Claude Code's is not its
  // to word.
  it("words any other Claude Code refusal plainly, and no other code", () => {
    const refusal = (code: string) => describeClaudeCodeSendRefusal({ code, details: { reason: "turn_active" } });
    for (const code of [
      "claude_code_turn_not_person",
      "claude_code_turn_not_plain",
      "claude_code_conversation_granted",
      "claude_code_turn_active",
      "claude_code_machine_busy",
      "claude_code_runtime_not_ready",
      "claude_code_turn_engine_unknown",
    ]) {
      expect(refusal(code), code).toBe("Claude Code couldn't take this message.");
    }
    expect(Object.keys(CLAUDE_CODE_SEND_REFUSAL_SENTENCES)).toEqual(["claude_code_turn_not_allowed"]);
    expect(refusal("dispatch_lane_busy")).toBeNull();
    expect(refusal("project_not_found")).toBeNull();
  });

  it("words a refused Steer, and only Claude Code's own refusal", () => {
    expect(CLAUDE_CODE_TURN_PRESENTATION.describeSteerRefusal("claude_code_turn_takes_no_input")).toBe(
      "This Claude Code turn can't take more words while it runs. Queue your message instead.",
    );
    expect(CLAUDE_CODE_TURN_PRESENTATION.describeSteerRefusal("no_active_job")).toBeNull();
  });

  // 11.14: while no computer has taken it, by viewer.
  it("waits for its person's computer, or their Claude plan's limit while one of their computers holds it", () => {
    const now = Date.UTC(2026, 10, 19, 12, 0);
    const holding = (resetsAt: string, runtimeId = "runtime-1") =>
      runtimeEntry({ ready: false, reason: null, cli: "2.1.325", verified: true, planSignIn: true, resetsAt }, runtimeId);
    expect(claudeCodeWaitingLine({ isViewer: true, name: "Sam" }, [], now)).toBe("Waiting for your computer…");
    expect(claudeCodeWaitingLine({ isViewer: false, name: "Sam" }, [], now)).toBe("Waiting for Sam's computer…");
    expect(claudeCodeWaitingLine({ isViewer: false, name: null }, [], now)).toBe("Waiting for the sender's computer…");
    expect(claudeCodeWaitingLine(null, [], now)).toBe("Waiting for the sender's computer…");

    const at = Date.UTC(2026, 10, 19, 14, 30);
    const local = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(at));
    expect(claudeCodeWaitingLine({ isViewer: true, name: null }, [holding("2026-11-19T14:30:00Z")], now)).toBe(
      `Waiting for your Claude plan's limit to reset at ${local}…`,
    );
    // The earliest reset of the person's computers here, never a past one.
    expect(
      claudeCodePlanLimitResetsAt([holding("2026-11-19T16:00:00Z", "a"), holding("2026-11-19T14:30:00Z", "b")], now),
    ).toBe(at);
    expect(claudeCodePlanLimitResetsAt([holding("2026-11-19T11:00:00Z")], now)).toBeNull();
    // A ready computer of theirs takes the turn: it waits for nothing else.
    const ready = runtimeEntry({ ready: true, reason: null, cli: "2.1.325", verified: true, planSignIn: true }, "c");
    expect(claudeCodePlanLimitResetsAt([holding("2026-11-19T14:30:00Z"), ready], now)).toBeNull();
    expect(claudeCodeWaitingLine({ isViewer: true, name: null }, [holding("2026-11-19T14:30:00Z"), ready], now)).toBe(
      "Waiting for your computer…",
    );
    // Only the person's own computers say anything about their plan: a teammate reads whose computer it waits for.
    expect(claudeCodeWaitingLine({ isViewer: false, name: "Sam" }, [holding("2026-11-19T14:30:00Z")], now)).toBe(
      "Waiting for Sam's computer…",
    );
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
