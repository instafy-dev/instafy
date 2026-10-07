import type {
  OriginError,
  OriginRejectedPath,
  RevertWorkspaceGitCommitResult,
  VersioningMode,
  WorkspaceGitHistoryEntry,
} from "../../../sdk/instafy";
import {
  originAutoRetryDelayMs,
  type OriginAutoRetryBudget,
} from "../../../services/runtimeController/originErrors";
import { REVERT_ROUTE_UNAVAILABLE_MESSAGE } from "../../../services/runtimeController/workspaceGit";
import type { ChatMessageFileNotSaved, ChatMessageUnsavedReason } from "../types";

/**
 * User-facing copy for the surfaces that save, review and undo versions of a
 * space's files in the `stateless` and `desktop` modes: Save in Files, the
 * History drawer with its Unsaved work and Desktop line, and the chat change
 * card. A sentence two surfaces share is written once, here.
 *
 * Copy rules: plain words, no em dashes, no server internals (lease holders,
 * raw codes, origin ids). The legacy Changes drawer keeps its own copy.
 */

// ---------------------------------------------------------------------------
// Lists, counts and sentences
// ---------------------------------------------------------------------------

export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function formatFileCount(count: number): string {
  return `${count} ${pluralize(count, "file", "files")}`;
}

/**
 * "a", "a and b", "a, b and c", "a, b, c and 2 more": names a few paths
 * without growing the message. Blank and repeated paths are left out.
 */
export function formatPathList(paths: readonly string[], max = 3): string {
  const unique = Array.from(new Set(paths.filter((path) => path.trim().length > 0)));
  const named = unique.slice(0, max);
  const rest = unique.length - named.length;
  if (rest > 0) {
    return `${named.join(", ")} and ${rest} more`;
  }
  if (named.length <= 1) {
    return named.join("");
  }
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

function stripSentenceEnd(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/[.\s]+$/, "");
}

/** A server message appended as its own sentence, or nothing. */
function appendServerMessage(message: string | null | undefined): string {
  const text = stripSentenceEnd(message);
  return text ? ` ${text}.` : "";
}

