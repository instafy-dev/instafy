import type { ComponentType } from "react";

export type StudioPanel =
  | "home"
  | "chat"
  | "code"
  | "extensions"
  | "skills"
  | "secrets"
  | "ai"
  | "automations"
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

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  authorId?: string | null;
  content: string;
  timestamp: number;
  files?: ChatMessageFileChange[] | null;
  commitRange?: ChatMessageCommitRange | null;
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
