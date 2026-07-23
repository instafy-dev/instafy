import type { ChatMessage } from "../screens/studio/types";
import { normalizeCustomAgentHandle } from "../assistants/localBuiltInAssistantCatalog";
import { isUuid, mergeAndSortMessages } from "./conversationMessageUtils";
import {
  DEFAULT_CONVERSATION_ROUTING_PREFERENCES,
  normalizeConversationRoutingHandles,
} from "./conversationRoutingMetadata";
import {
  countNewUnreadAssistantMessages,
  countNewUnreadConversationMessages,
} from "./unreadCount";
import {
  computePlanSignature,
  deriveRuntimePreferenceFromMessages,
  type ConversationOwnerAgent,
  type ConversationLifecycleStatus,
  type ConversationRuntimePreference,
  type ConversationVisibility,
} from "./conversationMetadata";
import {
  shouldApplyConversationGoalSnapshot,
  type ConversationGoal,
} from "./conversationGoals";

export interface ConversationState {
  localId: string;
  title: string;
  visibility: ConversationVisibility;
  lifecycleStatus: ConversationLifecycleStatus;
  controllerId: string | null;
  hasRemoteMessages?: boolean;
  parentConversationId: string | null;
  threadKind: string | null;
  ownerAgent: ConversationOwnerAgent | null;
  activeGoal: ConversationGoal | null;
  originMessageId: string | null;
  delegatedByAgentId: string | null;
  messages: ChatMessage[];
  draft: string;
  draftEditorState: string | null;
  assistantEnabled: boolean;
  extraAgentHandles: string[];
  unreadCount: number;
  createdAt: number;
  pendingRunIds: string[];
  awaitingLeaseRunIds: string[];
  pendingRunSubmittedAt: Record<string, number>;
  runtimePreference: ConversationRuntimePreference | null;
}

export interface ConversationsState {
  projectKey: string;
  conversations: ConversationState[];
  activeId: string | null;
  sequence: number;
  runMap: Record<string, string>;
}

export interface CreateConversationOptions {
  title?: string;
  messages?: ChatMessage[];
  visibility?: ConversationVisibility;
  parentConversationId?: string | null;
  threadKind?: string | null;
  ownerAgent?: ConversationOwnerAgent | null;
  activeGoal?: ConversationGoal | null;
  originMessageId?: string | null;
  delegatedByAgentId?: string | null;
  assistantEnabled?: boolean;
  extraAgentHandles?: string[];
  select?: boolean;
}

interface CreateConversationAction {
  type: "CREATE";
  conversation: ConversationState;
  select: boolean;
}

export type ConversationsAction =
  | CreateConversationAction
  | { type: "SELECT"; id: string }
  | { type: "CLOSE"; id: string }
  | { type: "SET_LIFECYCLE"; id: string; status: ConversationLifecycleStatus }
  | { type: "SET_DRAFT"; id: string; draft: string; editorState: string | null }
  | { type: "SET_ASSISTANT_ENABLED"; id: string; enabled: boolean }
  | {
      type: "SET_ROUTING_PREFERENCES";
      id: string;
      assistantEnabled: boolean;
      extraAgentHandles: string[];
    }
  | { type: "ADD_AGENT_HANDLE"; id: string; handle: string }
  | { type: "REMOVE_AGENT_HANDLE"; id: string; handle: string }
  | { type: "APPEND"; id: string; messages: ChatMessage[] }
  | { type: "REPLACE"; id: string; messages: ChatMessage[] }
  | {
      type: "UPDATE_MESSAGE";
      conversationId: string;
      messageId: string;
      updater: (message: ChatMessage) => ChatMessage;
    }
  | { type: "SET_CONTROLLER"; id: string; controllerId: string | null }
  | { type: "SET_REMOTE_HISTORY"; id: string; hasMessages: boolean }
  | { type: "SET_TITLE"; id: string; title: string }
  | { type: "SET_GOAL"; id: string; goal: ConversationGoal | null }
  | { type: "SET_VISIBILITY"; id: string; visibility: ConversationVisibility }
  | {
      type: "SET_THREAD_META";
      id: string;
      parentConversationId: string | null;
      threadKind: string | null;
      ownerAgent: ConversationOwnerAgent | null;
      originMessageId: string | null;
      delegatedByAgentId: string | null;
    }
  | { type: "MARK_READ"; id: string }
  | { type: "LINK_RUN"; runId: string; conversationId: string }
  | { type: "UNLINK_RUN"; runId: string }
  | { type: "LEASE_CONFIRMED"; conversationId: string; runId: string }
  | {
      type: "APPLY_REMOTE_MESSAGE";
      conversationId: string;
      message: ChatMessage;
      currentUserId: string | null;
    }
  | { type: "LOAD_STATE"; state: ConversationsState };