/** "secret files aren't saved" becomes "Secret files aren't saved." */
function asSentence(clause: string): string {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

// ---------------------------------------------------------------------------
// Sentences every surface shares
// ---------------------------------------------------------------------------

export const MAIN_BUSY_COPY = "The space is busy saving other changes. Try again in a moment.";
export const LEASE_CONFLICT_COPY = "The agent is saving right now. Try again in a moment.";
export const FETCH_PENDING_COPY = "The space is still loading. Try again in a moment.";
// The gateway's other answers that say to try again later (503 with
// Retry-After). See OriginRetryLaterCode for when a write may have landed
// anyway, and why asking again is still safe.
const WRITES_BUSY_LEAD = "The server is busy saving other changes.";
const MIRROR_RESET_LEAD = "The server is rebuilding its copy of this space.";
const DISK_FULL_LEAD = "The space is out of room right now.";
const TRY_AGAIN_IN_A_MOMENT = "Try again in a moment.";
const TRY_AGAIN_LATER = "Try again later.";
export const WRITES_BUSY_COPY = `${WRITES_BUSY_LEAD} ${TRY_AGAIN_IN_A_MOMENT}`;
export const MIRROR_RESET_COPY = `${MIRROR_RESET_LEAD} ${TRY_AGAIN_IN_A_MOMENT}`;
// A full disk does not clear in a moment, so nothing asks again by itself.
export const DISK_FULL_COPY = `${DISK_FULL_LEAD} ${TRY_AGAIN_LATER}`;
export const STATELESS_UNREACHABLE_COPY = "Couldn't reach the space's saved files. Try again.";
export const DESKTOP_UNREACHABLE_COPY = "The folder on this computer isn't connected.";
export const DISMISSAL_NOT_APPLIED_COPY =
  "Not saved yet: work you removed is still on this computer's branch. Try again in a moment.";

const EDITS_KEPT_HERE = "Your edits are kept here.";
const KEPT_IN_UNSAVED_WORK = "kept under History, in Unsaved work";
const WORK_KEPT_IN_UNSAVED_WORK = `The work is ${KEPT_IN_UNSAVED_WORK}.`;

const UNREACHABLE_CODES = new Set([
  "network_error",
  "timeout",
  "token_unavailable",
  "canonical_unreachable",
  "push_rejected",
  "workspace_stopping",
]);

function isUnreachableCode(code: string | null | undefined): boolean {
  return Boolean(code) && UNREACHABLE_CODES.has(code as string);
}

/**
 * No answer, or a gateway error. A 503 without a code reads as unreachable
 * too: the gateway's own 503s (`fetch_pending`, `writes_busy`,
 * `mirror_reset`, `disk_full`) carry a code and have their own copy.
 */
function isUnreachableStatus(status: number | null | undefined): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

function isOriginUnreachable(error: Pick<OriginError, "code" | "status">): boolean {
  return isUnreachableCode(error.code) || isUnreachableStatus(error.status);
}

/** The sentence for an answer that says to try again later, or null for any other. */
export function retryLaterCopy(code: string | null | undefined): string | null {
  switch (code) {
    case "fetch_pending":
      return FETCH_PENDING_COPY;
    case "writes_busy":
      return WRITES_BUSY_COPY;
    case "mirror_reset":
      return MIRROR_RESET_COPY;
    case "disk_full":
      return DISK_FULL_COPY;
    default:
      return null;
  }
}

/** "Not saved: <the origin's reason>." or "Not saved." when it named none. */
function notSavedLead(error: OriginError): string {
  const failure = stripSentenceEnd(error.report?.failure?.trim() || error.message);
  return failure ? `Not saved: ${failure}.` : "Not saved.";
}

/**
 * The space's file rules, as clauses: ".env stays on this computer: secret
 * files aren't saved to the space." The chat card uses them as sentences.
 */
const FILE_RULES: Record<string, string> = {
  secret: "secret files aren't saved to the space",
  ignored: "files that match .gitignore aren't saved to the space",
  excluded: "build output, dependency and cache folders aren't saved to the space",
  too_large: "files larger than 20 MB aren't saved to the space",
  attachment: "old chat upload files aren't saved to the space",
  policy: "this space's file rules refused it",
  unsupported: "links and special files can't be saved",
};

// One file the space did not save, by its rule.
const IGNORED_FILE_COPY = "This file matches .gitignore, so it isn't saved to the space.";
const TOO_LARGE_FILE_COPY = "This file is larger than 20 MB, so it isn't saved to the space.";
const POLICY_FILE_COPY = "This space's file rules refused the file.";

// ---------------------------------------------------------------------------
// Save in Files (plan 2.3, "Errors and copy")
// ---------------------------------------------------------------------------

// Every save message keeps the user's edits: the buffer is never dropped on a
// failure, so the copy says so where it helps.

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
  mainBusy: MAIN_BUSY_COPY,
  leaseConflict: LEASE_CONFLICT_COPY,
  ignored: `${IGNORED_FILE_COPY} Keep keys and passwords in Secrets.`,
  secret: "Secret files like .env aren't saved to the space. Add these values in Secrets instead.",
  excluded:
    "Files in tmp/, node_modules/, build output and similar folders aren't saved to the space.",
  attachment: "Old chat upload files can't be changed here. Attach images in the chat instead.",
  tooLarge: TOO_LARGE_FILE_COPY,
  policy: POLICY_FILE_COPY,
  unsupportedEntry: "This path is a link or submodule in the space, so Studio can't save over it.",
  deleteRequiresBaseRev: "Reload the folder and try again.",
  readTooLarge: "This file is larger than 20 MB, so it can't be opened here.",
  fetchPending: FETCH_PENDING_COPY,
  writesBusy: `${WRITES_BUSY_LEAD} ${EDITS_KEPT_HERE} ${TRY_AGAIN_IN_A_MOMENT}`,
  mirrorReset: `${MIRROR_RESET_LEAD} ${EDITS_KEPT_HERE} ${TRY_AGAIN_IN_A_MOMENT}`,
  diskFull: `${DISK_FULL_LEAD} ${EDITS_KEPT_HERE} ${TRY_AGAIN_LATER}`,
  statelessUnreachable: "Couldn't reach the space's saved files. Your edits are kept here. Try again.",
  desktopUnreachable: `${DESKTOP_UNREACHABLE_COPY} ${EDITS_KEPT_HERE}`,
  dismissalNotApplied: DISMISSAL_NOT_APPLIED_COPY,
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
  return `Couldn't save "${label}". ${EDITS_KEPT_HERE}`;
}

/**
 * What the failed write was. A save keeps the user's edits, so its copy says
 * so; deleting, creating a folder or changing a setting has no edits to keep.
 */
export type SaveCopyOperation = "save" | "delete" | "create" | "update";

/**
 * A Desktop publish that failed. The work stays in the folder on this
 * computer, and a save keeps the edits in the editor too. History's Unsaved
 * work is named only where the user can open it: when the History drawer
 * lists recovery entries for this origin.
 */
