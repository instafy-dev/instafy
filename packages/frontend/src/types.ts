export type ProjectType = string;

export type AIModelChoice = string;

export type ProjectContent = Record<string, unknown>;

export interface DeploymentOptions {
  subdomain: string;
  hostingPlan: "instafy" | "self-host";
}

export interface BuildLogEntry {
  id: string;
  message: string;
  severity: "info" | "warn" | "error";
  timestamp: number;
}

export interface RuntimeState {
  buildLogs: BuildLogEntry[];
  activeConversationId: string | null;
  controllerReady: boolean;
  controllerProjectMissing: boolean;
  controllerUnavailable: boolean;
  controllerStreamDisconnected: boolean;
  controllerStreamDisconnectMessage: string | null;
}

export type RunType = "prompt" | "build" | "editor";

export type RunStatus =
  | "queued"
  | "in_progress"
  | "awaiting_approval"
  | "success"
  | "failed"
  | "canceled"
  | "merged";

export interface RunRecord {
  id: string;
  projectId: string | null;
  sessionId: string | null;
  conversationId: string | null;
  promptId: string | null;
  runType: RunType;
  status: RunStatus;
  progress: number;
  progressStage: string | null;
  previewUrl: string | null;
  lastMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export type NextStepSuggestionKind = "module" | "prompt" | "panel" | "resource" | "workflow" | "asset";

export type NextStepSuggestionSource = "template" | "system" | "ai";

export interface NextStepSuggestion {
  id: string;
  title: string;
  description: string;
  prompt?: string;
  panel?: "chat" | "code" | "credits";
  ctaLabel?: string;
  icon?: string;
  badge?: string;
  kind?: NextStepSuggestionKind;
  moduleId?: string;
  source?: NextStepSuggestionSource;
  isQuickAction?: boolean;
  metadata?: Record<string, unknown>;
}

export interface VersionControlSettings {
  enabled: boolean;
  provider: "github";
  mode: "managed" | "advanced";
  organization?: string;
  repository?: string;
  branch?: string;
  status: "idle" | "provisioning" | "linked" | "error";
  lastSyncedAt: string | null;
  automationEnabled: boolean;
  error?: string | null;
  repoUrl?: string | null;
}

export interface CollaborationSettings {
  enabled: boolean;
  inviteToken: string | null;
  allowGuestEditors: boolean;
  pendingInvites: Array<{
    email: string;
    status: "pending" | "accepted" | "expired";
    invitedAt: string;
  }>;
}

export interface BillingSubscriptionSummary {
  planId: string;
  status: string;
  processor: string;
  /** Subscription ends at currentPeriodEnd instead of renewing. */
  cancelAtPeriodEnd?: boolean;
  /** RFC3339 end of the current billing period (renewal or cancel date). */
  currentPeriodEnd?: string | null;
}

export interface BillingState {
  creditBalance: number;
  creditLimit: number;
  lastCreditBurnAt: string | null;
  lastCreditRefillAt: string | null;
  subscription: BillingSubscriptionSummary | null;
}

export interface ProjectMetadata {
  projectType: ProjectType;
  projectName: string;
  prompt: string;
  goal: string;
  targetAudience: string;
  tone: string;
  aiModel: AIModelChoice;
  tags: string[];
}

export interface ProjectOrgInfo {
  id: string | null;
  name: string | null;
}

export type WorkspaceEntryKind = "file" | "directory" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  size?: number | null;
  modified?: string | null;
  mimeType?: string | null;
  extension?: string | null;
  hasChildren?: boolean;
}

export interface CodeFile {
  id: string;
  path: string;
  label: string;
  directory?: string | null;
  kind?: WorkspaceEntryKind;
  mimeType?: string | null;
  size?: number | null;
  modifiedAt?: string | null;
  generated: string;
  modified: string;
}

export interface CodeWorkspace {
  files: CodeFile[];
  activeFileId: string | null;
  lastPrompt: string;
  lastGeneratedAt: string | null;
  summary: string;
  status: "idle" | "pending" | "succeeded" | "failed";
  provider: "openai" | "ollama" | "fallback" | "webcontainer" | "manual" | null;
  error: string | null;
  installedDependencies: string[];
  lastAppliedAt: string | null;
}

export interface SiteBuilderState {
  metadata: ProjectMetadata;
  content: ProjectContent;
  deployment: DeploymentOptions;
  code: CodeWorkspace;
  versionControl: VersionControlSettings;
  collaboration: CollaborationSettings;
  billing: BillingState;
  org: ProjectOrgInfo;
}
