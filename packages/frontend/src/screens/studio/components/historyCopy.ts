import type {
  OriginError,
  OriginRejectedPath,
  RevertWorkspaceGitCommitResult,
  WorkspaceGitHistoryEntry,
} from "../../../sdk/instafy";

/**
 * Copy and presentation rules for History (stateless and desktop modes).
 * Plain sentences, no em dashes; the legacy Changes drawer keeps its own copy.
 */

export type HistoryOriginKind = "stateless" | "desktop";

export type HistoryNoticeTone = "success" | "info" | "warning" | "error";

/** One message in the drawer's polite status region, with at most one action. */
export interface HistoryNotice {
  tone: HistoryNoticeTone;
  text: string;
  action?: { label: string; onPress: () => void; testId: string } | null;
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Lists and counts
// ---------------------------------------------------------------------------

export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function formatFileCount(count: number): string {
  return `${count} ${pluralize(count, "file", "files")}`;
}

/** "a, b, c and 2 more" */
export function formatPathList(paths: string[], max = 4): string {
  const unique = Array.from(new Set(paths.filter((path) => path.trim().length > 0)));
  if (unique.length <= max) {
    return unique.join(", ");
  }
  return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`;
}

// ---------------------------------------------------------------------------
// Unsaved work
// ---------------------------------------------------------------------------

const UNSAVED_WORK_TITLES: Record<string, string> = {
  conflict: "Agent work that conflicted with newer changes",
  unpublished: "Agent work that couldn't be saved",
  unsaved: "Unsaved edits from a stopped workspace",
  stale: "Older copies found in a workspace",
  salvage: "Archived from the old file server",
};

export function unsavedWorkTitle(kind: string): string {
  return UNSAVED_WORK_TITLES[kind] ?? "Unsaved work";
}

// ---------------------------------------------------------------------------
// Shared error copy
// ---------------------------------------------------------------------------

export const MAIN_BUSY_COPY = "The space is busy saving other changes. Try again in a moment.";
export const LEASE_CONFLICT_COPY = "The agent is saving right now. Try again in a moment.";
export const FETCH_PENDING_COPY = "The space is still loading. Try again in a moment.";
export const STATELESS_UNREACHABLE_COPY = "Couldn't reach the space's saved files. Try again.";
export const DESKTOP_UNREACHABLE_COPY = "The folder on this computer isn't connected.";
export const DISMISSAL_NOT_APPLIED_COPY =
  "Not saved yet: work you removed is still on this computer's branch. Try again in a moment.";

function notSavedCopy(error: OriginError): string {
  const failure = error.report?.failure?.trim() || error.message.trim() || "the save stopped";
  const sentence = failure.replace(/[.\s]+$/, "");
  return `Not saved: ${sentence}. The work is kept under History, in Unsaved work.`;
}

/**
 * Copy for the failures every History action shares (busy, lease, reach,
 * Desktop publish refusals). Null when the caller should use its own copy.
 */
export function sharedOriginErrorCopy(error: OriginError, origin: HistoryOriginKind): string | null {
  switch (error.code) {
    case "main_busy":
      return MAIN_BUSY_COPY;
    case "lease_conflict":
      return LEASE_CONFLICT_COPY;
    case "fetch_pending":
      return FETCH_PENDING_COPY;
    case "not_saved":
      return notSavedCopy(error);
    case "dismissal_not_applied":
      return DISMISSAL_NOT_APPLIED_COPY;
    case "token_unavailable":
    case "network_error":
    case "timeout":
    case "canonical_unreachable":
      return origin === "desktop" ? DESKTOP_UNREACHABLE_COPY : STATELESS_UNREACHABLE_COPY;
    default:
      break;
  }
  if (error.status === 0 || error.status === 502 || error.status === 504) {
    return origin === "desktop" ? DESKTOP_UNREACHABLE_COPY : STATELESS_UNREACHABLE_COPY;
  }
  if (error.status === 503) {
    return FETCH_PENDING_COPY;
  }
  return null;
}

function trimMessage(message: string | null | undefined): string {
  const text = (message ?? "").trim().replace(/[.\s]+$/, "");
  return text ? ` ${text}.` : "";
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

export const REVERT_DIALOG = {
  title: "Revert this version?",
  body: "A new version that undoes it is saved on top. Nothing is removed from history.",
  cancel: "Cancel",
  confirm: "Revert",
} as const;

export const REVERT_ROUTE_UNAVAILABLE_COPY =
  "Reverting isn't available on this server yet. Ask the agent to undo it instead.";

export function revertSuccessCopy(committed: boolean | undefined): string {
  return committed === false
    ? "Nothing to revert. Those changes are already undone."
    : "Reverted. Saved as a new version.";
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
    return {
      tone: "warning",
      text: "Later changes touch the same files, so this can't be reverted automatically.",
      askAgent: true,
    };
  }
  if (code === "dirty_paths") {
    const paths = formatPathList(result.paths ?? error?.paths ?? []);
    return {
      tone: "warning",
      text: `Files on this computer have edits this revert would change: ${paths}. Save them first.`,
    };
  }
  if (result.routeUnavailable || error?.routeUnavailable) {
    return { tone: "warning", text: REVERT_ROUTE_UNAVAILABLE_COPY };
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
  return { tone: "error", text: `Couldn't revert this version.${trimMessage(error?.message ?? result.error)}` };
}

// ---------------------------------------------------------------------------
// Desktop line
// ---------------------------------------------------------------------------

/** `/git/sync` always carries a message; this one names no person. */
export const DESKTOP_SAVE_MESSAGE = "Save changes from this computer";

export function desktopChangesLabel(count: number): string {
  return `${formatFileCount(count)} changed outside Studio`;
}

const KEPT_ON_COMPUTER_REASONS: Record<string, string> = {
  secret: "secret files aren't saved to the space",
  ignored: "files that match .gitignore aren't saved to the space",
  excluded: "build output, dependency and cache folders aren't saved to the space",
  too_large: "files larger than 20 MB aren't saved to the space",
  attachment: "old chat upload files aren't saved to the space",
  policy: "this space's file rules refused it",
  unsupported: "links and special files can't be saved",
};

/** One sentence per refusal reason: ".env stays on this computer: secret files aren't saved to the space." */
export function keptOnComputerCopy(rejected: OriginRejectedPath[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const item of rejected) {
    const reason = item.reason?.trim() || "other";
    byReason.set(reason, [...(byReason.get(reason) ?? []), item.path]);
  }
  return Array.from(byReason.entries()).map(([reason, paths]) => {
    const clause = KEPT_ON_COMPUTER_REASONS[reason] ?? "the space refused it";
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
  return sharedOriginErrorCopy(error, "desktop") ?? `Couldn't save the folder's changes.${trimMessage(error.message)}`;
}

// ---------------------------------------------------------------------------
// Restore and remove
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

/**
 * A finished restore. `kept` are the paths the person chose "Keep current"
 * for (the server reports them in `notRestored` too); only the rest of
 * `notRestored` were refused as secret or ignored. `committed: false` means
 * no version was made: the saved version already held everything that could
 * be restored, so the copy says what was left out first (never that the
 * space has the refused files). `entryPaths` is every path the entry holds,
 * or null when that is not known (a conflict entry lists only its conflicted
 * paths): the copy speaks of "the rest" only when there was one.
 */
export function restoreSuccessCopy({
  committed,
  notRestored,
  kept = [],
  entryPaths = null,
}: {
  committed: boolean | null | undefined;
  notRestored: string[];
  kept?: string[];
  entryPaths?: string[] | null;
}): string {
  const keptSet = new Set(kept);
  const keptPaths = Array.from(keptSet);
  const refused = notRestored.filter((path) => !keptSet.has(path));
  const leftOut: string[] = [];
  if (keptPaths.length > 0) {
    leftOut.push(`Kept the current version of ${formatPathList(keptPaths)}.`);
  }
  if (refused.length > 0) {
    leftOut.push(`Not restored: ${formatPathList(refused)}. Secret and ignored files stay out of the space.`);
  }
  if (committed !== false) {
    return ["Restored as a new version.", ...leftOut].join(" ");
  }
  if (leftOut.length === 0) {
    return "Nothing to restore. The saved version already has this work.";
  }
  const leftOutSet = new Set([...keptPaths, ...refused]);
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

export function restoreDirtyPathsCopy(paths: string[]): string {
  return `Files on this computer have edits this restore would change: ${formatPathList(paths)}. Save them first.`;
}

export const DESKTOP_FOLDER_UNCHECKED_COPY =
  "Couldn't check this file in the folder on this computer, so nothing was saved. Try again.";

/** "Use this version" on Desktop could not confirm the folder's copy is safe to replace. */
export function desktopFolderUncheckedCopy(error: OriginError | null | undefined): string {
  return (error ? sharedOriginErrorCopy(error, "desktop") : null) ?? DESKTOP_FOLDER_UNCHECKED_COPY;
}

export function unsavedWorkAskAgentPrompt(path: string, ref: string): string {
  return `Merge \`${path}\` from \`${ref}\` into the saved version. Read it with \`instafy git show ${ref}:${path}\`.`;
}

export function historyFailureCopy(
  error: OriginError | null | undefined,
  origin: HistoryOriginKind,
  fallback: string,
): string {
  if (!error) {
    return origin === "desktop" ? DESKTOP_UNREACHABLE_COPY : STATELESS_UNREACHABLE_COPY;
  }
  return sharedOriginErrorCopy(error, origin) ?? `${fallback}${trimMessage(error.message)}`;
}
