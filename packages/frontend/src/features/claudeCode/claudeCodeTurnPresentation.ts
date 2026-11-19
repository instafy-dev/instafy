import type {
  FrontendTurnEnginePresentation,
  TurnEngineFailureInput,
  TurnEngineTurnOwner,
} from "../frontendFeatureModule";
import type { ControllerRuntimeStatusEntry } from "../../services/runtimeController/runtimes";
import {
  formatUsageLimitResetTime,
  usageLimitResetTimeForReader,
} from "../../conversations/usageLimitReset";

/**
 * How a Claude Code turn reads in the chat (docs/Local-Engine-Turns.md 5.5,
 * 5.7, 11.14). Every sentence follows docs/Chat-Activity.md: none says
 * "upstream", "provider", "credential", "runtime", "switch", "Codex",
 * "workspace" or "request", and none promises anything about price. "Claude
 * Code" is the tool a turn ran, never the name of something Instafy offers
 * (D28).
 */

/**
 * The engine id: the `provider` of an agent whose AI is Claude Code, and the
 * `aiAccessMode` the controller stamps on the turns it runs (11.3).
 */
export const CLAUDE_CODE_TURN_ENGINE_ID = "claude-code";

/** The controller's stamp on a Claude Code turn's run and messages: `{ version: 1 }`. Only it writes the key. */
export const CLAUDE_CODE_STAMP_KEY = "claudeCode";
/** The code the controller copies onto a failed Claude Code turn's message (2.6, 2.9). */
export const CLAUDE_CODE_FAILURE_KEY = "claudeCodeFailure";
/** The refusal of a Steer into a Claude Code turn (2.8). */
export const CLAUDE_CODE_STEER_REFUSED_CODE = "claude_code_turn_takes_no_input";

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
  | "unsafe_import"
  | "unsafe_link"
  | "preflight_failed"
  | "claude_code_machine_stopped"
  | "run_once_interrupted";

/** What the person whose turn failed reads, by its code (5.5). */
export const CLAUDE_CODE_FAILURE_SENTENCES: Readonly<Record<ClaudeCodeFailureCode, string>> = Object.freeze({
  not_signed_in:
    "Claude Code isn't signed in on this computer. Open a terminal, run claude and sign in, then send your message again.",
  plan_limit:
    "Your Claude plan's usage limit was reached, so this turn stopped. Send your message again after it resets.",
  binary_missing:
    "Instafy Desktop can't find Claude Code on this computer. Set it up again in Your AI, then send your message again.",
  // The runtime refuses the copy, or a setting from the login shell that
  // Desktop granted with it (D26), with this one code.
  binary_unsafe:
    "Instafy Desktop won't start this copy of Claude Code because other accounts on this computer can change it, or a setting from your login shell (CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS) points somewhere it can't use. Set it up again in Your AI.",
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
  unsafe_import:
    "A CLAUDE.md, CLAUDE.local.md or AGENTS.md file in this space's folder brings in files that aren't part of the space, so Claude Code turns from Instafy can't run here.",
  unsafe_link: "This space links to a file outside it, so Claude Code turns from Instafy can't run here.",
  preflight_failed:
    "Instafy couldn't check this space's folder on this computer, so Claude Code didn't start.",
  claude_code_machine_stopped:
    "Instafy Desktop stopped on your computer while Claude Code was working, so the turn ended. Send it again to run it.",
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

/** What everyone but the person whose turn it was reads for a failed turn (5.5). */
export function claudeCodeTeammateFailureSentence(ownerName: string | null): string {
  return `Claude Code couldn't finish this turn on ${possessive(ownerName)} computer.`;
}

/** A send the controller refused because a turn it would start runs on Claude Code (11.4, 11.6). */
export const CLAUDE_CODE_TURN_NOT_ALLOWED_CODE = "claude_code_turn_not_allowed";
/** The refusal of a turn Claude Code can't take, whose `details.reason` says why (11.4). */
export const CLAUDE_CODE_TURN_UNSUPPORTED_CODE = "claude_code_turn_unsupported";

/** What the sender reads for a send the controller refused, by its code (11.6). */
export const CLAUDE_CODE_SEND_REFUSAL_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  [CLAUDE_CODE_TURN_NOT_ALLOWED_CODE]:
    "Claude Code turns aren't on for your account. Choose another AI for this agent in Your AI.",
});

