import type { OriginError, OriginRejectedPath, VersioningMode } from "../../../sdk/instafy";

/**
 * User-facing copy for saving files in the `stateless` and `desktop` modes
 * (plan 2.3, "Errors and copy"). Every message keeps the user's edits: the
 * buffer is never dropped on a failure, so the copy says so where it helps.
 *
 * Copy rules: plain words, no em dashes, no server internals (lease holders,
 * raw codes, origin ids).
 */

export type SaveCopyActionKind = "resolve" | "retry" | "open_secrets";

export interface SaveCopyAction {
  kind: SaveCopyActionKind;
  label: string;
}

export interface SaveCopy {
  message: string;
  action?: SaveCopyAction;
  /** Raise the "changed while you were editing" card in the chat. */
  staleNotice?: boolean;
}

const RESOLVE_ACTION: SaveCopyAction = { kind: "resolve", label: "Resolve" };
const RETRY_ACTION: SaveCopyAction = { kind: "retry", label: "Try again" };
const OPEN_SECRETS_ACTION: SaveCopyAction = { kind: "open_secrets", label: "Open Secrets" };

export const SAVE_COPY = Object.freeze({
  mainBusy: "The space is busy saving other changes. Try again in a moment.",
  leaseConflict: "The agent is saving right now. Try again in a moment.",
  ignored:
    "This file matches .gitignore, so it isn't saved to the space. Keep keys and passwords in Secrets.",
  secret: "Secret files like .env aren't saved to the space. Add these values in Secrets instead.",
  excluded:
    "Files in tmp/, node_modules/, build output and similar folders aren't saved to the space.",
  attachment: "Old chat upload files can't be changed here. Attach images in the chat instead.",
  tooLarge: "This file is larger than 20 MB, so it isn't saved to the space.",
  policy: "This space's file rules refused the file.",
  unsupportedEntry: "This path is a link or submodule in the space, so Studio can't save over it.",
  deleteRequiresBaseRev: "Reload the folder and try again.",
  readTooLarge: "This file is larger than 20 MB, so it can't be opened here.",
  fetchPending: "The space is still loading. Try again in a moment.",
  statelessUnreachable: "Couldn't reach the space's saved files. Your edits are kept here. Try again.",
  desktopUnreachable: "The folder on this computer isn't connected. Your edits are kept here.",
  dismissalNotApplied:
    "Not saved yet: work you removed is still on this computer's branch. Try again in a moment.",
  desktopStaleDescription:
    "It changed in the space while you edited. Your version is still in the folder on this computer. Merge keeps both; Reload uses the space's version.",
  desktopReloadFailed: "Couldn't replace the folder's copy with the space's version. Try again in a moment.",
});

/** `"README.md" changed while you were editing. Your edits are kept.` */
export function staleSaveMessage(label: string): string {
  return `"${label}" changed while you were editing. Your edits are kept.`;
}

/** The fallback when nothing more specific is known. */
export function genericSaveMessage(label: string): string {
  return `Couldn't save "${label}". Your edits are kept here.`;
}

/**
 * What the failed write was. A save keeps the user's edits, so its copy says
 * so; deleting a file or creating a folder has no edits to keep.
 */
export type SaveCopyOperation = "save" | "delete" | "create";

function trimSentence(value: string): string {
  return value.trim().replace(/[.\s]+$/, "");
}

function notSavedMessage(error: OriginError): string {
  const failure = trimSentence(error.report?.failure ?? error.message ?? "");
  return failure
    ? `Not saved: ${failure}. The work is kept under History, in Unsaved work.`
    : "Not saved. The work is kept under History, in Unsaved work.";
}

