import type { BuiltInAssistantHandle } from "../assistants/localBuiltInAssistantCatalog";
import {
  executeLocalCapabilityPrompt,
  type LocalCapabilityStatusValue,
  type LocalCapabilityRuntimeResult,
} from "../capabilities/localCapabilityRuntime";
import type { LocalCapabilityConversationMessage } from "../capabilities/localCapabilityContributions";

export type LocalBuiltInCapabilityDispatchResult = LocalCapabilityRuntimeResult;

export interface DispatchLocalBuiltInCapabilityPromptOptions {
  handle: BuiltInAssistantHandle;
  prompt: string;
  conversationId: string;
  projectId?: string | null;
  conversationMessages?: readonly LocalCapabilityConversationMessage[];
  onStatus?: (status: LocalCapabilityStatusValue) => void;
  onCapabilityEvent?: (event: Record<string, unknown>) => void;
}

function makeLocalCapabilitySessionId(conversationId: string) {
  return `instafy_chat_${conversationId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 48)}`;
}

export async function dispatchLocalBuiltInCapabilityPrompt(
  options: DispatchLocalBuiltInCapabilityPromptOptions,
): Promise<LocalBuiltInCapabilityDispatchResult> {
  return executeLocalCapabilityPrompt({
    handle: options.handle,
    prompt: options.prompt,
    sessionId: makeLocalCapabilitySessionId(options.conversationId),
    projectId: options.projectId ?? null,
    runtimeMode: "conversation_local_capability",
    learningMode: "conversation_learning_session",
    conversationMessages: options.conversationMessages,
    onStatus: options.onStatus,
    onCapabilityEvent: options.onCapabilityEvent,
  });
}
