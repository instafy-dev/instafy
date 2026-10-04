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
// was off so no save ran. Absent when the save worked (a partial save is
// reported per file instead), was never attempted, or the files went into a
// Desktop folder on the user's own disk.
export type ChatMessageUnsavedReason = "save_failed" | "auto_save_off";

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
