import type { ControllerRuntimeClaudeCodeNotReadyReason } from "../../services/runtimeController/runtimes";
import type { ClaudeCodeDesktopProblem, ClaudeCodeShellSetting } from "./claudeCodeDesktop";

/**
 * Every sentence Studio shows about Claude Code outside a turn's own row
 * (docs/Local-Engine-Turns.md 5.3, 5.4, 11.3, 11.14). They state plainly that
 * a turn runs the person's own Claude Code, never make "Claude Code" the name
 * of an Instafy feature (D28), never say "included", "free" or "unlimited" or
 * mention credits, and use none of the words docs/Chat-Activity.md keeps out
 * of failure sentences.
 */
export const CLAUDE_CODE_COPY = {
  /** Only when this computer's runtime reports a Claude plan sign-in (5.4). */
  planLine: "Runs on your own Claude plan, under Anthropic's current terms.",
  signInLine: "Uses your own Claude Code sign-in, under Anthropic's current terms.",

  notReadyYet: "Claude Code isn't ready on this computer yet.",
  notReady: {
    binary_missing:
      "Instafy Desktop can't find Claude Code on this computer. Set it up again in Your AI.",
    // The runtime refuses the copy, or a setting from the login shell that
    // Desktop granted with it (D26): it can't tell the person which.
    binary_unsafe:
      "Instafy Desktop won't start this copy of Claude Code because other accounts on this computer can change it, or a setting from your login shell (CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS) points somewhere it can't use. Set it up again in Your AI.",
    probe_failed: "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
    unsupported_version:
      "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
    bare_default:
      "This version of Claude Code no longer lets other apps use your sign-in for a turn, so Instafy can't use it yet.",
    plan_limit: "Your Claude plan's usage limit was reached. Claude Code takes turns again once it resets.",
  } satisfies Record<ControllerRuntimeClaudeCodeNotReadyReason, string>,

  /** Claude Code as an agent's AI, in Your AI's agent editor (11.3). */
  agentAi: {
    label: "Claude Code",
    description: "Runs on your own Claude Code, on your computer. Its turns wait while your computer is off.",
    /** In Instafy Desktop, on a computer where Claude Code isn't set up yet. */
    setUpHere:
      "Claude Code isn't set up on this computer yet. Set it up in Connections, under Claude Code on this computer.",
    /** A save the controller refused because the switch doesn't cover the person (11.3). */
    notAllowed: "Claude Code turns aren't on for your account.",
    /** A save naming a login that is no longer the person's, such as one just deleted (11.19). */
    loginUnknown: "That Claude Code login is no longer one of yours. Choose another login.",
    /** The editor's choice of which of the person's logins the agent's turns run on (11.19). */
    login: "Login",
    /** After the oldest login's name: an agent that names none runs on it. */
    firstLogin: "(first login)",
  },

  /** What a waiting turn's row adds for its person: what makes it run (11.14). */
  waiting: {
    startHere: "Start this space on this computer to run it.",
    startAction: "Start",
    startingAction: "Starting…",
    elsewhere: "It runs when Instafy Desktop runs this space on your computer.",
    setUpHere: "Set up Claude Code on this computer in Your AI to run it here.",
    /** Claude Code is set up here, but not the login the turn runs on (11.19). */
    loginNotHere:
      "The Claude Code login this turn runs on isn't set up on this computer. Set it up in Your AI to run it here.",
  },

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
    enable: "Use Claude Code on this computer",
    disable: "Turn off",
    on: "On. Your agents that use Claude Code take their turns here while this computer runs their space.",
    off: "Off. Choose Use Claude Code on this computer to turn it on.",
    /**
     * Off, while Desktop has no find to offer and no problem to report: before
     * any Find or Locate, or after Turn off when it holds none. After one that
     * turned up nothing it can use, the row gives Desktop's reason instead.
     */
    offNotFound: "Off. Choose Find or Locate… to pick the claude program, then Use Claude Code on this computer.",
    /** While Desktop replaces this computer's runtime after a change that leaves it on (4.3). */
    checking: "Checking this computer…",
    ready: "Ready on this computer.",
    notRunning: "Start this space on this computer to check it here.",
    notReadyYet: "Claude Code isn't ready on this computer yet. It's checked again when this space starts.",
    notReady: {
      binary_missing: "Instafy Desktop can't find Claude Code at this path. Find it again, or Locate it.",
      binary_unsafe:
        "Other accounts on this computer can change this copy of Claude Code, or a setting from your login shell (CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS) points somewhere it can't use, so Instafy Desktop won't start it. Locate a copy only you can change, or fix that setting, then choose Find.",
      probe_failed: "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
      unsupported_version: "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
      bare_default:
        "This version of Claude Code no longer lets other apps use your sign-in for a turn, so Instafy can't use it yet.",
      plan_limit: "Your Claude plan's usage limit was reached. Claude Code takes turns again once it resets.",
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
      // When Desktop does not name the setting; see claudeCodeDesktopProblemSentence.
      shell_setting_unusable:
        "Your login shell sets CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS to something Instafy Desktop can't use. It must be the full path of a folder or file that only you can change. Fix it, then choose Find.",
    } satisfies Record<ClaudeCodeDesktopProblem, string>,
    /** A login-shell setting Desktop can't use, by its name (D26). */
    shellSettings: {
      CLAUDE_CONFIG_DIR:
        "Your login shell sets CLAUDE_CONFIG_DIR to something Instafy Desktop can't use. It must be the full path of a folder that only you can change. Fix it, then choose Find.",
      NODE_EXTRA_CA_CERTS:
        "Your login shell sets NODE_EXTRA_CA_CERTS to something Instafy Desktop can't use. It must be the full path of a file that only you can change. Fix it, then choose Find.",
    } satisfies Record<ClaudeCodeShellSetting, string>,
    /** While it is on: another copy Find or Locate turned up, which turns don't use yet. */
    candidateFoundAt: "Also found at",
    candidateUse: "Choose Use Claude Code on this computer to use it instead.",
    /**
     * While it is on: Find read login-shell settings for the copy in use that
     * Instafy Desktop can use in place of the ones it has, which it no longer
     * can (D26). Turns don't use them yet.
     */
    candidateRenewed:
      "Find read new settings from your login shell that Instafy Desktop can use with this copy. Choose Use Claude Code on this computer to use them.",
    /** While it is on: Find turned up nothing, and the copy in use stays. */
    candidateNotFound: "Find didn't turn up any other copy, so this one stays in use.",
    actionFailed: "Instafy Desktop couldn't do that. Try again.",
    /**
     * The one-time note once it is on (5.3). It is left out while this
     * computer's runtime reports a Claude plan sign-in, the one kind of
     * sign-in a runtime reports, and while the row checks a new runtime.
     */
    firstUse: "Sign in to Claude Code on this computer first: run claude in a terminal once.",
    firstUseDismiss: "Got it",
    /**
     * The person's Claude Code logins (11.19): each a Claude Code folder they
     * signed in to themselves, one subscription each, with what this
     * computer says of it. A folder shows only on its own computer.
     */
    logins: {
      title: "Logins",
      /** The name of the first login Use Claude Code on this computer makes, unless the person names it. */
      defaultLabel: "Claude Code",
      usualFolder: "Claude Code's usual folder",
      notSetUpHere: "Not set up on this computer",
      /** A login this computer has set up that the person deleted, from here or another computer. */
      deleted: "A login you deleted",
      ready: "Ready.",
      notSignedIn:
        "Not signed in yet. In a terminal, run claude with CLAUDE_CONFIG_DIR set to this folder and sign in with /login.",
      notSignedInUsualFolder: "Not signed in yet. In a terminal, run claude and sign in with /login.",
      planLimitBefore: "Reached its Claude plan's limit. Ready again at",
      planLimitNoTime: "Reached its Claude plan's limit. Ready again once it resets.",
      /** Desktop or this computer's checks refuse the folder (its owner, its mode, where it is). */
      folderUnusable:
        "Instafy Desktop can't use this folder. It must be a folder that only you can change, outside the folders Instafy uses. Fix it, or remove this login from this computer and set it up again.",
      /** Set up here, and this computer's check hasn't reached it yet. */
      notCheckedYet: "Not checked on this computer yet. It's checked again when this space starts.",
      setUp: "Set up on this computer",
      rename: "Rename",
      removeHere: "Remove from this computer",
      delete: "Delete",
      add: "Add a login",
      name: "Name",
      folder: "Folder",
      chooseFolder: "Choose a folder…",
      addSubmit: "Add login",
      setUpSubmit: "Set up",
      save: "Save",
      cancel: "Cancel",
      /** In place of Add a login once the person has the most logins there can be. */
      atLimit: "You have 10 Claude Code logins, the most you can have.",
      /** Asked before Delete removes a login everywhere (docs/Settings-UI.md, Your AI). */
      deleteConfirm: "Agents that use it switch to your first login.",
      errors: {
        notAllowed: "Claude Code turns aren't on for your account.",
        labelInvalid: "A login's name is 1 to 60 characters on one line, and can't hold double quotes or invisible characters.",
        labelTaken: "You already have a login with this name. Choose another.",
        limit: "You have 10 Claude Code logins, the most you can have.",
        notFound: "That login is gone. It may have been deleted on another computer.",
        listFailed: "Instafy couldn't load your Claude Code logins. Try again.",
        changeFailed: "Instafy couldn't change your Claude Code logins. Try again.",
      },
    },
  },
} as const;

