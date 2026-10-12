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

/**
 * Who sent a prompt. "person" is a message someone sent from the chat
 * composer. Anything the app sends on their behalf (an automatic retry, a
 * prompt pre-filled from a link) is "app" or left unset. Only a person's
 * prompt may ask another device to act.
 */
export type LocalCapabilityPromptInitiator = "person" | "app";

export interface ExecuteLocalCapabilityPromptOptions {
  handle: BuiltInAssistantHandle;
  prompt: string;
  sessionId: string;
  runtimeMode: string;
  learningMode?: string;
  projectId?: string | null;
  conversationMessages?: readonly LocalCapabilityConversationMessage[];
  initiatedBy?: LocalCapabilityPromptInitiator;
  onStatus?: (status: LocalCapabilityStatusValue) => void;
  onCapabilityEvent?: (event: Record<string, unknown>) => void;
}

/**
 * One provider tool call for the device that holds a native runtime, asked
 * for by a prompt a person sent on a device that does not hold it.
 */
export interface LocalCapabilityRemoteToolCall {
  toolName: string;
  arguments?: Record<string, unknown>;
  /** Short name of the action for chat text. Defaults to the tool id. */
  title?: string;
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
  /**
   * The tool call this prompt asks of the device the provider is attached on,
   * when this device does not hold the provider. Null when the prompt has no
   * such call. Core sends it through the controller's provider-request queue
   * only for a person's prompt and only when the provider's native runtime
   * family lists the tool id in `remoteToolIds`.
   */
  resolveRemoteToolCall?: (
    options: LocalCapabilityRouteMatcherOptions,
  ) => LocalCapabilityRemoteToolCall | null;
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
