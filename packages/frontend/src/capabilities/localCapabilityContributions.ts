import type {
  BuiltInAssistantDefinition,
  BuiltInAssistantHandle,
} from "@instafy/sdk/agents";
import type { LocalProviderSummary } from "./localProviderHostClient";

export interface LocalCapabilityConversationMessage {
  content?: string;
  metadata?: unknown;
}

export interface LocalCapabilityRuntimeResult {
  handled: boolean;
  responseText?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface LocalCapabilityStatusUpdate {
  text: string;
  metadata?: Record<string, unknown> | null;
}

export type LocalCapabilityStatusValue = string | LocalCapabilityStatusUpdate;

export interface ExecuteLocalCapabilityPromptOptions {
  handle: BuiltInAssistantHandle;
  prompt: string;
  sessionId: string;
  runtimeMode: string;
  learningMode?: string;
  projectId?: string | null;
  conversationMessages?: readonly LocalCapabilityConversationMessage[];
  onStatus?: (status: LocalCapabilityStatusValue) => void;
  onCapabilityEvent?: (event: Record<string, unknown>) => void;
}

export interface ResolveLocalCapabilityPromptHandleOptions {
  targetHandles: Iterable<string>;
  prompt: string;
  conversationMessages?: readonly LocalCapabilityConversationMessage[];
}

export type LocalCapabilityRouteMatcherOptions = {
  handle: BuiltInAssistantHandle;
  prompt: string;
  conversationState?: unknown;
};

export type LocalCapabilityRouteExecuteOptions =
  ExecuteLocalCapabilityPromptOptions & {
    assistantDefinition: BuiltInAssistantDefinition;
    resolvedProviderId?: string | null;
    resolvedProvider?: LocalProviderSummary | null;
    conversationState?: unknown;
  };

export type LocalCapabilityRouteDefinition = {
  id: string;
  capabilityId: string;
  requiresLocalProvider?: boolean;
  deriveConversationState?: (
    messages: readonly LocalCapabilityConversationMessage[],
  ) => unknown;
  resolveConversationHandle?: (conversationState: unknown) => string | null;
  buildPromptMetadataPatch?: (
    conversationState: unknown,
  ) => Record<string, unknown> | null;
  matches: (options: LocalCapabilityRouteMatcherOptions) => boolean;
  execute: (
    options: LocalCapabilityRouteExecuteOptions,
  ) => Promise<LocalCapabilityRuntimeResult>;
};

export type LocalCapabilityArtifact = {
  value: unknown;
  suggestedPath?: string | null;
  readyLabel: string;
  savedLabel: string;
  saveSuccessMessage: string;
  saveErrorMessage: string;
};

export type LocalCapabilityArtifactRegistration = {
  id: string;
  extract: (
    message: LocalCapabilityConversationMessage,
  ) => LocalCapabilityArtifact | null;
  promote: (input: {
    projectId: string;
    artifact: LocalCapabilityArtifact;
  }) => Promise<void>;
};