function notSavedMessage(error: OriginError, operation: SaveCopyOperation, unsavedWorkVisible: boolean): string {
  const lead = notSavedLead(error);
  if (unsavedWorkVisible) {
    return `${lead} ${WORK_KEPT_IN_UNSAVED_WORK}`;
  }
  return operation === "save"
    ? `${lead} ${EDITS_KEPT_HERE} Try again in a moment.`
    : `${lead} Try again in a moment.`;
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

/**
 * Copy for a failed save, folder creation or delete. `label` names the file
 * or folder the way the explorer shows it.
 */
export function describeSaveFailure(params: {
  error: OriginError;
  mode: VersioningMode;
  label: string;
  operation?: SaveCopyOperation;
  /** History shows Unsaved work for this origin (recovery is supported). */
  unsavedWorkVisible?: boolean;
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
      if (operation === "update") {
        return { message: `"${label}" changed in the space. Refresh and try again.` };
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
        ? { message: `This space's file rules refused the file: ${stripSentenceEnd(error.message)}.` }
        : { message: SAVE_COPY.policy };
    case "too_large":
      return { message: SAVE_COPY.tooLarge };
    case "unsupported_entry":
      return { message: SAVE_COPY.unsupportedEntry };
    case "delete_requires_base_rev":
      return { message: SAVE_COPY.deleteRequiresBaseRev };
    case "fetch_pending":
      return { message: SAVE_COPY.fetchPending };
    // A save keeps the edits in the editor, and trying again is safe even
    // when the change already landed. The busy answers clear in a moment, a
    // full disk only later (no Try again).
    case "writes_busy":
      return { message: operation === "save" ? SAVE_COPY.writesBusy : WRITES_BUSY_COPY, action: RETRY_ACTION };
    case "mirror_reset":
      return { message: operation === "save" ? SAVE_COPY.mirrorReset : MIRROR_RESET_COPY, action: RETRY_ACTION };
    case "disk_full":
      return { message: operation === "save" ? SAVE_COPY.diskFull : DISK_FULL_COPY };
    case "not_saved":
      return { message: notSavedMessage(error, operation, params.unsavedWorkVisible === true) };
    case "dismissal_not_applied":
      return { message: SAVE_COPY.dismissalNotApplied };
    default:
      break;
  }
  if (isOriginUnreachable(error)) {
    if (operation !== "save") {
      return { message: mode === "desktop" ? DESKTOP_UNREACHABLE_COPY : STATELESS_UNREACHABLE_COPY };
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
  if (operation === "update") {
    return { message: `Couldn't update "${label}".` };
  }
  return { message: genericSaveMessage(label) };
}

// ---------------------------------------------------------------------------
// History: notices and authors
// ---------------------------------------------------------------------------

export type HistoryOriginKind = "stateless" | "desktop";

export type HistoryNoticeTone = "success" | "info" | "warning" | "error";

/** One message in the drawer's polite status region, with at most one action. */
export interface HistoryNotice {
  tone: HistoryNoticeTone;
  text: string;
  action?: { label: string; onPress: () => void; testId: string } | null;
}

export type HistoryAuthor = { kind: "service" } | { kind: "person"; label: string | null };

const USER_PSEUDONYM_SUFFIX = "@users.noreply.instafy.dev";
const SERVICE_EMAIL_SUFFIX = "@instafy.dev";

/**
 * Who a version is from. A server `actor` wins when present; otherwise the
 * client rule: an Instafy user pseudonym shows the name, any other
 * `@instafy.dev` address (origin, service runtime, studio) is Instafy itself,
 * and anything else (a Desktop user's own commits) shows name or email.
 */
export function resolveHistoryAuthor(
  entry: Pick<WorkspaceGitHistoryEntry, "authorName" | "authorEmail"> & { actor?: string | null },
): HistoryAuthor {
  const name = entry.authorName?.trim() || "";
  const email = entry.authorEmail?.trim().toLowerCase() || "";
  if (entry.actor === "service") {
    return { kind: "service" };
  }
  if (entry.actor === "user") {
    return { kind: "person", label: name || "Instafy user" };
  }
  if (entry.actor === "external") {
    return { kind: "person", label: name || email || null };
  }
  if (email.endsWith(USER_PSEUDONYM_SUFFIX)) {
    return { kind: "person", label: name || "Instafy user" };
  }
  if (email.endsWith(SERVICE_EMAIL_SUFFIX)) {
    return { kind: "service" };
  }
  return { kind: "person", label: name || email || null };
}

const UNSAVED_WORK_TITLES: Record<string, string> = {
  conflict: "Agent work that conflicted with newer changes",
  unpublished: "Agent work that couldn't be saved",
  unsaved: "Unsaved edits from a stopped workspace",
  stale: "Older copies found in a workspace",
};

export function unsavedWorkTitle(kind: string): string {
  return UNSAVED_WORK_TITLES[kind] ?? "Unsaved work";
}

function unreachableCopy(origin: HistoryOriginKind): string {
  return origin === "desktop" ? DESKTOP_UNREACHABLE_COPY : STATELESS_UNREACHABLE_COPY;
}

/**
 * Copy for the failures every History action shares (busy, lease, reach,
 * Desktop publish refusals). Null when the caller should use its own copy.
 */
export function sharedOriginErrorCopy(error: OriginError, origin: HistoryOriginKind): string | null {
  const later = retryLaterCopy(error.code);
  if (later) {
    return later;
  }
  switch (error.code) {
    case "main_busy":
      return MAIN_BUSY_COPY;
    case "lease_conflict":
      return LEASE_CONFLICT_COPY;
    case "not_saved":
      return `${notSavedLead(error)} ${WORK_KEPT_IN_UNSAVED_WORK}`;
    case "dismissal_not_applied":
      return DISMISSAL_NOT_APPLIED_COPY;
    default:
      break;
  }
  return isOriginUnreachable(error) ? unreachableCopy(origin) : null;
}

export function historyFailureCopy(
  error: OriginError | null | undefined,
  origin: HistoryOriginKind,
  fallback: string,
): string {
  if (!error) {
    return unreachableCopy(origin);
  }
  return sharedOriginErrorCopy(error, origin) ?? `${fallback}${appendServerMessage(error.message)}`;
}

// ---------------------------------------------------------------------------
// Revert: History's saved versions and the chat change card
// ---------------------------------------------------------------------------

export const REVERT_CONFIRM_MESSAGE = "A new version that undoes it is saved on top. Nothing is removed from history.";

export const REVERT_DIALOG = {
  title: "Revert this version?",
  body: REVERT_CONFIRM_MESSAGE,
  cancel: "Cancel",
  confirm: "Revert",
} as const;

/** A later version changed the same lines, so git cannot undo this one on top. */
export const REVERT_CONFLICT_COPY = "Later changes touch the same lines, so this can't be reverted automatically.";

export function revertSuccessCopy(committed: boolean | undefined): string {
  return committed === false
    ? "Nothing to revert. Those changes are already undone."
    : "Reverted. Saved as a new version.";
}

function dirtyPathsCopy(action: "revert" | "restore", paths: readonly string[]): string {
  const lead = `Files on this computer have edits this ${action} would change`;
  const list = formatPathList(paths);
  return list ? `${lead}: ${list}. Save them first.` : `${lead}. Save them first.`;
}

/** A Desktop folder holds uncommitted edits the revert would overwrite. */
export function revertDirtyPathsCopy(paths: readonly string[]): string {
  return dirtyPathsCopy("revert", paths);
}

export function revertAskAgentPrompt(subject: string, shortCommit: string): string {
  return `Undo the version "${subject}" (${shortCommit}) without losing later changes.`;
}

export interface HistoryNoticeCopy {
  tone: HistoryNoticeTone;
  text: string;
  /** Offer "Ask the agent" next to the message. */
  askAgent?: boolean;
}

export function revertFailureCopy(
  result: RevertWorkspaceGitCommitResult | null,
  origin: HistoryOriginKind,
): HistoryNoticeCopy {
  if (!result) {
    return { tone: "error", text: STATELESS_UNREACHABLE_COPY };
  }
  const error = result.errorInfo;
  const code = result.code ?? error?.code;
  if (code === "revert_conflict") {
    return { tone: "warning", text: REVERT_CONFLICT_COPY, askAgent: true };
  }
  if (code === "dirty_paths") {
    return { tone: "warning", text: revertDirtyPathsCopy(result.paths ?? error?.paths ?? []) };
  }
  if (result.routeUnavailable || error?.routeUnavailable) {
    return { tone: "warning", text: REVERT_ROUTE_UNAVAILABLE_MESSAGE };
  }
  if (error?.status === 400 && (!code || code === "invalid_request" || /merge|root|parent|base/i.test(error.message))) {
    return {
      tone: "warning",
      text: "This version combines several saves and can't be reverted here yet. Ask the agent to undo it.",
      askAgent: true,
    };
  }
  const shared = error ? sharedOriginErrorCopy(error, origin) : null;
  if (shared) {
    return { tone: "error", text: shared };
  }
  return { tone: "error", text: `Couldn't revert this version.${appendServerMessage(error?.message ?? result.error)}` };
}

// ---------------------------------------------------------------------------
// History: the Desktop line
// ---------------------------------------------------------------------------

/** `/git/sync` always carries a message; this one names no person. */
export const DESKTOP_SAVE_MESSAGE = "Save changes from this computer";

export function desktopChangesLabel(count: number): string {
  return `${formatFileCount(count)} changed outside Studio`;
}

/** One sentence per refusal reason: ".env stays on this computer: secret files aren't saved to the space." */
export function keptOnComputerCopy(rejected: OriginRejectedPath[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const item of rejected) {
    const reason = item.reason?.trim() || "other";
    byReason.set(reason, [...(byReason.get(reason) ?? []), item.path]);
  }
  return Array.from(byReason.entries()).map(([reason, paths]) => {
    const clause = FILE_RULES[reason] ?? "the space refused it";
    return `${formatPathList(paths)} ${pluralize(paths.length, "stays", "stay")} on this computer: ${clause}.`;
  });
}

export function conflictedOnComputerCopy(paths: string[]): string {
  const count = paths.length;
  return (
    `${formatFileCount(count)} ${pluralize(count, "wasn't", "weren't")} saved because ` +
    `${pluralize(count, "it", "they")} changed in the space: ${formatPathList(paths)}. ` +
    `Your ${pluralize(count, "version is", "versions are")} still in the folder on this computer.`
  );
}

export function desktopSavedCopy(count: number): string {
  return `Saved ${formatFileCount(count)} as a version.`;
}

export const DESKTOP_NOTHING_TO_SAVE_COPY = "Nothing new to save.";
export const DESKTOP_STATUS_ERROR_COPY = "Couldn't check the folder on this computer.";
export const DESKTOP_NO_CHANGES_COPY = "No files changed outside Studio.";

export function desktopSaveFailureCopy(error: OriginError | null | undefined): string {
  if (!error) {
    return DESKTOP_UNREACHABLE_COPY;
  }
  return sharedOriginErrorCopy(error, "desktop") ?? `Couldn't save the folder's changes.${appendServerMessage(error.message)}`;
}

// ---------------------------------------------------------------------------
// History: Unsaved work (restore and remove)
// ---------------------------------------------------------------------------

export const REMOVE_DIALOG = {
  title: "Remove this unsaved work?",
  body: "This removes it for everyone in this space and can't be undone.",
  cancel: "Keep it",
  confirm: "Remove",
} as const;

export const RESTORE_CONFLICT_INTRO = "These files changed since this work was kept. Choose a version for each:";

/** Announced when a restore stops at a conflict and the per-file choices open. */
export function restoreConflictNoticeCopy(count: number): string {
  return `Not restored yet: ${formatFileCount(count)} changed since this work was kept.`;
}

export const NO_UNSAVED_WORK_COPY = "No unsaved work.";

/** Cancel on the per-file choices: nothing more is restored. */
export function restoreCancelledCopy(savedSome: boolean): string {
  return savedSome
    ? "Restore cancelled. Files you already saved with Use this version stay saved."
    : "Restore cancelled. Nothing was changed.";
}
export const RECOVERY_REF_MOVED_COPY = "This entry changed. Refreshing.";
export const ALREADY_REMOVED_COPY = "Already removed.";
export const REMOVED_COPY = "Removed.";
export const UNSAVED_WORK_ERROR_COPY = "Couldn't check for unsaved work.";
export const UNSAVED_WORK_READ_FAILED_COPY =
  "Couldn't read this file from the unsaved work, so nothing was saved. Refreshing.";

/** "Use this version" on a path the ref holds as a symlink or submodule. */
export function unsavedWorkUnsupportedEntryCopy(path: string): string {
  return `${path} is a link or a nested repository in this unsaved work, so it can't be saved from here. Ask the agent instead.`;
}

/** "Use this version" got a 404 that does not say the path is gone (an older origin). */
export function unsavedWorkUnconfirmedDeleteCopy(path: string): string {
  return `Couldn't tell whether this unsaved work deletes ${path}, so nothing was saved. Ask the agent instead.`;
}

/** A restore with nothing to bring back: the saved version already held the work. */
export const NOTHING_TO_RESTORE_COPY = "Nothing to restore. The saved version already has this work.";

/**
 * The reason a restore gives a kept path that a disk ignoring case or Unicode
 * form takes for another name, of the space or of the same work.
 */
export const PATH_ALIAS_REASON = "path_alias";

/** The reason a restore gives a kept path where the space had no current version left to keep. */
export const NOTHING_TO_KEEP_REASON = "nothing_to_keep";

/**
 * Whether a restore's reasons name a kept path whose keep chose no version of
 * the work's file: that work is only on the ref, so the entry stays pending.
 */
export function restoreLeftWorkOnRef(reasons: Readonly<Record<string, string>> | null | undefined): boolean {
  return Object.values(reasons ?? {}).some(
    (reason) => reason === PATH_ALIAS_REASON || reason === NOTHING_TO_KEEP_REASON,
  );
}

/**
 * A finished restore. `kept` are the paths the person chose "Keep current"
 * for (the server reports them in `notRestored` too, the gateway with the
 * reason `kept`, which also covers files below a kept folder); only the
 * rest of `notRestored` were refused. `reasons` says why, when the origin
 * does: old chat uploads (`attachment`) get a sentence of their own, and every other refusal reads as secret or
 * ignored, as it does without reasons (Desktop lists bare paths). A kept path
 * the server lists as `path_alias` (a disk ignoring case takes it for another
 * name, of the space or of the work itself, so keeping chose no version of
 * the work's file) is said to stay in Unsaved work instead of being kept, and
 * so is one listed as `nothing_to_keep` (the space had no current version left
 * to keep, so it can be restored later).
 * `committed: false` means no version with changes was made: the saved
 * version already held everything that could be restored, so the copy says
 * what was left out first (never that the space has the refused files).
 * `entryPaths` is every path the entry holds, or null when that is not known
 * (a conflict entry lists only its conflicted paths): the copy speaks of
 * "the rest" only when there was one.
 */
export function restoreSuccessCopy({
  committed,
  notRestored,
  kept = [],
  entryPaths = null,
  reasons = {},
}: {
  committed: boolean | null | undefined;
  notRestored: string[];
  kept?: string[];
  entryPaths?: string[] | null;
  reasons?: Readonly<Record<string, string>>;
}): string {
  const keptSet = new Set(kept);
  const held = notRestored.filter((path) => reasons[path] === PATH_ALIAS_REASON);
  const unchosen = notRestored.filter((path) => reasons[path] === NOTHING_TO_KEEP_REASON);
  const heldSet = new Set([...held, ...unchosen]);
  const keptPaths = Array.from(keptSet).filter((path) => !heldSet.has(path));
  const refused = notRestored.filter(
    (path) => !keptSet.has(path) && !heldSet.has(path) && reasons[path] !== "kept",
  );
  const attachments = refused.filter((path) => reasons[path] === "attachment");
  const leftOut: string[] = [];
  if (keptPaths.length > 0) {
    leftOut.push(`Kept the current version of ${formatPathList(keptPaths)}.`);
  }
  if (held.length > 0) {
    leftOut.push(
      held.length === 1
        ? `${formatPathList(held)} stays in Unsaved work, because a disk that ignores case or Unicode form takes it for another name in the space or in this work.`
        : `${formatPathList(held)} stay in Unsaved work, because a disk that ignores case or Unicode form takes them for other names in the space or in this work.`,
    );
  }
  if (unchosen.length > 0) {
    leftOut.push(
      unchosen.length === 1
        ? `${formatPathList(unchosen)} stays in Unsaved work to restore later, because the space has no current version of it to keep.`
        : `${formatPathList(unchosen)} stay in Unsaved work to restore later, because the space has no current versions of them to keep.`,
    );
  }
  if (refused.length > 0) {
    leftOut.push(`Not restored: ${formatPathList(refused)}.`);
    if (attachments.length < refused.length) {
      leftOut.push("Secret and ignored files stay out of the space.");
    }
    if (attachments.length > 0) {
      leftOut.push(asSentence(FILE_RULES.attachment));
    }
  }
  if (committed !== false) {
    return ["Restored as a new version.", ...leftOut].join(" ");
  }
  if (leftOut.length === 0) {
    return NOTHING_TO_RESTORE_COPY;
  }
  // Everything in notRestored was left out: kept (files below a kept folder
  // too) or refused.
  const leftOutSet = new Set([...keptPaths, ...notRestored]);
  const known = entryPaths && entryPaths.length > 0 ? entryPaths : null;
  if (!known) {
    return [...leftOut, "Nothing else to restore."].join(" ");
  }
  if (known.every((path) => leftOutSet.has(path))) {
    // The entry held only what was left out: there is no rest to speak of.
    return leftOut.join(" ");
  }
  return [...leftOut, "The saved version already has the rest of this work."].join(" ");
}

/** "Keep current" on one conflicted file. */
export function keptPathCopy(path: string): string {
  return `Kept the current version of ${path}.`;
}

/** "Use this version" saved one conflicted file. */
export function savedPathVersionCopy(path: string): string {
  return `Saved this version of ${path}.`;
}

/** A Desktop folder holds uncommitted edits the restore would overwrite. */
export function restoreDirtyPathsCopy(paths: readonly string[]): string {
  return dirtyPathsCopy("restore", paths);
}

export const DESKTOP_FOLDER_UNCHECKED_COPY =
  "Couldn't check this file in the folder on this computer, so nothing was saved. Try again.";

/** "Use this version" on Desktop: the folder holds a link or a nested repository at the path. */
export function desktopFolderUnsupportedEntryCopy(path: string): string {
  return `${path} is a link or a nested repository in the folder on this computer, so this version can't be saved over it from here. Ask the agent instead.`;
}

/** "Use this version" on Desktop could not confirm the folder's copy is safe to replace. */
export function desktopFolderUncheckedCopy(error: OriginError | null | undefined): string {
  return (error ? sharedOriginErrorCopy(error, "desktop") : null) ?? DESKTOP_FOLDER_UNCHECKED_COPY;
}

export function unsavedWorkAskAgentPrompt(path: string, ref: string): string {
  return `Merge \`${path}\` from \`${ref}\` into the saved version. Read it with \`instafy git show ${ref}:${path}\`.`;
}

// ---------------------------------------------------------------------------
// Chat change card: what a turn's save left out
// ---------------------------------------------------------------------------

// Work that did not reach the space's saved history is kept on an
// unsaved-work ref. Only a space whose History lists Unsaved work can point
// there; elsewhere the copy says the work is kept without naming a place the
// UI does not show.
export interface UnsavedWorkPlacement {
  unsavedWorkInHistory: boolean;
  // The space keeps versions the old way, so Changes still has Save version.
  saveVersionInChanges?: boolean;
}

function keptAs({ unsavedWorkInHistory }: UnsavedWorkPlacement): string {
  return unsavedWorkInHistory ? KEPT_IN_UNSAVED_WORK : "kept as unsaved work";
}

// A turn whose save did not run. The artifact records only that no save was
// attempted, not why: an older client's auto-save preference did this until
// the runtime stopped honouring it, and a runtime-wide setting still can.
// Neither the artifact nor the turn's time tells which runtime build ran it,
// so the note describes the turn in the past tense and names no cause. A
// space that keeps versions the old way keeps today's sentence, which also
// stays true after a later Save version.
const SAVE_DID_NOT_RUN_MESSAGE = "Saving was off when this turn ran, so these changes weren't saved to the space.";
const LEGACY_SAVE_DID_NOT_RUN_MESSAGE =
  "Auto-save was off when this turn ran. Until you save a version, these changes are only on this space's machine and could be lost when it restarts.";

// The message-level note when the turn's save failed or did not run.
export function describeUnsavedChanges(reason: ChatMessageUnsavedReason, placement: UnsavedWorkPlacement): string {
  if (reason === "auto_save_off") {
    // No later turn is promised to save these, and nothing says they were
    // kept as unsaved work.
    return placement.saveVersionInChanges ? LEGACY_SAVE_DID_NOT_RUN_MESSAGE : SAVE_DID_NOT_RUN_MESSAGE;
  }
  // Every turn saves, so the next turn picks up what this one left behind.
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
        return asSentence(FILE_RULES.excluded);
      case "secret":
        return `${asSentence(FILE_RULES.secret)} Use Secrets for these values.`;
      case "ignored":
        return IGNORED_FILE_COPY;
      case "too_large":
        return TOO_LARGE_FILE_COPY;
      case "attachment":
        return asSentence(FILE_RULES.attachment);
      case "policy":
        return POLICY_FILE_COPY;
      case "unsupported":
        return asSentence(FILE_RULES.unsupported);
      default:
        return "The space didn't save this file.";
    }
  })();
  return notSaved.keptSavedVersion ? `${reason} The saved version is unchanged.` : reason;
}

// ---------------------------------------------------------------------------
// Chat change card: "Revert this change"
// ---------------------------------------------------------------------------

// The confirm dialog of "Revert this change". Before it offers Revert it
// lists the files the change's saved version touched: a version can carry
// more than this card's files (earlier work saved with it), and a revert
// undoes all of it.
export const REVERT_CHECKING_MESSAGE = "Checking what this change includes…";

// Files the turn changed and saved without listing them on the card, such as
// a lockfile an install rewrote, are undone too: the dialog names them.
export function describeRevertConfirm(unlistedPaths: readonly string[]): string {
  return unlistedPaths.length > 0
    ? `${REVERT_CONFIRM_MESSAGE} It also undoes this turn's changes to ${formatPathList(unlistedPaths)}.`
    : REVERT_CONFIRM_MESSAGE;
}
export const REVERT_CHECK_FAILED_MESSAGE = "Couldn't check what this change includes. Try again.";

// While the revert request runs. Closing the dialog does not cancel it.
export const REVERT_RUNNING_MESSAGE =
  "Reverting… Closing this doesn't stop it. You'll see the result when it's done.";
// The card stopped waiting for an answer; the request was not cancelled, so
// the origin may still save the revert, and a late answer is still shown.
export const REVERT_STILL_RUNNING_MESSAGE =
  "The revert is taking longer than expected. It may still finish, and you'll see the result when it does.";
// The dialog reopened while that request still runs. The card sends no
// second revert (it would only meet the first one's lease); it waits for
// the first one again.
export const REVERT_WAITING_AGAIN_MESSAGE =
  "Your earlier revert of this change is still running. Closing this doesn't stop it. You'll see the result when it's done.";

export function describeRevertOtherWork(otherPaths: readonly string[], canAskAgent: boolean): string {
  const undo = `This change was saved together with other work, so reverting it here would also undo ${formatPathList(otherPaths)}.`;
  return canAskAgent ? `${undo} Ask the agent to undo just this change.` : undo;
}

// A version published by merging (the space moved while the agent worked)
// has two parents. A revert of it needs a base, and that base would undo
// every local commit the merge brought in, not only this turn's: the card
// cannot bound it, so it never offers Revert for one. A Desktop origin's
// review of a clean merge lists no files at all, which is how the dialog
// recognises it; elsewhere the origin refuses the revert (400) before it
// writes anything.
const COMBINED_VERSION_MESSAGE =
  "This change was saved in a version that combines several saves, so it can't be reverted here.";

export function describeRevertCombined(canAskAgent: boolean): string {
  return canAskAgent ? `${COMBINED_VERSION_MESSAGE} Ask the agent to undo just this change.` : COMBINED_VERSION_MESSAGE;
}

export interface ChangeRevertOutcome {
  intent: "success" | "info" | "warning" | "error";
  message: string;
  // A new version that undoes the change reached the saved history (after a
  // retry that found nothing left to revert, most likely this revert's own).
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
        return asSentence(FILE_RULES.secret);
      }
      if (reason === "attachment") {
        return asSentence(FILE_RULES.attachment);
      }
      return asSentence(FILE_RULES.excluded);
    case "ignored_path":
      return asSentence(FILE_RULES.ignored);
    case "policy_rejected":
      return reason === "too_large"
        ? asSentence(FILE_RULES.too_large)
        : "This space's file rules refused one of its files.";
    default:
      return null;
  }
}