export const makeConversationId = () =>
  `conv-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function resolveInitialConversationParamsFromQuery(requireProjectId?: string | null): {
  localId: string | null;
  controllerId: string | null;
} {
  if (typeof window === "undefined") {
    return { localId: null, controllerId: null };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const required = requireProjectId && isUuid(requireProjectId) ? requireProjectId : null;
    if (required) {
      const projectParam = params.get("projectId");
      if (!projectParam || projectParam.trim() !== required) {
        return { localId: null, controllerId: null };
      }
    }
    const conversationId = params.get("conversationId");
    const controllerId = params.get("conversationControllerId");
    const localId =
      conversationId && conversationId.trim().length > 0
        ? conversationId.trim()
        : null;
    const controller =
      controllerId && controllerId.trim().length > 0 ? controllerId.trim() : null;
    return {
      localId,
      controllerId: isUuid(controller) ? controller : null,
    };
  } catch {
    return { localId: null, controllerId: null };
  }
}

export function createInitialConversation(prefilled?: {
  localId?: string | null;
  controllerId?: string | null;
}): ConversationState {
  return {
    localId:
      prefilled?.localId && prefilled.localId.length > 0
        ? prefilled.localId
        : makeConversationId(),
    title: "Conversation 1",
    visibility: "public",
    lifecycleStatus: "active",
    controllerId: prefilled?.controllerId ?? null,
    hasRemoteMessages: false,
    parentConversationId: null,
    threadKind: null,
    ownerAgent: null,
    activeGoal: null,
    originMessageId: null,
    delegatedByAgentId: null,
    messages: [],
    draft: "",
    draftEditorState: null,
    assistantEnabled: DEFAULT_CONVERSATION_ROUTING_PREFERENCES.assistantEnabled,
    extraAgentHandles: [
      ...DEFAULT_CONVERSATION_ROUTING_PREFERENCES.extraAgentHandles,
    ],
    unreadCount: 0,
    createdAt: Date.now(),
    pendingRunIds: [],
    awaitingLeaseRunIds: [],
    pendingRunSubmittedAt: {},
    runtimePreference: null,
  };
}

export function createInitialState(projectKey = "default"): ConversationsState {
  const params = resolveInitialConversationParamsFromQuery(projectKey);
  const conversation = createInitialConversation(params);
  return {
    projectKey,
    conversations: [conversation],
    activeId: conversation.localId,
    sequence: 2,
    runMap: {},
  };
}

export function isEmptyConversationPlaceholder(
  conversation: ConversationState,
): boolean {
  if (conversation.controllerId) {
    return false;
  }
  if (conversation.messages.length > 0) {
    return false;
  }
  if (conversation.draft.trim().length > 0) {
    return false;
  }
  if (conversation.pendingRunIds.length > 0) {
    return false;
  }
  if (conversation.awaitingLeaseRunIds.length > 0) {
    return false;
  }
  return true;
}

export function isAttachableConversation(
  conversation: ConversationState,
): boolean {
  if (conversation.controllerId) {
    return false;
  }
  if (conversation.messages.length > 0) {
    return false;
  }
  if (conversation.pendingRunIds.length > 0) {
    return false;
  }
  if (conversation.awaitingLeaseRunIds.length > 0) {
    return false;
  }
  return true;
}

export function extractLastUserMessageContent(
  conversation: ConversationState,
): string | null {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role === "user") {
      const content = message.content.trim();
      return content.length > 0 ? content : null;
    }
  }
  return null;
}

function normalizePendingRunSubmittedAt(
  pendingRunIds: string[],
  raw: unknown,
): Record<string, number> {
  const fallbackAt = Date.now();
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const normalized: Record<string, number> = {};
  pendingRunIds.forEach((runId) => {
    const value = record?.[runId];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      normalized[runId] = value;
      return;
    }
    normalized[runId] = fallbackAt;
  });
  return normalized;
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstText(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function resolveAppendClientMessageId(message: ChatMessage): string | null {
  const metadata = isMetadataRecord(message.metadata) ? message.metadata : null;
  const promptMetadata =
    metadata && isMetadataRecord(metadata.promptMetadata)
      ? metadata.promptMetadata
      : metadata && isMetadataRecord(metadata.prompt_metadata)
        ? metadata.prompt_metadata
        : metadata;
  return firstText([
    metadata?.clientMessageId,
    metadata?.client_message_id,
    promptMetadata?.clientMessageId,
    promptMetadata?.client_message_id,
  ]);
}

function appendUniqueConversationMessages(
  existingMessages: ChatMessage[],
  incomingMessages: ChatMessage[],
): ChatMessage[] {
  if (incomingMessages.length === 0) {
    return existingMessages;
  }
  const nextMessages = [...existingMessages];
  const seenIds = new Set(nextMessages.map((message) => message.id));
  const seenClientMessageIds = new Set(
    nextMessages
      .map(resolveAppendClientMessageId)
      .filter((entry): entry is string => Boolean(entry)),
  );

  incomingMessages.forEach((message) => {
    if (seenIds.has(message.id)) {
      return;
    }
    const clientMessageId = resolveAppendClientMessageId(message);
    if (clientMessageId && seenClientMessageIds.has(clientMessageId)) {
      return;
    }
    nextMessages.push(message);
    seenIds.add(message.id);
    if (clientMessageId) {
      seenClientMessageIds.add(clientMessageId);
    }
  });
  return nextMessages;
}

export function cloneConversationState(
  conversation: ConversationState,
): ConversationState {
  const pendingRunSubmittedAt = normalizePendingRunSubmittedAt(
    conversation.pendingRunIds,
    conversation.pendingRunSubmittedAt,
  );
  return {
    ...conversation,
    messages: [...conversation.messages],
    pendingRunIds: [...conversation.pendingRunIds],
    awaitingLeaseRunIds: [...conversation.awaitingLeaseRunIds],
    pendingRunSubmittedAt,
    extraAgentHandles: [...conversation.extraAgentHandles],
    ownerAgent: conversation.ownerAgent ? { ...conversation.ownerAgent } : null,
    activeGoal: conversation.activeGoal ? { ...conversation.activeGoal } : null,
    originMessageId: conversation.originMessageId ?? null,
    delegatedByAgentId: conversation.delegatedByAgentId ?? null,
    runtimePreference: conversation.runtimePreference
      ? { ...conversation.runtimePreference }
      : null,
  };
}

export function cloneConversationsState(
  state: ConversationsState,
): ConversationsState {
  return {
    projectKey: state.projectKey,
    conversations: state.conversations.map(cloneConversationState),
    activeId: state.activeId,
    sequence: state.sequence,
    runMap: { ...state.runMap },
  };
}

function normalizeExtraAgentHandle(raw: string): string | null {
  return normalizeCustomAgentHandle(raw);
}

export function conversationsReducer(
  state: ConversationsState,
  action: ConversationsAction,
): ConversationsState {
  switch (action.type) {
    case "LOAD_STATE": {
      return cloneConversationsState(action.state);
    }
    case "CREATE": {
      const conversations = [...state.conversations, action.conversation];
      const shouldSelect = action.select || state.activeId === null;
      return {
        projectKey: state.projectKey,
        conversations,
        activeId: shouldSelect ? action.conversation.localId : state.activeId,
        sequence: Math.max(state.sequence, conversations.length + 1),
        runMap: state.runMap,
      };
    }
    case "SELECT": {
      if (
        !state.conversations.some(
          (conversation) => conversation.localId === action.id,
        )
      ) {
        return state;
      }
      return {
        ...state,
        activeId: action.id,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? { ...conversation, unreadCount: 0 }
            : conversation,
        ),
      };
    }
    case "CLOSE": {
      if (state.conversations.length <= 1) {
        return state;
      }
      const conversations = state.conversations.filter(
        (conversation) => conversation.localId !== action.id,
      );
      const runEntries = Object.entries(state.runMap).filter(
        ([, conversationId]) => conversationId !== action.id,
      );
      const runMap = Object.fromEntries(runEntries);
      let activeId = state.activeId;
      if (activeId === action.id) {
        const fallback =
          conversations[conversations.length - 1] ?? conversations[0] ?? null;
        activeId = fallback ? fallback.localId : null;
      }
      return {
        projectKey: state.projectKey,
        conversations,
        activeId,
        sequence: state.sequence,
        runMap,
      };
    }
    case "SET_LIFECYCLE": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? { ...conversation, lifecycleStatus: action.status }
            : conversation,
        ),
      };
    }
    case "SET_DRAFT": {
      const trimmed = action.draft.trim();
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? {
                ...conversation,
                draft: action.draft,
                draftEditorState: trimmed.length > 0 ? action.editorState : null,
              }
            : conversation,
        ),
      };
    }
    case "SET_ASSISTANT_ENABLED": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? { ...conversation, assistantEnabled: action.enabled }
            : conversation,
        ),
      };
    }
    case "SET_ROUTING_PREFERENCES": {
      const nextHandles = normalizeConversationRoutingHandles(
        action.extraAgentHandles,
      );
      return {
        ...state,
        conversations: state.conversations.map((conversation) => {
          if (conversation.localId !== action.id) {
            return conversation;
          }
          const sameEnabled =
            conversation.assistantEnabled === action.assistantEnabled;
          const sameHandles =
            conversation.extraAgentHandles.length === nextHandles.length &&
            conversation.extraAgentHandles.every(
              (handle, index) => handle === nextHandles[index],
            );
          if (sameEnabled && sameHandles) {
            return conversation;
          }
          return {
            ...conversation,
            assistantEnabled: action.assistantEnabled,
            extraAgentHandles: nextHandles,
          };
        }),
      };
    }
    case "ADD_AGENT_HANDLE": {
      const normalized = normalizeExtraAgentHandle(action.handle);
      if (!normalized) {
        return state;
      }
      let changed = false;
      const conversations = state.conversations.map((conversation) => {
        if (conversation.localId !== action.id) {
          return conversation;
        }
        if (conversation.extraAgentHandles.includes(normalized)) {
          return conversation;
        }
        changed = true;
        return {
          ...conversation,
          extraAgentHandles: [...conversation.extraAgentHandles, normalized],
        };
      });
      return changed ? { ...state, conversations } : state;
    }
    case "REMOVE_AGENT_HANDLE": {
      const normalized = normalizeExtraAgentHandle(action.handle);
      if (!normalized) {
        return state;
      }
      let changed = false;
      const conversations = state.conversations.map((conversation) => {
        if (conversation.localId !== action.id) {
          return conversation;
        }
        if (!conversation.extraAgentHandles.includes(normalized)) {
          return conversation;
        }
        changed = true;
        return {
          ...conversation,
          extraAgentHandles: conversation.extraAgentHandles.filter(
            (handle) => handle !== normalized,
          ),
        };
      });
      return changed ? { ...state, conversations } : state;
    }
    case "APPEND": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) => {
          if (conversation.localId !== action.id) {
            return conversation;
          }
          const nextMessages = appendUniqueConversationMessages(
            conversation.messages,
            action.messages,
          );
          const runtimePreference =
            deriveRuntimePreferenceFromMessages(nextMessages);
          const unreadIncrement =
            conversation.localId === state.activeId
              ? 0
              : countNewUnreadAssistantMessages(
                  conversation.messages,
                  nextMessages,
                );
          return {
            ...conversation,
            messages: nextMessages,
            unreadCount:
              conversation.localId === state.activeId
                ? 0
                : conversation.unreadCount + unreadIncrement,
            runtimePreference,
          };
        }),
      };
    }
    case "REPLACE": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? {
                ...conversation,
                messages: action.messages,
                unreadCount:
                  conversation.localId === state.activeId
                    ? 0
                    : conversation.unreadCount +
                      countNewUnreadAssistantMessages(
                        conversation.messages,
                        action.messages,
                      ),
                runtimePreference:
                  deriveRuntimePreferenceFromMessages(action.messages),
              }
            : conversation,
        ),
      };
    }
    case "UPDATE_MESSAGE": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) => {
          if (conversation.localId !== action.conversationId) {
            return conversation;
          }
          const nextMessages = conversation.messages.map((message) =>
            message.id === action.messageId ? action.updater(message) : message,
          );
          return {
            ...conversation,
            messages: nextMessages,
            runtimePreference: deriveRuntimePreferenceFromMessages(nextMessages),
          };
        }),
      };
    }
    case "SET_CONTROLLER": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? { ...conversation, controllerId: action.controllerId }
            : conversation,
        ),
      };
    }
    case "SET_REMOTE_HISTORY": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? { ...conversation, hasRemoteMessages: action.hasMessages }
            : conversation,
        ),
      };
    }
    case "SET_TITLE": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? { ...conversation, title: action.title }
            : conversation,
        ),
      };
    }
    case "SET_GOAL": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? shouldApplyConversationGoalSnapshot(conversation.activeGoal, action.goal)
              ? { ...conversation, activeGoal: action.goal ? { ...action.goal } : null }
              : conversation
            : conversation,
        ),
      };
    }
    case "SET_VISIBILITY": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? { ...conversation, visibility: action.visibility }
            : conversation,
        ),
      };
    }
    case "SET_THREAD_META": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? {
                ...conversation,
                parentConversationId: action.parentConversationId,
                threadKind: action.threadKind,
                ownerAgent: action.ownerAgent ? { ...action.ownerAgent } : null,
                originMessageId: action.originMessageId,
                delegatedByAgentId: action.delegatedByAgentId,
              }
            : conversation,
        ),
      };
    }
    case "MARK_READ": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.localId === action.id
            ? { ...conversation, unreadCount: 0 }
            : conversation,
        ),
      };
    }
    case "LINK_RUN": {
      const existingConversationId = state.runMap[action.runId];
      const runMap =
        existingConversationId === action.conversationId
          ? state.runMap
          : {
              ...state.runMap,
              [action.runId]: action.conversationId,
            };
      return {
        ...state,
        runMap,
        conversations: state.conversations.map((conversation) => {
          if (conversation.localId !== action.conversationId) {
            return conversation;
          }
          const alreadyPending = conversation.pendingRunIds.includes(
            action.runId,
          );
          const alreadyAwaitingLease = conversation.awaitingLeaseRunIds.includes(
            action.runId,
          );
          const submittedAt =
            conversation.pendingRunSubmittedAt[action.runId] ?? Date.now();
          if (
            alreadyPending &&
            alreadyAwaitingLease &&
            conversation.pendingRunSubmittedAt[action.runId] === submittedAt
          ) {
            return conversation;
          }
          return {
            ...conversation,
            pendingRunIds: alreadyPending
              ? conversation.pendingRunIds
              : [...conversation.pendingRunIds, action.runId],
            awaitingLeaseRunIds: alreadyAwaitingLease
              ? conversation.awaitingLeaseRunIds
              : [...conversation.awaitingLeaseRunIds, action.runId],
            pendingRunSubmittedAt: {
              ...conversation.pendingRunSubmittedAt,
              [action.runId]: submittedAt,
            },
          };
        }),
      };
    }
    case "UNLINK_RUN": {
      const mappedConversationId = state.runMap[action.runId] ?? null;
      const rest =
        action.runId in state.runMap
          ? (() => {
              const next = { ...state.runMap };
              delete next[action.runId];
              return next;
            })()
          : state.runMap;
      let changed = action.runId in state.runMap;
      const nextConversations = state.conversations.map((conversation) => {
        const shouldProcess = mappedConversationId
          ? conversation.localId === mappedConversationId
          : conversation.pendingRunIds.includes(action.runId) ||
            conversation.awaitingLeaseRunIds.includes(action.runId);
        if (!shouldProcess) {
          return conversation;
        }
        const nextPendingRunIds = conversation.pendingRunIds.filter(
          (runId) => runId !== action.runId,
        );
        const nextAwaitingLeaseRunIds =
          conversation.awaitingLeaseRunIds.filter(
            (runId) => runId !== action.runId,
          );
        const hadSubmittedAt = action.runId in conversation.pendingRunSubmittedAt;
        const nextPendingRunSubmittedAt = { ...conversation.pendingRunSubmittedAt };
        delete nextPendingRunSubmittedAt[action.runId];
        if (
          nextPendingRunIds.length === conversation.pendingRunIds.length &&
          nextAwaitingLeaseRunIds.length ===
            conversation.awaitingLeaseRunIds.length &&
          !hadSubmittedAt
        ) {
          return conversation;
        }
        changed = true;
        return {
          ...conversation,
          pendingRunIds: nextPendingRunIds,
          awaitingLeaseRunIds: nextAwaitingLeaseRunIds,
          pendingRunSubmittedAt: nextPendingRunSubmittedAt,
        };
      });
      if (!changed) {
        return state;
      }
      return {
        ...state,
        runMap: rest,
        conversations: nextConversations,
      };
    }
    case "LEASE_CONFIRMED": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) => {
          if (conversation.localId !== action.conversationId) {
            return conversation;
          }
          const nextPendingRunSubmittedAt = {
            ...conversation.pendingRunSubmittedAt,
          };
          delete nextPendingRunSubmittedAt[action.runId];
          return {
            ...conversation,
            awaitingLeaseRunIds: conversation.awaitingLeaseRunIds.filter(
              (runId) => runId !== action.runId,
            ),
            pendingRunSubmittedAt: nextPendingRunSubmittedAt,
          };
        }),
      };
    }
    case "APPLY_REMOTE_MESSAGE": {
      return {
        ...state,
        conversations: state.conversations.map((conversation) => {
          if (conversation.localId !== action.conversationId) {
            return conversation;
          }
          const existingIndex = conversation.messages.findIndex(
            (message) => message.id === action.message.id,
          );
          let nextMessages: ChatMessage[];
          if (existingIndex >= 0) {
            const mergedRemote = mergeAndSortMessages([
              conversation.messages[existingIndex],
              action.message,
            ])[0];
            nextMessages = conversation.messages.map((message, index) =>
              index === existingIndex ? mergedRemote ?? action.message : message,
            );
          } else {
            const filtered = conversation.messages.filter(
              (message) =>
                !(
                  message.role === action.message.role &&
                  message.content === action.message.content &&
                  !isUuid(message.id)
                ),
            );
            const newPlanSignature = computePlanSignature(action.message);
            if (
              newPlanSignature &&
              filtered.some(
                (existing) => computePlanSignature(existing) === newPlanSignature,
              )
            ) {
              return conversation;
            }
            nextMessages = mergeAndSortMessages([...filtered, action.message]);
          }
          const unreadIncrement =
            conversation.localId === state.activeId || existingIndex >= 0
              ? 0
              : countNewUnreadConversationMessages(
                  conversation.messages,
                  nextMessages,
                  action.currentUserId,
                );
          return {
            ...conversation,
            messages: nextMessages,
            unreadCount: conversation.localId === state.activeId
              ? 0
              : conversation.unreadCount + unreadIncrement,
            runtimePreference: deriveRuntimePreferenceFromMessages(nextMessages),
          };
        }),
      };
    }
    default:
      return state;
  }
}
