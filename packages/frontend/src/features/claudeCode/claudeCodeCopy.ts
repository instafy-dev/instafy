import type { ControllerRuntimeClaudeCodeNotReadyReason } from "../../services/runtimeController/runtimes";
import type { ClaudeCodeDesktopProblem } from "./claudeCodeDesktop";

/**
 * Every sentence the composer shows for Claude Code turns
 * (docs/Local-Engine-Turns.md 5.1, 5.4). They state plainly that a turn runs
 * the person's own Claude Code, never make "Claude Code" the name of an
 * Instafy feature (D28), never say "included", "free" or "unlimited" or
 * mention credits, and use none of the words docs/Chat-Activity.md keeps out
 * of failure sentences.
 */
export const CLAUDE_CODE_COPY = {
  rowTitle: "Claude Code for the next message",
  /** Only when this computer's runtime reports a Claude plan sign-in (5.4). */
  planLine: "Runs on your own Claude plan, under Anthropic's current terms.",
  signInLine: "Uses your own Claude Code sign-in, under Anthropic's current terms.",
  rowHint:
    "Instafy gives Claude Code only your message. Everyone who can see this chat sees its steps and reply.",
  tokenLabel: "Claude Code · next message",
  tokenCancel: "Don't use Claude Code",
  startAction: "Start on this computer",

  inThread: "Claude Code takes messages in a chat, not in a thread.",
  notSetUp: "Set up Claude Code on this computer in Your AI first.",
  notRunningHere: "This space isn't running on this computer.",
  notReadyYet: "Claude Code isn't ready on this computer yet.",
  notReady: {
    binary_missing:
      "Instafy Desktop can't find Claude Code on this computer. Set it up again in Your AI.",
    binary_unsafe:
      "Instafy Desktop won't start this copy of Claude Code because other accounts on this computer can change it. Set it up again in Your AI.",
    probe_failed: "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
    unsupported_version:
      "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
    bare_default:
      "This version of Claude Code no longer lets other apps use your sign-in for a turn, so Instafy can't use it yet.",
  } satisfies Record<ControllerRuntimeClaudeCodeNotReadyReason, string>,

  sendNotYours: "Claude Code takes only a message you send yourself.",
  sendWhileReplying: "Octo is still working on another message in this chat. Send this when it's done.",
  sendQueued:
    "Claude Code messages aren't queued. Send this when Octo is done, or remove Claude Code to queue it.",
  sendFromBrowser: "Claude Code takes messages from the chat, not from the browser.",
  sendNewTab:
    "Claude Code can't ask for a new browser tab. Cancel the new tab to send this to Claude Code.",
  sendAttachments: "Claude Code takes your message without images. Remove them to send it.",
  sendCommand: "Claude Code takes a plain message, not a command.",
  sendNotOcto: "Claude Code takes only a message to Octo.",
  sendTooLong: "Claude Code takes at most 100,000 characters in one message.",
  sendInvitePrompt:
    "This message would first invite someone into this private chat, so Claude Code can't take it. Invite them first, then send it.",
  sendNotAllowed: "Claude Code turns aren't on for your account yet.",
  sendNotConnected:
    "Your computer isn't connected to this space. Start it on this computer, then send your message.",
  sendNotChecked: "Instafy couldn't check Claude Code on this computer. Try again in a moment.",

  /**
   * The Your AI row (5.3). Like the Instafy AI row it is not a connection, and
   * unlike it, it is never the default.
   */
  yourAi: {
    title: "Claude Code on this computer",
    foundAt: "Found at",
    notFound: "Not found",
    find: "Find",
    locate: "Locate…",
    enable: "Use for my messages",
    disable: "Turn off",
    on: "On for your messages when you choose it in the composer.",
    off: "Off. Choose Use for my messages to turn it on for this computer.",
    checking: "Checking this computer…",
    ready: "Ready on this computer.",
    notRunning: "Start this space on this computer to check it here.",
    notReadyYet: "Claude Code isn't ready on this computer yet. It's checked again when this space starts.",
    notReady: {
      binary_missing: "Instafy Desktop can't find Claude Code at this path. Find it again, or Locate it.",
      binary_unsafe:
        "Other accounts on this computer can change this copy of Claude Code, so Instafy Desktop won't start it. Locate a copy only you can change.",
      probe_failed: "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
      unsupported_version: "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
      bare_default:
        "This version of Claude Code no longer lets other apps use your sign-in for a turn, so Instafy can't use it yet.",
    } satisfies Record<ControllerRuntimeClaudeCodeNotReadyReason, string>,
    problems: {
      not_found: "Instafy Desktop didn't find Claude Code. Install it, or Locate the claude program.",
      relative_path: "Instafy Desktop can't run the file at this path. Locate the claude program.",
      missing: "Instafy Desktop can't run the file at this path. Locate the claude program.",
      not_a_file: "Instafy Desktop can't run the file at this path. Locate the claude program.",
      not_executable: "Instafy Desktop can't run the file at this path. Locate the claude program.",
      too_many_links: "Instafy Desktop can't run the file at this path. Locate the claude program.",
      foreign_owner:
        "Other accounts on this computer can change this file, so Instafy Desktop won't use it. Locate a copy only you can change.",
      writable_by_others:
        "Other accounts on this computer can change this file, so Instafy Desktop won't use it. Locate a copy only you can change.",
      inside_instafy_folder:
        "This file is inside a folder Instafy uses, so Instafy Desktop won't use it. Locate the claude program you installed.",
    } satisfies Record<ClaudeCodeDesktopProblem, string>,
    actionFailed: "Instafy Desktop couldn't do that. Try again.",
    /** The one-time note once it is on (5.3). */
    firstUse: "Sign in to Claude Code on this computer first: run claude in a terminal once.",
    firstUseDismiss: "Got it",
  },
} as const;

/** Why this computer's Claude Code cannot take a turn, in words. */
export function claudeCodeNotReadySentence(
  reason: ControllerRuntimeClaudeCodeNotReadyReason | null,
): string {
  return reason ? CLAUDE_CODE_COPY.notReady[reason] : CLAUDE_CODE_COPY.notReadyYet;
}

/** The plan or sign-in line (5.4). */
export function claudeCodeSignInLine(planSignIn: boolean): string {
  return planSignIn ? CLAUDE_CODE_COPY.planLine : CLAUDE_CODE_COPY.signInLine;
}