// The chat card asks once more on its own after a wait of at most 5 s.
const CARD_AUTO_RETRY_BUDGET: OriginAutoRetryBudget = { defaultDelayMs: 2000, maxDelayMs: 5000 };

// A gateway that cannot answer yet says so with a 503 and Retry-After: it is
// still fetching the space's saved history (fetch_pending), every write slot
// is taken (writes_busy) or its copy of the space is being made again
// (mirror_reset). The card retries once after that delay (at most 5 s)
// before it shows the code's copy. Null for every other answer, disk_full
// included: a full disk does not clear in a moment.
export function autoRetryDelayMs(
  error: Pick<OriginError, "code" | "retryAfterMs"> | null | undefined,
): number | null {
  return originAutoRetryDelayMs(error, CARD_AUTO_RETRY_BUDGET);
}

// The code a failed revert was answered with, or null.
export function revertAnswerCode(result: RevertWorkspaceGitCommitResult | null): string | null {
  if (!result || result.ok) {
    return null;
  }
  return result.code ?? result.errorInfo?.code ?? null;
}

// The same for the revert itself. Two of these answers can also come after
// the revert landed (see REVERT_MAY_HAVE_LANDED_CODES); one retry is still
// safe, because a revert main already holds is answered committed:false and
// writes nothing.
export function revertRetryDelayMs(result: RevertWorkspaceGitCommitResult | null): number | null {
  if (!result || result.ok) {
    return null;
  }
  const code = revertAnswerCode(result);
  return autoRetryDelayMs({ code: code ?? undefined, retryAfterMs: result.errorInfo?.retryAfterMs });
}

