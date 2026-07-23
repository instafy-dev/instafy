import type { ControllerConversationParticipationResult } from "../services/runtimeController/conversations";
import type { ChatMessage } from "../screens/studio/types";
import { isTimelineMessage } from "./conversationMessageUtils";
import type { ResolvedPromptAgentSelection } from "./assistantMentions";

export const GROUP_PARTICIPATION_POLICY_SKILL_PATH =
  ".agents/skills/instafy-group-participation/SKILL.md";

/**
 * The client's view of whether any other human can see this conversation
 * (participants plus, for public conversations, project and org members).
 * `resolved: false` means the directories are still loading or errored.
 */
export type ConversationHumanPeerPresence = {
  hasHumanPeer: boolean;
  resolved: boolean;
};

export type ConversationGroupParticipationPreflightInput = {
  conversationId: string | null;
  displayPrompt: string;
  dispatchPrompt: string;
  metadata: Record<string, unknown> | null;
  agentSelection: ResolvedPromptAgentSelection;
  hasTerminalCommand: boolean;
  hasBrowserTask: boolean;
  humanPeerContext?: ConversationHumanPeerPresence | null;
};

export type ConversationGroupParticipationPreflightResult = {
  mode:
    | "unchanged"
    | "dispatch"
    | "record_only"
    | "controller_deferred"
    | "controller_coverage";
  metadata: Record<string, unknown> | null;
};

export type GroupParticipationPreflightStatus =
  | "resolved"
  | "unsupported"
  | "bypassed"
  | "single_human"
  | "controller_deferred"
  | "controller_coverage";

export type AmbientGroupParticipationEligibility = {
  assistantEnabled: boolean;
  usesDefaultAssistantOnly: boolean;
  activeHandles: readonly string[];
  targetHandles: readonly string[];
  explicitMentionedHandles: readonly string[];
  defaultAssistantHandle: string;
  threadKind: string | null | undefined;
  ownerAgentHandle: string | null | undefined;
  hasTerminalCommand: boolean;
  hasBrowserTask: boolean;
  hasExplicitAssistantOverride: boolean;
  replyToOcto: boolean;
  isAmbientTurn: boolean;
};

/**
 * The participation skill only arbitrates ambient Octo turns in a shared
 * conversation. Explicit requests and custom-agent turns retain the existing
 * immediate dispatch path.
 */
