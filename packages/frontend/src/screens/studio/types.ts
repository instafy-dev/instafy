import type { ComponentType } from "react";

export type StudioPanel =
  | "home"
  | "team"
  | "chat"
  | "code"
  | "extensions"
  | "skills"
  | "secrets"
  | "ai"
  | "automations"
  | "machines"
  | "credits"
  | "sourceControl"
  | "projects"
  | "settings";

export type SettingsTab = "org" | "project" | "profile";

export type ChatMessageFileChangeType = "created" | "deleted" | "changed" | "unknown";

export interface ChatMessageFileLineRange {
  from: number;
  to: number;
}

// Why one file of a run's changes did not reach the space's saved history,
// from the runtime's origin/apply artifact. "conflicted" comes from
// `conflictedPaths` (the space changed the file too, so the agent's version
// was kept aside); the rest are the `reason` of a `rejectedPaths` entry, and
// "unknown" is a rejected path whose origin gave no reason.
export type ChatMessageNotSavedReason =
  | "conflicted"
  | "excluded"
  | "secret"
  | "ignored"
  | "too_large"
  | "attachment"
  | "policy"
  | "unsupported"
  | "unknown";

export interface ChatMessageFileNotSaved {
  reason: ChatMessageNotSavedReason;
  // The space kept its own earlier saved version of the file.
  keptSavedVersion: boolean;
}

export interface ChatMessageFileChange {
  path: string;
  workspacePath: string;
  label: string;
  description?: string;
  mimeType?: string;
  changeType: ChatMessageFileChangeType;
  lineRanges: ChatMessageFileLineRange[];
  rawChange?: unknown;
  // Set when the run's save left this file out of the saved history.
  notSaved?: ChatMessageFileNotSaved | null;
  // A stopped turn's file no save took: what the turn left in it, for an
  // Undo that puts it back with no turn (see ChatMessageFolderUndo).
  folderUndo?: ChatMessageFolderUndo | null;
}

// What a turn the person stopped before its save left in one file, from its
// report (`apply/files` metadata `undo`): Undo puts the file back as the
// saved version has it, in the folder of the machine that ran the turn, only
// while it still holds what the turn left (`leftAs`: its blob id, or null for
// a file the turn removed), and only when the turn found it as saved.
export interface ChatMessageFolderUndo {
  leftAs: string | null;
  changedBefore: boolean;
  runtimeId: string | null;
}

// Where a commit range came from: "git" is the canonical pair the save
// published (`gitBaseRev..gitRev`), "apply" the origin's own apply pair,
// which can be commits that only exist on a runtime's checkout.
export type ChatMessageCommitRangeSource = "git" | "apply";

// The base..head commit pair of the run that produced a message's file
// changes, from the runtime's origin/apply artifact.
export interface ChatMessageCommitRange {
  base: string;
  head: string;
  // Absent on ranges built before the source was recorded; only a "git"
  // range can be reverted as a saved version.
  source?: ChatMessageCommitRangeSource;
  // "git" ranges only: every path the turn's save selected, which includes
  // files the turn changed without listing them (installs, generators).
  savedPaths?: string[];
}

// Why the run that produced a message's file changes left them out of the
// space's saved history, from the runtime's origin/apply artifact:
// "save_failed" when the save ran and failed, "auto_save_off" when saving
// was off so no save ran; from its origin/apply-error artifact,
// "save_not_started" when the save failed before the space took the files
// (its lease was refused or held by someone else), so they are on the
// machine alone and no later turn saves them; and "stopped_before_save" when
// the person stopped the turn before its save, from the stopped turn's
// report. Absent when the save worked (a partial save is reported per file
// instead), was never attempted, or the files went into a Desktop folder on
// the user's own disk.
export type ChatMessageUnsavedReason = "save_failed" | "save_not_started" | "auto_save_off" | "stopped_before_save";

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  authorId?: string | null;
  content: string;
  timestamp: number;
  files?: ChatMessageFileChange[] | null;
  commitRange?: ChatMessageCommitRange | null;
  unsavedReason?: ChatMessageUnsavedReason | null;
  messageType?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface StudioNavItem {
  id: StudioPanel;
  label: string;
  icon: ComponentType<{ className?: string }>;
  accent: string;
  badge?: {
    count: number;
    label: string;
  } | null;
  indicator?: {
    tone: "warning" | "danger";
    label: string;
  } | null;
}
