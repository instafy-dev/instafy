import {
  REVERT_ROUTE_UNAVAILABLE_MESSAGE,
  type RevertWorkspaceGitCommitResult,
} from "../../../services/runtimeController/workspaceGit";
import type { ChatMessageFileNotSaved, ChatMessageUnsavedReason } from "../types";

// Copy for the chat change card's save state. Work that did not reach the
// space's saved history is kept on an unsaved-work ref. Only a space whose
// History lists Unsaved work can point there; elsewhere the copy says the
// work is kept without naming a place the UI does not show.
export interface UnsavedWorkPlacement {
  unsavedWorkInHistory: boolean;
  // The space keeps versions the old way, so Changes still has Save version.
  saveVersionInChanges?: boolean;
}

function keptAs({ unsavedWorkInHistory }: UnsavedWorkPlacement): string {
  return unsavedWorkInHistory ? "kept under History, in Unsaved work" : "kept as unsaved work";
}

const SAVING_OFF_MESSAGE = "Saving is turned off on this space's runtime, so these changes weren't saved to the space.";

// The message-level note when the turn's save failed or did not run.
export function describeUnsavedChanges(reason: ChatMessageUnsavedReason, placement: UnsavedWorkPlacement): string {
  if (reason === "auto_save_off") {
    // Only the runtime-wide setting turns saving off now. It applies to every
    // turn, so no later turn saves these, and nothing is kept as unsaved work.
    return placement.saveVersionInChanges
      ? `${SAVING_OFF_MESSAGE} To save them, open Changes and use Save version.`
      : SAVING_OFF_MESSAGE;
  }
  // Every turn saves, so the next turn picks up what this one left behind.
  return `These changes weren't saved to the space yet. The agent saves them at its next turn, and anything left over is ${keptAs(placement)}.`;
}

// The space's file rules, in the words both the per-file reasons and a
// refused revert use.
const EXCLUDED_FOLDERS_RULE = "Build output, dependency and cache folders aren't saved to the space.";
const SECRET_FILES_RULE = "Secret files stay out of the space.";
const ATTACHMENT_FILES_RULE = "Old chat upload files aren't saved to the space.";

// Why one file of the turn was left out of the saved history.
export function describeFileNotSaved(notSaved: ChatMessageFileNotSaved, placement: UnsavedWorkPlacement): string {
  if (notSaved.reason === "conflicted") {
    return `Changed in the space while the agent worked. The agent's version is ${keptAs(placement)}.`;
  }
  const reason = (() => {
    switch (notSaved.reason) {
      case "excluded":
        return EXCLUDED_FOLDERS_RULE;
      case "secret":
        return `${SECRET_FILES_RULE} Use Secrets for these values.`;
      case "ignored":
        return "This file matches .gitignore, so it isn't saved to the space.";
      case "too_large":
        return "Larger than 20 MB, so it isn't saved to the space.";
      case "attachment":
        return ATTACHMENT_FILES_RULE;
      case "policy":
        return "This space's file rules refused this file.";
      case "unsupported":
        return "Links and special files can't be saved.";
      default:
        return "The space didn't save this file.";
    }
  })();
  return notSaved.keptSavedVersion ? `${reason} The saved version is unchanged.` : reason;
}

