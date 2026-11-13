import type {
  FrontendTurnEnginePresentation,
  TurnEngineFailureInput,
  TurnEngineTurnOwner,
} from "../../conversations/runFailurePresentation";
import { CLAUDE_CODE_TURN_ENGINE_ID } from "./claudeCodeComposer";

/**
 * How a Claude Code turn reads in the chat (docs/Local-Engine-Turns.md 5.5,
 * 5.7). Every sentence follows docs/Chat-Activity.md: none says "upstream",
 * "provider", "credential", "runtime", "switch", "Codex", "workspace" or
 * "request", and none promises anything about price. "Claude Code" is the
 * tool a turn ran, never the name of something Instafy offers (D28).
 */

/** The controller's stamp on a Claude Code turn's run and messages: `{ version: 1 }`. Only it writes the key. */
export const CLAUDE_CODE_STAMP_KEY = "claudeCode";
/** The code the controller copies onto a failed Claude Code turn's message (2.6, 2.9). */
export const CLAUDE_CODE_FAILURE_KEY = "claudeCodeFailure";
/** The refusal of a Steer into a Claude Code turn (2.8). */
export const CLAUDE_CODE_STEER_REFUSED_CODE = "claude_code_turn_takes_no_input";
/** A busy chat's refusal, which a send that claims Claude Code gets in place of a queue entry (2.2). */
export const DISPATCH_LANE_BUSY_CODE = "dispatch_lane_busy";
/** G8's `details.reason` when the blocking turn's start window has passed. */
export const START_WINDOW_PASSED_REASON = "start_window_passed";

/** Why a Claude Code turn failed, as the runtime or the controller records it. */
export type ClaudeCodeFailureCode =
  | "not_signed_in"
  | "plan_limit"
  | "binary_missing"
  | "binary_unsafe"
  | "unsupported_version"
  | "probe_failed"
  | "bare_default"
  | "session_unavailable"
  | "turn_timeout"
  | "stalled"
  | "crashed"
  | "unexpected_configuration"
  | "project_config"
  | "unsafe_import"
  | "unsafe_link"
  | "preflight_failed"
  | "claude_code_machine_stopped"
  | "start_by_passed"
  | "run_once_interrupted";

/** What the person who sent a failed turn reads, by its code (5.5). */
export const CLAUDE_CODE_FAILURE_SENTENCES: Readonly<Record<ClaudeCodeFailureCode, string>> = Object.freeze({
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
  preflight_failed:
    "Instafy couldn't check this space's folder on this computer, so Claude Code didn't start.",
  claude_code_machine_stopped:
    "Instafy Desktop stopped on your computer while Claude Code was working, so the turn ended. Send it again to run it.",
  start_by_passed: "This Claude Code turn didn't start in time, so it won't run. Send it again.",
  run_once_interrupted:
    "This Claude Code turn stopped because Instafy on your computer stopped, and it won't run again. Send it again to start over.",
});

const NOT_SIGNED_IN_UNVERIFIED_VERSION =
  "If you're signed in, this newer Claude Code may no longer let other apps use your sign-in.";
const PLAN_LIMIT_WITH_RESET_TIME =
  "Your Claude plan's usage limit was reached, so this turn stopped. Send your message again after it resets";
const OTHER_FAILURE = "Claude Code stopped with an error.";
// The same sentence when the failure's own first line reads plainly.
const OTHER_FAILURE_BEFORE_LINE = "Claude Code stopped with an error:";

/** What everyone but the sender reads for a failed turn (5.5). */
export function claudeCodeTeammateFailureSentence(ownerName: string | null): string {
  return `Claude Code couldn't finish this turn on ${possessive(ownerName)} computer.`;
}

/** A send the controller refused, by its code (5.5). */
export const CLAUDE_CODE_SEND_REFUSAL_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  claude_code_turn_not_allowed: "Claude Code turns aren't on for your account yet.",
  claude_code_turn_not_person: "Claude Code takes only a message you send yourself.",
  claude_code_turn_not_plain:
    "Claude Code takes only a plain message to Octo, of at most 100,000 characters, without attachments or a command.",
  claude_code_conversation_granted:
    "In this chat, Octo takes turns only from the person who started the chat, so Claude Code can't run your message here.",
  claude_code_turn_active: "You already have a Claude Code turn running. Send this when it ends.",
  claude_code_machine_busy: "Your computer is busy with another turn. Send this when it's done.",
  claude_code_runtime_not_ready:
    "Your computer isn't connected to this space. Open this space in Instafy Desktop, then send your message again.",
  [DISPATCH_LANE_BUSY_CODE]: "Octo is still working on another message in this chat. Send this when it's done.",
});

const TURN_ACTIVE_START_WINDOW_PASSED =
  "Your last Claude Code turn didn't start in time. Send this again in a few seconds.";
// A refusal code the controller may add later: never its raw text, which
// can name the plumbing.
const OTHER_SEND_REFUSAL = "Claude Code couldn't take this message.";

/** A refused Steer into a running Claude Code turn (5.5). */
export const CLAUDE_CODE_STEER_REFUSED =
  "This Claude Code turn can't take more words while it runs. Queue your message instead.";

/** The sender's action on a failed turn: the composer gets the message back, with Claude Code chosen (5.6). */
export const CLAUDE_CODE_RESEND_LABEL = "Send again with Claude Code";