/** Why Claude Code can't take a turn, as `claude_code_turn_unsupported` names it in `details.reason` (11.4). */
export type ClaudeCodeUnsupportedReason =
  | "browser"
  | "team_plan"
  | "attachments"
  | "command"
  | "empty"
  | "too_long"
  | "execution_mode"
  | "write_scope"
  | "instafy_feature"
  | "delegated";

/** What the sender reads for a turn Claude Code can't take, by its reason (11.4). */
export const CLAUDE_CODE_UNSUPPORTED_SENTENCES: Readonly<Record<ClaudeCodeUnsupportedReason, string>> = Object.freeze({
  browser: "Claude Code can't use Instafy's browser. Ask an agent that uses another AI.",
  team_plan: "Claude Code agents can't take part in a team plan yet.",
  attachments: "Claude Code can't take attachments yet. Send your message without them.",
  command:
    "Claude Code reads a message that starts with / as its own command, so it wasn't sent. Start your message another way.",
  empty: "There's nothing to send.",
  too_long: "Claude Code takes messages of at most 100,000 characters.",
  execution_mode: "Claude Code can't take a turn that waits for your approval.",
  // A message to several agents that write at once: Claude Code can't be
  // held to its part of the files. Without a write it runs read-only.
  write_scope:
    "Claude Code can't be held to part of the space's files while other agents write, so it can't take this turn. Send it the message on its own.",
  // A turn that needs one of Instafy's own tools: a space review, a repo
  // import, a preview it asks for.
  instafy_feature: "Claude Code can't do this: it needs one of Instafy's own tools.",
  // A send an agent's job makes: an agent reads what teammates wrote, so its
  // words could be theirs (11.5).
  delegated: "Claude Code takes turns only from its own person, never from another agent's job.",
});

// A refusal code or reason the controller may add later: never its raw text,
// which can name the plumbing.
const OTHER_SEND_REFUSAL = "Claude Code couldn't take this message.";

/** A refused Steer into a running Claude Code turn (5.5). */
export const CLAUDE_CODE_STEER_REFUSED =
  "This Claude Code turn can't take more words while it runs. Queue your message instead.";

/** What the person whose turn it is reads once their computer took it, until its first step (5.7). */
export const CLAUDE_CODE_STARTING_LINE = "Starting Claude Code on this computer…";
/** The same when the chat cannot tell whose turn it is: it names no computer. */
const CLAUDE_CODE_STARTING_LINE_UNKNOWN_OWNER = "Starting Claude Code…";

/**
 * What a Claude Code turn reads once a computer took it, until its first
 * step (5.7), by viewer: it starts on its person's computer, never on a
 * teammate's, as the speaker line and the failure sentence say (5.5, D20).
 */
export function claudeCodeStartingLine(owner: TurnEngineTurnOwner | null): string {
  if (!owner) {
    return CLAUDE_CODE_STARTING_LINE_UNKNOWN_OWNER;
  }
  return owner.isViewer ? CLAUDE_CODE_STARTING_LINE : `Starting Claude Code on ${possessive(owner.name)} computer…`;
}

/** What the person whose turn it is reads while it waits for one of their computers (11.14). */
export const CLAUDE_CODE_WAITING_LINE = "Waiting for your computer…";

/**
 * When the viewer's own Claude Code holds their waiting turns until their
 * plan's limit resets (11.11), as epoch ms: the earliest reset still ahead
 * that one of their computers in this space reports. Null when none does, or
 * when one of them is ready, so a turn waits only for its lease.
 */