// The answers a revert can get after its push landed: the push's own answer
// was lost, and the fetch that confirms it was too slow (fetch_pending) or
// met a damaged copy (mirror_reset). writes_busy comes before any work.
const REVERT_MAY_HAVE_LANDED_CODES: ReadonlySet<string> = new Set(["fetch_pending", "mirror_reset"]);

// The check before Revert failed. A gateway that said to try again later
// (still fetching or making its copy again, even after one retry, or out
// of room) gets its own sentence; anything else the plain one.
export function revertCheckFailedCopy(code: string | null | undefined): string {
  return retryLaterCopy(code) ?? REVERT_CHECK_FAILED_MESSAGE;
}

const CHANGE_REVERT_FALLBACK_MESSAGE = "Couldn't revert this change. Try again, or ask the agent to undo it.";
const REVERT_UNDONE_COPY = "Those changes are undone.";

// What "Revert this change" did, as one toast: the request is
// `/git/revert-commit {commit: head}`, which undoes that saved version's own
// change (against its first parent). `retriedAfter` is the code of the
// answer the card's one automatic retry followed, if it made one.
export function describeChangeRevertOutcome(
  result: RevertWorkspaceGitCommitResult | null,
  options: { retriedAfter?: string | null } = {},
): ChangeRevertOutcome {
  const outcome = (
    intent: ChangeRevertOutcome["intent"],
    message: string,
    extra: Partial<Omit<ChangeRevertOutcome, "intent" | "message">> = {},
  ): ChangeRevertOutcome => ({ intent, message, reverted: false, unrevertedPaths: [], offerAgentUndo: false, ...extra });

  if (!result) {
    return outcome("error", CHANGE_REVERT_FALLBACK_MESSAGE, { offerAgentUndo: true });
  }
  if (result.ok) {
    if (result.committed === false) {
      // Nothing left to revert, after an answer that can follow a revert
      // whose push landed: most likely this revert's own, whose answer was
      // lost. The change is undone either way, and the card marks it.
      if (options.retriedAfter && REVERT_MAY_HAVE_LANDED_CODES.has(options.retriedAfter)) {
        return outcome("success", REVERT_UNDONE_COPY, { reverted: true });
      }
      return outcome("info", revertSuccessCopy(false));
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
    return outcome("success", revertSuccessCopy(true), { reverted: true });
  }

  const info = result.errorInfo;
  const code = result.code ?? info?.code ?? null;
  const status = info?.status ?? 0;
  const paths = result.paths ?? info?.paths ?? [];
  if (result.routeUnavailable || info?.routeUnavailable) {
    return outcome("warning", REVERT_ROUTE_UNAVAILABLE_MESSAGE, { offerAgentUndo: true });
  }
  // The gateway said to try again later. A full disk is an error; the other
  // answers clear in a moment.
  const later = retryLaterCopy(code);
  if (later) {
    return outcome(code === "disk_full" ? "error" : "warning", later);
  }
  switch (code) {
    case "revert_conflict":
      return outcome("warning", REVERT_CONFLICT_COPY, { offerAgentUndo: true });
    case "dirty_paths":
      return outcome("warning", revertDirtyPathsCopy(paths));
    case "main_busy":
      return outcome("warning", MAIN_BUSY_COPY);
    case "lease_conflict":
      return outcome("warning", LEASE_CONFLICT_COPY);
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
    default:
      break;
  }
  if (isUnreachableCode(code)) {
    return outcome("error", STATELESS_UNREACHABLE_COPY);
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
    return outcome("warning", MAIN_BUSY_COPY);
  }
  // A 400 is a version the origin cannot revert without a base: a merge,
  // which the card never sends a base for (see describeRevertCombined).
  if (status === 400) {
    return outcome("warning", `${COMBINED_VERSION_MESSAGE} Ask the agent to undo it.`, {
      offerAgentUndo: true,
    });
  }
  if (isUnreachableStatus(status)) {
    return outcome("error", STATELESS_UNREACHABLE_COPY);
  }
  return outcome("error", CHANGE_REVERT_FALLBACK_MESSAGE, { offerAgentUndo: true });
}