/** The plain-text line under a Claude Code reply's header (5.7, D20). */
export function claudeCodeSpeakerLine(owner: TurnEngineTurnOwner | null): string {
  if (owner?.isViewer) {
    return "Ran on your own Claude Code, on your computer";
  }
  return `Ran on ${possessive(owner?.name ?? null)} own Claude Code, on their computer`;
}

function possessive(name: string | null): string {
  const trimmed = name?.trim() ?? "";
  return trimmed ? `${trimmed}'s` : "the sender's";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailureCode(value: string): value is ClaudeCodeFailureCode {
  return Object.prototype.hasOwnProperty.call(CLAUDE_CODE_FAILURE_SENTENCES, value);
}

/** The failure code the controller copied onto a failed turn's message, or null. */
export function readClaudeCodeFailureCode(metadata: Record<string, unknown>): ClaudeCodeFailureCode | null {
  const value = metadata[CLAUDE_CODE_FAILURE_KEY];
  if (typeof value !== "string") {
    return null;
  }
  const code = value.trim();
  return isFailureCode(code) ? code : null;
}

const MAX_RESET_TIME_LENGTH = 48;
// "resets 2pm", "will reset at 5pm (America/Los_Angeles).", "resets in 3 hours".
const RESET_TIME_PATTERN = /\bresets?\s+(?:at\s+)?((?:in\s+)?\d[^\n]*?)\s*(?:\.(?:\s|$)|$)/im;

/** When the plan's limit resets, as the failure's own text says it, or null. */
export function readClaudeCodeResetTime(
  rawText: string,
  readsPlainly: (text: string) => boolean,
): string | null {
  const time = RESET_TIME_PATTERN.exec(rawText)?.[1]?.trim() ?? "";
  if (!time || time.length > MAX_RESET_TIME_LENGTH || !readsPlainly(time)) {
    return null;
  }
  return time;
}

/** The sentence the sender of a failed turn reads (5.5). */
export function describeClaudeCodeTurnFailure(failure: TurnEngineFailureInput): string {
  const code = readClaudeCodeFailureCode(failure.metadata);
  switch (code) {
    case null: {
      const line = failure.plainFirstLine?.trim() ?? "";
      return line ? `${OTHER_FAILURE_BEFORE_LINE} ${line}` : OTHER_FAILURE;
    }
    case "not_signed_in":
      // Only the runtime's own status entry says the version was not verified.
      return failure.runtime?.claudeCode?.verified === false
        ? `${CLAUDE_CODE_FAILURE_SENTENCES.not_signed_in} ${NOT_SIGNED_IN_UNVERIFIED_VERSION}`
        : CLAUDE_CODE_FAILURE_SENTENCES.not_signed_in;
    case "plan_limit": {
      const resetTime = readClaudeCodeResetTime(failure.rawText, failure.readsPlainly);
      if (!resetTime) {
        return CLAUDE_CODE_FAILURE_SENTENCES.plan_limit;
      }
      return /^in\s/i.test(resetTime)
        ? `${PLAN_LIMIT_WITH_RESET_TIME} ${resetTime}.`
        : `${PLAN_LIMIT_WITH_RESET_TIME} at ${resetTime}.`;
    }
    default:
      return CLAUDE_CODE_FAILURE_SENTENCES[code];
  }
}

/** The sentence for a send that claimed Claude Code and that the controller refused, or null. */
export function describeClaudeCodeSendRefusal(refusal: { code: string; details: unknown }): string | null {
  const code = refusal.code.trim();
  if (code === "claude_code_turn_active") {
    const reason = isRecord(refusal.details) ? refusal.details["reason"] : null;
    return reason === START_WINDOW_PASSED_REASON
      ? TURN_ACTIVE_START_WINDOW_PASSED
      : CLAUDE_CODE_SEND_REFUSAL_SENTENCES.claude_code_turn_active;
  }
  if (Object.prototype.hasOwnProperty.call(CLAUDE_CODE_SEND_REFUSAL_SENTENCES, code)) {
    return CLAUDE_CODE_SEND_REFUSAL_SENTENCES[code] ?? null;
  }
  return code.startsWith("claude_code_") ? OTHER_SEND_REFUSAL : null;
}

/** Whether the controller stamped this message as a Claude Code turn's (2.1); a client cannot. */
export function isClaudeCodeControllerStamped(metadata: Record<string, unknown>): boolean {
  const stamp = metadata[CLAUDE_CODE_STAMP_KEY];
  return (
    metadata["aiAccessMode"] === CLAUDE_CODE_TURN_ENGINE_ID &&
    isRecord(stamp) &&
    stamp["version"] === 1
  );
}

export const CLAUDE_CODE_TURN_PRESENTATION: FrontendTurnEnginePresentation = Object.freeze({
  isControllerStamped: isClaudeCodeControllerStamped,
  describeTurnFailure: describeClaudeCodeTurnFailure,
  describeTeammateTurnFailure: claudeCodeTeammateFailureSentence,
  describeSendRefusal: describeClaudeCodeSendRefusal,
  describeSteerRefusal: (code: string) =>
    code.trim() === CLAUDE_CODE_STEER_REFUSED_CODE ? CLAUDE_CODE_STEER_REFUSED : null,
  describeSpeaker: claudeCodeSpeakerLine,
  resendLabel: CLAUDE_CODE_RESEND_LABEL,
});