// "a, b and 3 more": names a few paths without growing the toast.
function formatPathList(paths: readonly string[], max = 3): string {
  const named = paths.slice(0, max);
  const rest = paths.length - named.length;
  if (rest > 0) {
    return `${named.join(", ")} and ${rest} more`;
  }
  if (named.length <= 1) {
    return named.join("");
  }
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

// The confirm dialog of "Revert this change". Before it offers Revert it
// lists the files the change's saved version touched: a version can carry
// more than this card's files (earlier work saved with it), and a revert
// undoes all of it.
export const REVERT_CHECKING_MESSAGE = "Checking what this change includes…";
export const REVERT_CONFIRM_MESSAGE = "A new version that undoes it is saved on top. Nothing is removed from history.";
export const REVERT_CHECK_FAILED_MESSAGE = "Couldn't check what this change includes. Try again.";

export function describeRevertOtherWork(otherPaths: readonly string[], canAskAgent: boolean): string {
  const undo = `This change was saved together with other work, so reverting it here would also undo ${formatPathList(otherPaths)}.`;
  return canAskAgent ? `${undo} Ask the agent to undo just this change.` : undo;
}

export interface ChangeRevertOutcome {
  intent: "success" | "info" | "warning" | "error";
  message: string;
  // A new version that undoes the change reached the saved history.
  reverted: boolean;
  // Paths the revert left as they were (a Desktop origin's partial publish).
  unrevertedPaths: string[];
  // Asking the agent is the way forward; the card offers it when the change
  // belongs to a message.
  offerAgentUndo: boolean;
}

// The file rule that refused a path a revert would bring back (a 422 from
// the path policy), or null for any other failure. A refusal like this
// happens again on every attempt, so the copy never says to try again.
function refusedPathRule(code: string | null, reason: string | null): string | null {
  switch (code) {
    case "excluded_path":
      if (reason === "secret") {
        return SECRET_FILES_RULE;
      }
      if (reason === "attachment") {
        return ATTACHMENT_FILES_RULE;
      }
      return EXCLUDED_FOLDERS_RULE;
    case "ignored_path":
      return "Files that match .gitignore aren't saved to the space.";
    case "policy_rejected":
      return reason === "too_large"
        ? "Files larger than 20 MB aren't saved to the space."
        : "This space's file rules refused one of its files.";
    default:
      return null;
  }
}

const BUSY_MESSAGE = "The space is busy saving other changes. Try again in a moment.";
const STILL_LOADING_MESSAGE = "The space is still loading. Try again in a moment.";
const UNREACHABLE_MESSAGE = "Couldn't reach the space's saved files. Try again.";

const FETCH_PENDING_RETRY_DEFAULT_MS = 2000;
const FETCH_PENDING_RETRY_MAX_MS = 5000;

// A gateway still fetching the space's saved history answers 503
// fetch_pending with Retry-After. Nothing was committed, so the card retries
// once after that delay (at most 5 s). Null for every other result.
export function revertRetryDelayMs(result: RevertWorkspaceGitCommitResult | null): number | null {
  if (!result || result.ok) {
    return null;
  }
  const code = result.code ?? result.errorInfo?.code ?? null;
  if (code !== "fetch_pending") {
    return null;
  }
  const retryAfter = result.errorInfo?.retryAfterMs;
  const delay =
    typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
      ? retryAfter
      : FETCH_PENDING_RETRY_DEFAULT_MS;
  return Math.min(delay, FETCH_PENDING_RETRY_MAX_MS);
}
const FALLBACK_MESSAGE = "Couldn't revert this change. Try again, or ask the agent to undo it.";

// What "Revert this change" did, as one toast: the request is
// `/git/revert-commit {commit: head}`, which undoes that saved version's own
// change (against its first parent).
export function describeChangeRevertOutcome(result: RevertWorkspaceGitCommitResult | null): ChangeRevertOutcome {
  const outcome = (
    intent: ChangeRevertOutcome["intent"],
    message: string,
    extra: Partial<Omit<ChangeRevertOutcome, "intent" | "message">> = {},
  ): ChangeRevertOutcome => ({ intent, message, reverted: false, unrevertedPaths: [], offerAgentUndo: false, ...extra });

  if (!result) {
    return outcome("error", FALLBACK_MESSAGE, { offerAgentUndo: true });
  }
  if (result.ok) {
    if (result.committed === false) {
      return outcome("info", "Nothing to revert. Those changes are already undone.");
    }
    const left = [
      ...(result.report?.conflictedPaths ?? []),
      ...(result.report?.rejectedPaths ?? []).map((entry) => entry.path),
    ];
    if (left.length > 0) {
      return outcome("warning", `Reverted and saved as a new version. Not saved: ${formatPathList(left)}.`, {
        reverted: true,
        unrevertedPaths: left,
      });
    }
    return outcome("success", "Reverted. Saved as a new version.", { reverted: true });
  }

  const info = result.errorInfo;
  const code = result.code ?? info?.code ?? null;
  const status = info?.status ?? 0;
  const paths = result.paths ?? info?.paths ?? [];
  if (result.routeUnavailable || info?.routeUnavailable) {
    return outcome("warning", REVERT_ROUTE_UNAVAILABLE_MESSAGE, { offerAgentUndo: true });
  }
  switch (code) {
    case "revert_conflict":
      return outcome("warning", "Later changes touch the same lines, so this can't be reverted automatically.", {
        offerAgentUndo: true,
      });
    case "dirty_paths":
      return outcome(
        "warning",
        paths.length > 0
          ? `Files on this computer have edits this revert would change: ${formatPathList(paths)}. Save them first.`
          : "Files on this computer have edits this revert would change. Save them first.",
      );
    case "main_busy":
      return outcome("warning", BUSY_MESSAGE);
    case "lease_conflict":
      return outcome("warning", "The agent is saving right now. Try again in a moment.");
    case "not_saved":
      return outcome("error", "The revert wasn't saved to the space. Try again in a moment.");
    case "dismissal_not_applied":
      // A Desktop origin's 422 that clears by itself, unlike a refused path.
      return outcome(
        "warning",
        "The revert isn't saved yet: work you removed is still on this computer's branch. Try again in a moment.",
      );
    case "not_found":
    case "rev_not_found":
      return outcome(
        "warning",
        "This change isn't in the space's saved history, so it can't be reverted here. Ask the agent to undo it.",
        { offerAgentUndo: true },
      );
    case "fetch_pending":
      return outcome("warning", STILL_LOADING_MESSAGE);
    case "canonical_unreachable":
    case "push_rejected":
    case "workspace_stopping":
    case "token_unavailable":
    case "network_error":
    case "timeout":
      return outcome("error", UNREACHABLE_MESSAGE);
    default:
      break;
  }
  const rule = refusedPathRule(code, info?.reason ?? null);
  if (rule || status === 422) {
    const brings = paths.length > 0 ? ` because it would bring back ${formatPathList(paths)}` : "";
    return outcome(
      "warning",
      `This change can't be reverted here${brings}.${rule ? ` ${rule}` : ""} Ask the agent to undo it.`,
      { offerAgentUndo: true },
    );
  }
  // A plain 409 is an origin that is already writing.
  if (status === 409) {
    return outcome("warning", BUSY_MESSAGE);
  }
  // A 400 is a change the origin cannot revert by itself, such as a merge,
  // which needs a base the card does not send.
  if (status === 400) {
    return outcome("warning", "This change can't be reverted here. Ask the agent to undo it.", {
      offerAgentUndo: true,
    });
  }
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return outcome("error", UNREACHABLE_MESSAGE);
  }
  return outcome("error", FALLBACK_MESSAGE, { offerAgentUndo: true });
}
