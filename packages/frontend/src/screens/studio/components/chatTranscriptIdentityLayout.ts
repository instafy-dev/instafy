import { getDefaultAssistantHandle } from "../../../assistants/localBuiltInAssistantCatalog";
import type { ConversationHumanPeerPresence } from "../../../conversations/groupParticipation";
import type { ChatMessage } from "../types";
import {
  extractAgentIdentityFromMetadata,
  extractRunIdFromMetadata,
  type AssistantAgentIdentity,
} from "./chatAssistantIdentity";
import { isCurrentUserChatMessage } from "./chatMessageDetailHelpers";
import { isBrowserNoticePrompt } from "./browserHandBack";
import { getMessageType } from "./chatMessageMetadata";

export type ChatTranscriptIdentityLayout = "solo" | "participants";

type IdentityLayoutInput = {
  currentUserId: string | null;
  chatClientSessionId: string | null;
  humanPeerContext: ConversationHumanPeerPresence | null | undefined;
  agentHandles: readonly string[];
  /** Complete conversation history, not a targeted message window or a recent page. */
  historyComplete: boolean;
  messages: readonly ChatMessage[];
  runAgentIdentityByRunId: ReadonlyMap<string, AssistantAgentIdentity>;
  /** Only runs belonging to this conversation, including active workers. */
  runMetadata: readonly (Record<string, unknown> | null)[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDefaultAssistant(identity: AssistantAgentIdentity, defaultHandle: string): boolean {
  // A saved/observed AI with an id is not proven to be the built-in Octo just
  // because its handle matches. Keep its face and exact profile attribution.
  return identity.handle === defaultHandle && !identity.id && identity.avatarSeed === defaultHandle;
}

function hasOtherOrUnknownAgent(metadata: Record<string, unknown> | null, defaultHandle: string): boolean {
  if (!metadata) return false;
  // Nested jobs and plans can contain helpers not represented by the current
  // conversation roster. Do not hide their identity based on the lead alone.
  if (metadata.multiAgentPlan || metadata.multi_agent_plan || metadata.threadMessages) return true;
  const identity = extractAgentIdentityFromMetadata(metadata);
  return metadata.agent != null && (!identity || !isDefaultAssistant(identity, defaultHandle));
}

/**
 * Reclaim the permanent avatar column only for a known one-human, built-in
 * assistant conversation. Online presence and the currently rendered rows
 * cannot establish that. Missing/partial history keeps participant identity;
 * compact pane layout still moves its avatars above the message body.
 */
export function resolveChatTranscriptIdentityLayout({
  currentUserId,
  chatClientSessionId,
  humanPeerContext,
  agentHandles,
  historyComplete,
  messages,
  runAgentIdentityByRunId,
  runMetadata,
}: IdentityLayoutInput): ChatTranscriptIdentityLayout {
  if (!currentUserId?.trim() || !humanPeerContext?.resolved || humanPeerContext.hasHumanPeer || !historyComplete) {
    return "participants";
  }
  const defaultHandle = getDefaultAssistantHandle();
  const handles = new Set(agentHandles.map(handle => handle.trim().toLowerCase()).filter(Boolean));
  if (handles.size !== 1 || !handles.has(defaultHandle)) return "participants";
  if (runMetadata.some(metadata => hasOtherOrUnknownAgent(metadata, defaultHandle))) return "participants";

  for (const message of messages) {
    // Browser continuations are neutral notices, not another human author.
    if (isBrowserNoticePrompt(message)) continue;
    if (message.role === "user" && !isCurrentUserChatMessage(message, currentUserId, chatClientSessionId)) {
      return "participants";
    }
    if (message.role !== "assistant") continue;
    // Raw plans can name helpers in their details before worker rows or run
    // metadata arrive. Their message kind alone makes solo unproven.
    const messageType = getMessageType(message);
    if (messageType === "multi_agent_plan" || messageType === "agent_job_thread") return "participants";
    const metadata = isRecord(message.metadata) ? message.metadata : null;
    if (hasOtherOrUnknownAgent(metadata, defaultHandle)) return "participants";
    const runId = extractRunIdFromMetadata(metadata);
    const runIdentity = runId ? runAgentIdentityByRunId.get(runId) : null;
    if (runId && !runIdentity && !extractAgentIdentityFromMetadata(metadata)) return "participants";
    if (runIdentity && !isDefaultAssistant(runIdentity, defaultHandle)) return "participants";
  }
  return "solo";
}
