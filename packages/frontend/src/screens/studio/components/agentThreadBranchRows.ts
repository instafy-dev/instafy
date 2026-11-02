import type { ConversationState } from "../../../conversations/ConversationsProvider";
import {
  aiFaceIdentityFromMetadata,
  aiFaceKey,
  withSavedAgentFace,
  type AiFaceIdentity,
  type SavedAgentFace,
} from "../../../utils/aiFace";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";
import { isGenericProgressLabel } from "./threadPreviewHelpers";

/** One AI in a thread, as its face resolves it (utils/aiFace.ts); the handle is normalized. */
export type AgentThreadBranchParticipant = AiFaceIdentity & { handle: string };

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

/**
 * The agent an AI wrote a message as. Only an assistant row speaks for an
 * AI: a person's own message can carry a client-supplied agent, and a
 * runtime alert a person raised is theirs (chatAssistantIdentity.ts).
 */
function stampedAgent(message: ChatMessage): AgentThreadBranchParticipant | null {
  if (message.role !== "assistant") {
    return null;
  }
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  if (messageType === "runtime_alert" && message.authorId?.trim()) {
    return null;
  }
  const identity = aiFaceIdentityFromMetadata(message.metadata);
  const handle = normalizeHandle(identity?.handle);
  return identity && handle ? { ...identity, handle } : null;
}

/** The id of the viewer's own saved agent with this (normalized) handle, if any. */
function savedAgentIdWithHandle(savedAgents: ReadonlyMap<string, SavedAgentFace>, handle: string): string | null {
  for (const [agentId, agent] of savedAgents) {
    if (normalizeHandle(agent.handle) === handle) {
      return agentId;
    }
  }
  return null;
}

function collectConversationParticipants(
  conversation: ConversationState,
  savedAgents: ReadonlyMap<string, SavedAgentFace>,
): AgentThreadBranchParticipant[] {
  // Faces come only from the agent stamped on a message, never from @words in
  // its text: a person's mention is written @handle too, and so is a package
  // such as @types/node, and the stack draws every participant as an AI tile.
  const stamps = conversation.messages.flatMap((message) => stampedAgent(message) ?? []);
  // One entry per AI, each drawn as the viewer's own saved agent's current
  // profile where it is one.
  const participants = new Map<string, AgentThreadBranchParticipant>();
  const addParticipant = (key: string, participant: AgentThreadBranchParticipant) => {
    if (!participants.has(key)) {
      participants.set(key, { ...withSavedAgentFace(participant, savedAgents), handle: participant.handle });
    }
  };

  // The owner goes first. The Studio names a thread's owner by its handle
  // alone ({ id: null, handle }), so the owner's id is the one its first row
  // with that handle carries. A row is the owner's when it carries the
  // owner's id or, carrying none, the owner's handle; the owner wears its
  // first such stamp. Until it has one it is known only by name: the viewer's
  // own saved agent with that handle, else the hollow face (docs/Brand.md,
  // "Octo's hatchlings"), unless it is Octo.
  const ownerHandle = normalizeHandle(conversation.ownerAgent?.handle);
  const ownerId =
    conversation.ownerAgent?.id?.trim() ||
    stamps.find((stamp) => stamp.handle === ownerHandle && stamp.agentId?.trim())?.agentId?.trim() ||
    null;
  const isOwnerStamp = (stamp: AgentThreadBranchParticipant) => {
    const stampId = stamp.agentId?.trim();
    return Boolean(ownerHandle) && (stampId ? stampId === ownerId : stamp.handle === ownerHandle);
  };
  if (ownerHandle) {
    const ownerStamp = stamps.find(isOwnerStamp);
    const savedOwnerId = ownerStamp || ownerId ? null : savedAgentIdWithHandle(savedAgents, ownerHandle);
    addParticipant("owner", ownerStamp
      ? { ...ownerStamp, agentId: ownerId ?? ownerStamp.agentId }
      : savedOwnerId
        ? { handle: ownerHandle, agentId: savedOwnerId }
        : { handle: ownerHandle, agentId: ownerId, textOnly: true });
  }
  // Everyone else by agent id, else by handle and seed, so two helpers that
  // share a handle but wear different faces stay two.
  for (const stamp of stamps) {
    if (!isOwnerStamp(stamp)) {
      addParticipant(aiFaceKey(stamp), stamp);
    }
  }

  return Array.from(participants.values());
}

export function buildAgentThreadBranchRows({
  message,
  conversations,
  savedAgents = new Map(),
}: {
  message: ChatMessage;
  conversations: ConversationState[];
  /** The viewer's own saved agents by id (ViewerAgentsContext). */
  savedAgents?: ReadonlyMap<string, SavedAgentFace>;
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
      participants: collectConversationParticipants(thread, savedAgents),
    });
  });

  return rows;
}