export function shouldResolveAmbientGroupParticipation(
  input: AmbientGroupParticipationEligibility,
): boolean {
  if (
    !input.isAmbientTurn ||
    !input.assistantEnabled ||
    !input.usesDefaultAssistantOnly ||
    input.hasTerminalCommand ||
    input.hasBrowserTask ||
    input.hasExplicitAssistantOverride ||
    input.replyToOcto ||
    input.explicitMentionedHandles.length > 0 ||
    input.threadKind === "agent" ||
    Boolean(input.ownerAgentHandle)
  ) {
    return false;
  }

  return (
    input.activeHandles.length === 1 &&
    input.activeHandles[0] === input.defaultAssistantHandle &&
    input.targetHandles.length === 1 &&
    input.targetHandles[0] === input.defaultAssistantHandle
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function withGroupParticipationPreflightMetadata(
  metadata: Record<string, unknown> | null | undefined,
  status: GroupParticipationPreflightStatus,
  groupParticipation?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    ...(groupParticipation ? { groupParticipation } : {}),
    groupParticipationPreflight: { status },
  };
}

export function readGroupParticipationPreflightStatus(
  metadata: Record<string, unknown> | null | undefined,
): GroupParticipationPreflightStatus | null {
  const preflight = readRecord(metadata?.groupParticipationPreflight);
  return preflight?.status === "resolved" ||
    preflight?.status === "unsupported" ||
    preflight?.status === "bypassed" ||
    preflight?.status === "single_human" ||
    preflight?.status === "controller_deferred" ||
    preflight?.status === "controller_coverage"
    ? preflight.status
    : null;
}

export function readGroupParticipationDecision(
  metadata: Record<string, unknown> | null | undefined,
): "respond" | "claim" | "correct" | "silent" | null {
  const participation = readRecord(metadata?.groupParticipation);
  const decision = participation?.decision;
  return decision === "respond" ||
    decision === "claim" ||
    decision === "correct" ||
    decision === "silent"
    ? decision
    : null;
}

export const SKILL_MODE_AMBIENT_PARTICIPATION_REASON = "skill_mode_ambient";

export type GroupParticipationAgentEvaluation = {
  reason: string | null;
  enforcedBy: string | null;
};

/**
 * Skill-mode ambient dispatches carry a server-stamped
 * `groupParticipation.decision === "agent_evaluation"` marker on the run so
 * downstream surfaces (typing/presence, billing, sentinel handling) can
 * recognize agent-arbitrated turns. Direct turns (@octo, reply-to-Octo,
 * Ask-Octo) never carry the marker.
 */
export function readGroupParticipationAgentEvaluation(
  metadata: Record<string, unknown> | null | undefined,
): GroupParticipationAgentEvaluation | null {
  const participation = readRecord(metadata?.groupParticipation);
  if (participation?.decision !== "agent_evaluation") {
    return null;
  }
  return {
    reason:
      typeof participation.reason === "string" ? participation.reason : null,
    enforcedBy:
      typeof participation.enforcedBy === "string"
        ? participation.enforcedBy
        : null,
  };
}

/**
 * Detects an ambient skill-mode dispatch from the submitter's own prompt
 * metadata, before the server-stamped run record arrives. The participation
 * resolver answers these turns with decision "respond" and reason
 * "skill_mode_ambient"; the controller then stamps decision "agent_evaluation"
 * on the run itself.
 */
export function isSkillModeAmbientDispatchMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (readGroupParticipationAgentEvaluation(metadata)) {
    return true;
  }
  const participation = readRecord(metadata?.groupParticipation);
  return (
    participation?.decision === "respond" &&
    participation.reason === SKILL_MODE_AMBIENT_PARTICIPATION_REASON
  );
}

function readMessageRunId(message: ChatMessage): string | null {
  const metadata = readRecord(message.metadata);
  const raw = metadata?.runId ?? metadata?.run_id;
  const runId = typeof raw === "string" ? raw.trim() : "";
  return runId ? runId : null;
}

function resolveAssistantMessageType(message: ChatMessage): string {
  const metadata = readRecord(message.metadata);
  const raw = message.messageType ?? metadata?.messageType ?? metadata?.message_type;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Assistant-role rows that are system notices rather than Octo speaking. */
const NON_ACTOR_ASSISTANT_MESSAGE_TYPES = new Set([
  "agent_job_thread",
  "run_cancellation",
  "runtime_alert",
  "runtime_switch",
]);

/** True once the run has begun streaming a conversational assistant bubble. */
export function hasVisibleAssistantMessageForRun(
  messages: readonly ChatMessage[],
  runId: string,
): boolean {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return false;
  }
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      !isTimelineMessage(message) &&
      !NON_ACTOR_ASSISTANT_MESSAGE_TYPES.has(resolveAssistantMessageType(message)) &&
      readMessageRunId(message) === normalizedRunId,
  );
}

/**
 * Skill-mode ambient runs are silent-until-speaking: no typing indicator or
 * "starting workspace/thinking" activity row for ANY viewer (including the
 * sender) until a visible assistant bubble for the run exists. Direct turns
 * never carry the agent_evaluation marker (server-stamped on the run) or the
 * submitter-local mark, so they keep full presence.
 */
export function shouldSuppressAgentEvaluationRunPresence(params: {
  runId: string;
  /** Omit/null while the run record has not arrived (awaiting lease). */
  runMetadata?: Record<string, unknown> | null;
  /** Submitter-local marks covering the awaiting-lease window. */
  pendingAgentEvaluationRunIds?: ReadonlySet<string> | null;
  messages: readonly ChatMessage[];
}): boolean {
  const markedByRun =
    readGroupParticipationAgentEvaluation(params.runMetadata ?? null) !== null;
  const markedLocally =
    params.pendingAgentEvaluationRunIds?.has(params.runId) ?? false;
  if (!markedByRun && !markedLocally) {
    return false;
  }
  return !hasVisibleAssistantMessageForRun(params.messages, params.runId);
}

