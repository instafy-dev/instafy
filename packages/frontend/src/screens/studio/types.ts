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

export interface ChatMessageFileChange {
  path: string;
  workspacePath: string;
  label: string;
  description?: string;
  mimeType?: string;
  changeType: ChatMessageFileChangeType;
  lineRanges: ChatMessageFileLineRange[];
  rawChange?: unknown;
}

// The base..head commit pair of the run that produced a message's file
// changes, from the runtime's origin/apply artifact.
export interface ChatMessageCommitRange {
  base: string;
  head: string;
}

// Why the run that produced a message's file changes left them out of the
// space's saved history, from the runtime's origin/apply artifact:
// "save_failed" when the save ran and failed, "auto_save_off" when auto-save
// was off so no save ran. Absent when the save worked, was never attempted,
// or the files went into a Desktop folder on the user's own disk.
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