/**
 * What the controller's refusal of a change to the person's logins reads as,
 * by its code (docs/Local-Engine-Turns.md 11.19); a plain sentence for any
 * other refusal, whose raw text could name the plumbing.
 */
export function claudeCodeLoginRefusalSentence(code: string | null): string {
  const errors = CLAUDE_CODE_COPY.yourAi.logins.errors;
  switch (code) {
    case "claude_code_turn_not_allowed":
      return errors.notAllowed;
    case "claude_code_login_label_invalid":
      return errors.labelInvalid;
    case "claude_code_login_label_taken":
      return errors.labelTaken;
    case "claude_code_login_limit":
      return errors.limit;
    case "not_found":
      return errors.notFound;
    default:
      return errors.changeFailed;
  }
}

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

/**
 * Why Desktop won't use a copy of Claude Code, in words: for a login-shell
 * setting it can't use, the setting by name when Desktop named it.
 */
export function claudeCodeDesktopProblemSentence(
  problem: ClaudeCodeDesktopProblem,
  shellSetting: ClaudeCodeShellSetting | null,
): string {
  if (problem === "shell_setting_unusable" && shellSetting) {
    return CLAUDE_CODE_COPY.yourAi.shellSettings[shellSetting];
  }
  return CLAUDE_CODE_COPY.yourAi.problems[problem];
}