/** Copy for one path the origin refused to publish, by its reason. */
export function rejectedPathCopy(reason: string | null | undefined): SaveCopy {
  switch ((reason ?? "").trim().toLowerCase()) {
    case "secret":
      return { message: SAVE_COPY.secret, action: OPEN_SECRETS_ACTION };
    case "ignored":
      return { message: SAVE_COPY.ignored, action: OPEN_SECRETS_ACTION };
    case "attachment":
      return { message: SAVE_COPY.attachment };
    case "too_large":
      return { message: SAVE_COPY.tooLarge };
    case "policy":
      return { message: SAVE_COPY.policy };
    case "unsupported":
      return { message: SAVE_COPY.unsupportedEntry };
    default:
      return { message: SAVE_COPY.excluded };
  }
}

/** The first refused path of a save that matters to the user, as copy. */
export function rejectedPathsCopy(
  rejected: OriginRejectedPath[],
  paths: string[],
): SaveCopy | null {
  const relevant = rejected.find((entry) => paths.includes(entry.path)) ?? rejected[0];
  return relevant ? rejectedPathCopy(relevant.reason) : null;
}

function isUnreachable(error: OriginError): boolean {
  if (
    error.code === "network_error" ||
    error.code === "timeout" ||
    error.code === "token_unavailable" ||
    error.code === "canonical_unreachable" ||
    error.code === "push_rejected" ||
    error.code === "workspace_stopping"
  ) {
    return true;
  }
  return error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504;
}

/**
 * Copy for a failed save, folder creation or delete. `label` names the file
 * or folder the way the explorer shows it.
 */
export function describeSaveFailure(params: {
  error: OriginError;
  mode: VersioningMode;
  label: string;
  operation?: SaveCopyOperation;
}): SaveCopy {
  const { error, mode, label } = params;
  const operation = params.operation ?? "save";
  switch (error.code) {
    case "head_moved":
    case "path_type_conflict":
      if (operation === "delete") {
        return { message: `"${label}" changed in the space. Refresh the folder and try again.` };
      }
      if (operation === "create") {
        return { message: `"${label}" already exists in the space. Refresh the folder.` };
      }
      return { message: staleSaveMessage(label), action: RESOLVE_ACTION, staleNotice: true };
    case "main_busy":
      return { message: SAVE_COPY.mainBusy, action: RETRY_ACTION };
    case "lease_conflict":
      return { message: SAVE_COPY.leaseConflict };
    case "ignored_path":
      return { message: SAVE_COPY.ignored, action: OPEN_SECRETS_ACTION };
    case "excluded_path":
      return rejectedPathCopy(error.reason ?? "excluded");
    case "policy_rejected":
      if ((error.reason ?? "").toLowerCase() === "too_large") {
        return { message: SAVE_COPY.tooLarge };
      }
      return error.message && error.status !== 0
        ? { message: `This space's file rules refused the file: ${trimSentence(error.message)}.` }
        : { message: SAVE_COPY.policy };
    case "too_large":
      return { message: SAVE_COPY.tooLarge };
    case "unsupported_entry":
      return { message: SAVE_COPY.unsupportedEntry };
    case "delete_requires_base_rev":
      return { message: SAVE_COPY.deleteRequiresBaseRev };
    case "fetch_pending":
      return { message: SAVE_COPY.fetchPending };
    case "not_saved":
      return { message: notSavedMessage(error) };
    case "dismissal_not_applied":
      return { message: SAVE_COPY.dismissalNotApplied };
    default:
      break;
  }
  if (isUnreachable(error)) {
    if (operation !== "save") {
      return mode === "desktop"
        ? { message: "The folder on this computer isn't connected." }
        : { message: "Couldn't reach the space's saved files. Try again." };
    }
    return mode === "desktop"
      ? { message: SAVE_COPY.desktopUnreachable }
      : { message: SAVE_COPY.statelessUnreachable };
  }
  if (operation === "delete") {
    return { message: `Couldn't delete "${label}".` };
  }
  if (operation === "create") {
    return { message: `Couldn't create "${label}".` };
  }
  return { message: genericSaveMessage(label) };
}
