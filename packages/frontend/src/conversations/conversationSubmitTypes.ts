import type { ControllerRuntimeStatusEntry } from "../services/runtimeController/runtimes";
import type { ChatMessage } from "../screens/studio/types";
import type { ConversationState, CreateConversationOptions } from "./conversationState";
import type { ConversationGoal } from "./conversationGoals";

export interface SubmitConversationRuntimeOverride {
  runtimeId: string | null;
  runtimeDisplayName: string | null;
  preferRuntime: boolean | null;
}

export interface SubmitConversationOptions {
  imageFile?: File | null;
  imageFiles?: File[];
  editorState?: string | null;
  agentHandles?: string[];
  dispatchInput?: string | null;
  metadata?: Record<string, unknown> | null;
  runtimeOverride?: SubmitConversationRuntimeOverride | null;
}

export interface UseConversationSubmitFlowArgs {
  conversations: ConversationState[];
  activeConversation: ConversationState | null;
  activeProjectId: string | null;
  currentUserId: string | null;
  preferredRuntimeId: string | null;
  runtimeStatuses: ControllerRuntimeStatusEntry[];
  effectiveRuntimeId: string | null;
  effectiveRuntimeSource: "session" | "preference" | "auto";
  showStatus: (
    message: string,
    intent: "info" | "success" | "warning" | "error",
    durationMs?: number,
  ) => void;
  createConversation: (options?: CreateConversationOptions) => ConversationState;
  selectConversation: (conversationId: string) => void;
  markConversationRead: (conversationId: string) => void;
  setConversationDraft: (
    conversationId: string,
    draft: string,
    editorState?: string | null,
  ) => void;
  setConversationControllerId: (conversationId: string, controllerId: string | null) => void;
  setConversationTitle: (conversationId: string, title: string) => void;
  setConversationGoal: (conversationId: string, goal: ConversationGoal | null) => void;
  appendMessages: (conversationId: string, messages: ChatMessage[]) => void;
  updateMessage: (
    conversationId: string,
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage,
  ) => void;
  linkRunToConversation: (runId: string, conversationId: string) => void;
}