export function claudeCodePlanLimitResetsAt(
  runtimes: readonly ControllerRuntimeStatusEntry[],
  now: number = Date.now(),
): number | null {
  let earliest: number | null = null;
  for (const entry of runtimes) {
    const capability = entry.claudeCode;
    if (!capability) {
      continue;
    }
    if (capability.ready) {
      return null;
    }
    const resetsAt = capability.resetsAt ? Date.parse(capability.resetsAt) : Number.NaN;
    if (Number.isFinite(resetsAt) && resetsAt > now && (earliest === null || resetsAt < earliest)) {
      earliest = resetsAt;
    }
  }
  return earliest;
}

/**
 * What a Claude Code turn reads while it waits for a computer to take it
 * (its run is queued, 11.14), by viewer: its person waits for their own
 * computer, or for their Claude plan's limit while one of their computers
 * holds it (11.11), and everyone else for that person's computer.
 */
export function claudeCodeWaitingLine(
  owner: TurnEngineTurnOwner | null,
  runtimes: readonly ControllerRuntimeStatusEntry[] = [],
  now: number = Date.now(),
): string {
  if (!owner?.isViewer) {
    return `Waiting for ${possessive(owner?.name ?? null)} computer…`;
  }
  const resetsAt = claudeCodePlanLimitResetsAt(runtimes, now);
  return resetsAt === null
    ? CLAUDE_CODE_WAITING_LINE
    : `Waiting for your Claude plan's limit to reset at ${formatUsageLimitResetTime(resetsAt, now)}…`;
}

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
// "The limit resets at 2026-11-14 23:03 UTC.": the moment the runtime adds (runtime-agent `classify_failure`).
const RESET_IN_UTC_PATTERN = /\bresets?\s+(?:at\s+)?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?\s*UTC\b/i;
// "resets 2pm", "will reset at 5pm (America/Los_Angeles).", "resets in 3 hours".
const RESET_TIME_PATTERN = /\bresets?\s+(?:at\s+)?((?:in\s+)?\d[^\n]*?)\s*(?:\.(?:\s|$)|$)/im;

/**
 * When the plan's limit resets, or null: the moment the runtime names in UTC,
 * in the reader's own clock, else the time as the failure's own text says it.
 */
export function readClaudeCodeResetTime(
  rawText: string,
  readsPlainly: (text: string) => boolean,
): string | null {
  const moment = usageLimitResetTimeForReader(RESET_IN_UTC_PATTERN.exec(rawText)?.[0] ?? "");
  if (moment) {
    return moment;
  }
  const time = RESET_TIME_PATTERN.exec(rawText)?.[1]?.trim() ?? "";
  if (!time || time.length > MAX_RESET_TIME_LENGTH || !readsPlainly(time)) {
    return null;
  }
  return time;
}

/** The sentence the person whose turn failed reads (5.5). */
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

function isUnsupportedReason(value: unknown): value is ClaudeCodeUnsupportedReason {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CLAUDE_CODE_UNSUPPORTED_SENTENCES, value);
}

/**
 * The sentence for a send the controller refused, before it recorded
 * anything, because a turn it would start runs on Claude Code (11.4, 11.6),
 * or null for a code that is not Claude Code's.
 */
export function describeClaudeCodeSendRefusal(refusal: { code: string; details: unknown }): string | null {
  const code = refusal.code.trim();
  if (code === CLAUDE_CODE_TURN_UNSUPPORTED_CODE) {
    const reason = isRecord(refusal.details) ? refusal.details["reason"] : null;
    return isUnsupportedReason(reason) ? CLAUDE_CODE_UNSUPPORTED_SENTENCES[reason] : OTHER_SEND_REFUSAL;
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
  describeStart: claudeCodeStartingLine,
  describeWaiting: (owner: TurnEngineTurnOwner | null, runtimes: readonly ControllerRuntimeStatusEntry[]) =>
    claudeCodeWaitingLine(owner, runtimes),
  describeTurnFailure: describeClaudeCodeTurnFailure,
  describeTeammateTurnFailure: claudeCodeTeammateFailureSentence,
  describeSendRefusal: describeClaudeCodeSendRefusal,
  describeSteerRefusal: (code: string) =>
    code.trim() === CLAUDE_CODE_STEER_REFUSED_CODE ? CLAUDE_CODE_STEER_REFUSED : null,
  describeSpeaker: claudeCodeSpeakerLine,
});
