import type { ConversationState } from "../../../conversations/ConversationsProvider";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";
import { isGenericProgressLabel } from "./threadPreviewHelpers";

export type AgentThreadBranchParticipant = {
  handle: string;
  avatarSeed?: string | null;
  avatarUrl?: string | null;
};

export type AgentThreadBranchRow = {
  threadLocalId: string;
  title: string;
  hiddenActivityCount: number;
  isRunning: boolean;
  participants: AgentThreadBranchParticipant[];
};

type ThreadReference = {
  targetId: string;
  label: string | null;
};

const THREAD_REFERENCE_REGEX = /\[\[thread:([^\]|]+)(?:\|([^\]]*))?\]\]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHandle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/^@+/, "").trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function extractThreadMessages(message: ChatMessage): ChatMessage[] {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const threadMessages = metadata?.threadMessages;
  return Array.isArray(threadMessages) ? (threadMessages as ChatMessage[]) : [];
}

export function extractThreadReferencesFromText(text: string): ThreadReference[] {
  const references: ThreadReference[] = [];
  THREAD_REFERENCE_REGEX.lastIndex = 0;
  for (const match of text.matchAll(THREAD_REFERENCE_REGEX)) {
    const targetId = (match[1] ?? "").trim();
    if (!targetId) {
      continue;
    }
    const label = (match[2] ?? "").trim();
    references.push({
      targetId,
      label: label || null,
    });
  }
  return references;
}

export function collectReferencedThreadTargets(messages: ChatMessage[]): Set<string> {
  const targets = new Set<string>();
  messages.forEach((message) => {
    const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
    const sources = messageType === "agent_job_thread" ? [message, ...extractThreadMessages(message)] : [message];
    sources.forEach((source) => {
      extractThreadReferencesFromText(source.content ?? "").forEach((reference) => {
        targets.add(reference.targetId);
      });
    });
  });
  return targets;
}

export function conversationMatchesThreadTarget(
  conversation: ConversationState,
  target: string,
): boolean {
  const trimmed = target.trim();
  if (!trimmed) {
    return false;
  }
  return conversation.localId === trimmed || conversation.controllerId === trimmed;
}

function countConversationActivity(messages: ChatMessage[]): number {
  return messages.filter((message) => {
    const content = message.content.trim();
    if (!content) {
      return false;
    }
    const type = (getMessageType(message) ?? "").trim().toLowerCase();
    if (!type) {
      return !isGenericProgressLabel(content);
    }
    return ![
      "command_execution",
      "mcp_tool_call",
      "reasoning",
      "status",
      "token_usage",
      "runtime_switch",
      "web_search",
    ].includes(type);
  }).length;
}

export function shouldHideStandaloneConversationThreadPreview({
  thread,
  preview,
  referencedThreadTargets,
}: {
  thread: ConversationState;
  preview: ChatMessage;
  referencedThreadTargets: ReadonlySet<string>;
}): boolean {
  const messageType = (getMessageType(preview) ?? "").trim().toLowerCase();
  if (messageType !== "conversation_thread") {
    return false;
  }
  if (countConversationActivity(thread.messages) === 0) {
    return true;
  }
  for (const target of referencedThreadTargets) {
    if (conversationMatchesThreadTarget(thread, target)) {
      return true;
    }
  }
  return false;
}

function addParticipant(
  participants: Map<string, AgentThreadBranchParticipant>,
  handle: unknown,
  options: { avatarSeed?: string | null; avatarUrl?: string | null } = {},
) {
  const normalized = normalizeHandle(handle);
  if (!normalized || participants.has(normalized)) {
    return;
  }
  participants.set(normalized, {
    handle: normalized,
    avatarSeed: options.avatarSeed ?? normalized,
    avatarUrl: options.avatarUrl ?? null,
  });
}

function collectConversationParticipants(conversation: ConversationState): AgentThreadBranchParticipant[] {
  const participants = new Map<string, AgentThreadBranchParticipant>();
  addParticipant(participants, conversation.ownerAgent?.handle);

  conversation.messages.forEach((message) => {
    const metadata = isRecord(message.metadata) ? message.metadata : null;
    const agent = metadata && isRecord(metadata.agent) ? metadata.agent : null;
    addParticipant(participants, agent?.handle, {
      avatarSeed: typeof agent?.avatarSeed === "string" ? agent.avatarSeed : null,
      avatarUrl: typeof agent?.avatarUrl === "string" ? agent.avatarUrl : null,
    });
    for (const match of message.content.matchAll(/@([a-z0-9][a-z0-9_-]{0,19})/gi)) {
      addParticipant(participants, match[1]);
    }
  });

  return Array.from(participants.values());
}

export function buildAgentThreadBranchRows({
  message,
  conversations,
}: {
  message: ChatMessage;
  conversations: ConversationState[];
}): AgentThreadBranchRow[] {
  const sources = [message, ...extractThreadMessages(message)];
  const references = sources.flatMap((source) => extractThreadReferencesFromText(source.content ?? ""));
  const rows: AgentThreadBranchRow[] = [];
  const seenLocalIds = new Set<string>();

  references.forEach((reference) => {
    const thread = conversations.find((candidate) => conversationMatchesThreadTarget(candidate, reference.targetId));
    if (!thread || seenLocalIds.has(thread.localId)) {
      return;
    }
    seenLocalIds.add(thread.localId);
    const title = reference.label?.trim() || thread.title.trim() || "Thread";
    rows.push({
      threadLocalId: thread.localId,
      title,
      hiddenActivityCount: countConversationActivity(thread.messages),
      isRunning: (thread.pendingRunIds?.length ?? 0) > 0 || (thread.awaitingLeaseRunIds?.length ?? 0) > 0,
      participants: collectConversationParticipants(thread),
    });
  });

  return rows;
}
