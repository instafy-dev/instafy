import { getDefaultAssistantHandle } from "../../../assistants/localBuiltInAssistantCatalog";
import type { ConversationHumanPeerPresence } from "../../../conversations/groupParticipation";
import { resolveAiFace } from "../../../utils/aiFace";
import type { ChatMessage } from "../types";
import {
  extractAgentIdentityFromMetadata,
  extractRunIdFromMetadata,
  type AssistantAgentIdentity,
} from "./chatAssistantIdentity";
import { isCurrentUserChatMessage } from "./chatMessageDetailHelpers";
import { isBrowserNoticePrompt } from "./browserHandBack";
import { getMessageType } from "./chatMessageMetadata";
import type { ConversationRosterAgent } from "./conversationRosterMembers";

export type ChatTranscriptIdentityLayout = "solo" | "participants";

type IdentityLayoutInput = {
  currentUserId: string | null;
  chatClientSessionId: string | null;
  humanPeerContext: ConversationHumanPeerPresence | null | undefined;
  /** The chat's AIs as its participant rail lists them (resolveConversationRosterAgents). */
  rosterAgents: readonly Pick<ConversationRosterAgent, "handle" | "agentId" | "avatarSeed">[];
  /**
   * The conversation's newest history is in: its first page loaded without an
   * error, and it is not a targeted message window or a job thread. Older pages
   * may still be on the server.
   */
  historyLoaded: boolean;
  messages: readonly ChatMessage[];
  runAgentIdentityByRunId: ReadonlyMap<string, AssistantAgentIdentity>;
  /** Only runs belonging to this conversation, including active workers. */
  runMetadata: readonly (Record<string, unknown> | null)[];
};

/** The rail's Octo: the viewer's own saved Octo by id, once the rail has loaded it. */
type RailOcto = { id: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Octo's own tile, no picture and no hatchling: the face the solo typing row
 * keeps beside its status, as ChatTypingRows decides it.
 */
function wearsOctoTile(handle: string, avatarSeed: string | null | undefined): boolean {
  return resolveAiFace({ handle, avatarSeed }).kind === "octo";
}

/**
 * The rail lists one AI, Octo, wearing its own tile. The rail draws Octo from
 * the viewer's own saved Octo (the controller keeps one per person and answers
 * that person with it), so its id is the one the viewer's replies carry. Before
 * the viewer's agents load the rail knows Octo by handle alone, with no id.
 */
function resolveRailOcto(
  rosterAgents: IdentityLayoutInput["rosterAgents"],
  defaultHandle: string,
): RailOcto | null {
  const handles = new Set(rosterAgents.map(agent => agent.handle.trim().toLowerCase()).filter(Boolean));
  if (handles.size !== 1 || !handles.has(defaultHandle)) return null;
  const ids = new Set<string>();
  for (const agent of rosterAgents) {
    if (agent.handle.trim().toLowerCase() !== defaultHandle) continue;
    if (!wearsOctoTile(defaultHandle, agent.avatarSeed)) return null;
    const id = agent.agentId?.trim();
    if (id) ids.add(id);
  }
  return ids.size > 1 ? null : { id: [...ids][0] ?? null };
}

/**
 * A stamp without an id is the built-in Octo only with Octo's handle and seed.
 * A stamp with an id is the rail's Octo only by that exact id: a matching
 * handle proves nothing, since another member's Octo has the same handle and
 * an id of its own. The chat draws the viewer's own agents from their current
 * profile (ViewerAgentsContext), the one the rail shows, so such a row wears
 * the rail's face whatever seed it was stamped with.
 */
function isRailOcto(identity: AssistantAgentIdentity, railOcto: RailOcto, defaultHandle: string): boolean {
  if (identity.handle !== defaultHandle) return false;
  return identity.id ? identity.id === railOcto.id : identity.avatarSeed === defaultHandle;
}

function hasOtherOrUnknownAgent(
  metadata: Record<string, unknown> | null,
  isChatOcto: (identity: AssistantAgentIdentity) => boolean,
): boolean {
  if (!metadata) return false;
  // Nested jobs and plans can contain helpers not represented by the current
  // conversation roster. Do not hide their identity based on the lead alone.
  if (metadata.multiAgentPlan || metadata.multi_agent_plan || metadata.threadMessages) return true;
  const identity = extractAgentIdentityFromMetadata(metadata);
  return metadata.agent != null && (!identity || !isChatOcto(identity));
}

/**
 * Reclaim the permanent avatar column only for a known conversation between
 * one person and their Octo. Online presence and the rendered rows cannot
 * establish that; the members do: no other human can see the conversation, and
 * its rail lists only the viewer's Octo. Every loaded row and run must agree.
 * Older pages still on the server need not: they fill with hidden progress rows
 * (reasoning, token usage), so waiting for all of them kept any chat of more
 * than a few turns in the participants layout. When an older page loads with
 * another author, this returns participants from then on. Compact pane layout
 * still moves its avatars above the message body.
 */
export function resolveChatTranscriptIdentityLayout({
  currentUserId,
  chatClientSessionId,
  humanPeerContext,
  rosterAgents,
  historyLoaded,
  messages,
  runAgentIdentityByRunId,
  runMetadata,
}: IdentityLayoutInput): ChatTranscriptIdentityLayout {
  if (!currentUserId?.trim() || !humanPeerContext?.resolved || humanPeerContext.hasHumanPeer || !historyLoaded) {
    return "participants";
  }
  const defaultHandle = getDefaultAssistantHandle();
  const railOcto = resolveRailOcto(rosterAgents, defaultHandle);
  if (!railOcto) return "participants";
  const isChatOcto = (identity: AssistantAgentIdentity) => isRailOcto(identity, railOcto, defaultHandle);
  if (runMetadata.some(metadata => hasOtherOrUnknownAgent(metadata, isChatOcto))) return "participants";

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
    if (hasOtherOrUnknownAgent(metadata, isChatOcto)) return "participants";
    const runId = extractRunIdFromMetadata(metadata);
    const runIdentity = runId ? runAgentIdentityByRunId.get(runId) : null;
    if (runId && !runIdentity && !extractAgentIdentityFromMetadata(metadata)) return "participants";
    if (runIdentity && !isChatOcto(runIdentity)) return "participants";
  }
  return "solo";
}