const MAX_TRACKED_AGENT_EVALUATION_RUN_IDS = 200;

/**
 * Session-local, bounded mark set for the submitter's own skill-mode ambient
 * dispatches. Insertion order doubles as eviction order once the cap is hit;
 * after a reload the server-stamped run metadata is the authority instead.
 */
export function markPendingAgentEvaluationRun(
  runIds: Set<string>,
  runId: string,
): void {
  runIds.add(runId);
  if (runIds.size > MAX_TRACKED_AGENT_EVALUATION_RUN_IDS) {
    const oldest = runIds.values().next().value;
    if (typeof oldest === "string") {
      runIds.delete(oldest);
    }
  }
}

export type GroupParticipationReplyTargets = {
  replyToOcto: boolean;
  replyToHuman: boolean;
};

/** Resolve a selection reply against its source instead of treating every quote as directed to Octo. */
export function resolveGroupParticipationReplyTargets(
  metadata: Record<string, unknown> | null | undefined,
  messages: readonly ChatMessage[],
  defaultAssistantHandle: string,
): GroupParticipationReplyTargets {
  const replyContext = readRecord(metadata?.replyContext ?? metadata?.reply_context);
  if (!replyContext) {
    return { replyToOcto: false, replyToHuman: false };
  }
  const rawMessageId = replyContext.messageId ?? replyContext.message_id;
  const messageId = typeof rawMessageId === "string" ? rawMessageId.trim() : "";
  if (!messageId) {
    return { replyToOcto: false, replyToHuman: false };
  }
  const sourceMessage = messages.find((message) => message.id === messageId) ?? null;
  if (sourceMessage?.role === "assistant") {
    const sourceMetadata = readRecord(sourceMessage.metadata);
    const messageType = resolveAssistantMessageType(sourceMessage);
    if (NON_ACTOR_ASSISTANT_MESSAGE_TYPES.has(messageType)) {
      return { replyToOcto: false, replyToHuman: false };
    }

    const agent = readRecord(sourceMetadata?.agent);
    const agentHandleRaw = agent?.handle;
    if (typeof agentHandleRaw === "string" && agentHandleRaw.trim()) {
      const agentHandle = agentHandleRaw.trim().replace(/^@/, "").toLowerCase();
      const defaultHandle = defaultAssistantHandle.trim().replace(/^@/, "").toLowerCase();
      return {
        replyToOcto: agentHandle === defaultHandle,
        replyToHuman: false,
      };
    }
  }
  return {
    replyToOcto: sourceMessage?.role === "assistant",
    replyToHuman: sourceMessage?.role === "user",
  };
}

export function buildGroupParticipationMetadata(
  result: ControllerConversationParticipationResult,
): Record<string, unknown> {
  return {
    decision: result.decision,
    domain: result.domain,
    reason: result.reason,
    confidence: result.confidence,
    participantCount: result.participantCount,
    policySkillPath: result.policySkillPath,
    ...(result.targetMessageId
      ? { targetMessageId: result.targetMessageId }
      : {}),
    ...(result.coveredRunId ? { coveredRunId: result.coveredRunId } : {}),
    ...(result.coveredJobId ? { coveredJobId: result.coveredJobId } : {}),
    ...(result.coverage ? { coverage: result.coverage } : {}),
  };
}

export function buildUnavailableGroupParticipationMetadata(): Record<string, unknown> {
  return {
    decision: "silent",
    domain: "ambiguous",
    reason: "participation_resolver_unavailable",
    confidence: 0,
    policySkillPath: GROUP_PARTICIPATION_POLICY_SKILL_PATH,
  };
}
