import {
  REVERT_ROUTE_UNAVAILABLE_MESSAGE,
  type RevertWorkspaceGitCommitResult,
} from "../../../services/runtimeController/workspaceGit";
import type { ChatMessageFileNotSaved } from "../types";

// Copy for the chat change card's save state. Work that did not reach the
// space's saved history is kept on an unsaved-work ref. Only a space whose
// History lists Unsaved work can point there; elsewhere the copy says the
// work is kept without naming a place the UI does not show.
export interface UnsavedWorkPlacement {
  unsavedWorkInHistory: boolean;
}

function keptAs({ unsavedWorkInHistory }: UnsavedWorkPlacement): string {
  return unsavedWorkInHistory ? "kept under History, in Unsaved work" : "kept as unsaved work";
}

// The message-level note when the turn's save failed or did not run. Every
// turn saves, so the next turn picks up what this one left behind.
export function describeUnsavedChanges(placement: UnsavedWorkPlacement): string {
  return `These changes weren't saved to the space yet. The agent saves them at its next turn, and anything left over is ${keptAs(placement)}.`;
}

// Why one file of the turn was left out of the saved history.
export function describeFileNotSaved(notSaved: ChatMessageFileNotSaved, placement: UnsavedWorkPlacement): string {
  if (notSaved.reason === "conflicted") {
    return `Changed in the space while the agent worked. The agent's version is ${keptAs(placement)}.`;
  }
  const reason = (() => {
    switch (notSaved.reason) {
      case "excluded":
        return "Build output, dependency and cache folders aren't saved to the space.";
      case "secret":
        return "Secret files stay out of the space. Use Secrets for these values.";
      case "ignored":
        return "This file matches .gitignore, so it isn't saved to the space.";
      case "too_large":
        return "Larger than 20 MB, so it isn't saved to the space.";
      case "attachment":
        return "Old chat upload files aren't saved to the space.";
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

const BUSY_MESSAGE = "The space is busy saving other changes. Try again in a moment.";
const UNREACHABLE_MESSAGE = "Couldn't reach the space's saved files. Try again.";
const FALLBACK_MESSAGE = "Couldn't revert this change. Try again, or ask the agent to undo it.";

// What "Revert this change" did, as one toast: the request is
// `/git/revert-commit {commit: head, base}` for the change's canonical range.
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
    case "not_found":
    case "rev_not_found":
      return outcome(
        "warning",
        "This change isn't in the space's saved history, so it can't be reverted here. Ask the agent to undo it.",
        { offerAgentUndo: true },
      );
    case "canonical_unreachable":
    case "push_rejected":
    case "fetch_pending":
    case "workspace_stopping":
    case "token_unavailable":
    case "network_error":
    case "timeout":
      return outcome("error", UNREACHABLE_MESSAGE);
    default:
      break;
  }
  // A plain 409 is an origin that is already writing.
  if (status === 409) {
    return outcome("warning", BUSY_MESSAGE);
  }
  // A 400 is a change the origin cannot revert by itself, such as a merge
  // whose first parent it does not know.
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
