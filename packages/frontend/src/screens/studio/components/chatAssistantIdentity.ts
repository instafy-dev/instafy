import {
  getBuiltInAssistantDisplayName,
  getDefaultAssistantHandle,
} from "../../../assistants/localBuiltInAssistantCatalog";
import type { OctoMarkMotion } from "../../../components/OctoMark";
import type { RunRecord } from "../../../types";
import { aiFaceKey } from "../../../utils/aiFace";
import type { ChatMessage } from "../types";
import { resolvePreviousAssistantHandleAcrossTurns } from "./assistantMessageGrouping";
import { getMessageType } from "./chatMessageMetadata";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type AssistantAgentIdentity = {
  id?: string;
  handle: string;
  avatarSeed: string;
};

export type AssistantAvatarMotion = OctoMarkMotion;

export type AssistantAvatarRenderOptions = {
  motion?: AssistantAvatarMotion;
  scrollReactive?: boolean;
};

export type AssistantTypingAgent = AssistantAgentIdentity & {
  /** The lane at work: its AI, and for a plan's helper its plan, so two plans' same-named helpers are two entries. */
  key?: string;
  displayName: string;
  isThinking: boolean;
};

/** Keep an observed agent ID when a display-only identity precedes its message/run metadata. */
export function resolveObservedAgentIdentity(
  ...identities: Array<AssistantAgentIdentity | null | undefined>
): AssistantAgentIdentity | null {
  const identity = identities.find((candidate) => candidate != null);
  if (!identity) return null;
  if (identity.id) return identity;
  const identified = identities.find((candidate) => candidate?.id && candidate.handle === identity.handle);
  return identified?.id ? { ...identity, id: identified.id } : identity;
}

export function extractAgentIdentityFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): AssistantAgentIdentity | null {
  if (!metadata || !isRecord(metadata)) {
    return null;
  }
  const agent = metadata.agent;
  if (!isRecord(agent)) {
    return null;
  }
  const handleRaw = agent.handle;
  const handleValue = typeof handleRaw === "string" ? handleRaw.trim() : "";
  if (!handleValue) {
    return null;
  }
  const withoutAt = handleValue.startsWith("@") ? handleValue.slice(1).trim() : handleValue;
  const normalizedHandle = withoutAt ? withoutAt.toLowerCase() : "";
  if (!normalizedHandle) {
    return null;
  }
  const id = typeof agent.id === "string" ? agent.id.trim() : "";
  // The seed stays as stamped, since a face stamp is read raw (utils/aiFace.ts),
  // and a row without one falls back the way the controller stamps a seed:
  // the agent id, else the handle. Every face of the row then agrees.
  const avatarSeedRaw = agent.avatarSeed;
  const avatarSeed =
    typeof avatarSeedRaw === "string" && avatarSeedRaw.trim().length > 0
      ? avatarSeedRaw
      : id || normalizedHandle;
  return { handle: normalizedHandle, avatarSeed, ...(id ? { id } : {}) };
}

/**
 * Whether two rows that share a handle were written by two AIs, as far as
 * their stamps tell: both carry an agent id and the ids differ (two members'
 * @pia), or neither carries one and their seeds differ (two plans'
 * @reviewer). Each then shows its own face. A row that names no agent, or
 * only one of two that carries an id, is taken for the same speaker.
 */
export function areDistinctAgents(
  a: AssistantAgentIdentity | null | undefined,
  b: AssistantAgentIdentity | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  if (a.id || b.id) {
    return Boolean(a.id && b.id) && a.id !== b.id;
  }
  return a.avatarSeed !== b.avatarSeed;
}

/**
 * Which of the viewer's saved agents an observed AI is: only the one with its
 * exact id, since another member's @pia is not the viewer's @pia. With nothing
 * observed (no run or row to go by), the conversation's primary agent, which
 * the viewer added, by its handle.
 */
export function resolveViewerAgentProfile<T>(
  identity: AssistantAgentIdentity | null,
  handle: string,
  viewerAgentById: ReadonlyMap<string, T>,
  viewerAgentByHandle: ReadonlyMap<string, T>,
): T | null {
  if (identity) {
    return identity.id ? viewerAgentById.get(identity.id) ?? null : null;
  }
  return viewerAgentByHandle.get(handle) ?? null;
}

/**
 * The typing row's entries: one per lane at work, each wearing the agent its
 * run is stamped with (docs/Brand.md, "Octo's hatchlings"). A saved agent is
 * drawn from the viewer's own profile only when it is the viewer's by id,
 * since another member's @pia is not the viewer's @pia. A lane is its AI
 * (agent id, else handle and seed) and, for a plan's helper, its plan: the
 * same-named helpers of two plans are two entries, whose one face the stack
 * folds into the count, while one lane's reruns stay one entry.
 */
export function resolveTypingAgentLanes(
  runs: readonly Pick<RunRecord, "id" | "status" | "metadata">[],
  viewerAgentById: ReadonlyMap<string, { avatarSeed: string; displayName: string | null }>,
): { agents: AssistantTypingAgent[]; agentByRunId: Map<string, AssistantTypingAgent> } {
  const agentByLane = new Map<string, AssistantTypingAgent>();
  const agentByRunId = new Map<string, AssistantTypingAgent>();
  for (const run of runs) {
    const metadata = isRecord(run.metadata) ? run.metadata : null;
    const identity = extractAgentIdentityFromMetadata(metadata);
    if (!identity) {
      continue;
    }
    const plan = metadata && isRecord(metadata.multiAgentPlan) ? metadata.multiAgentPlan : null;
    const groupId = typeof plan?.groupId === "string" ? plan.groupId.trim() : "";
    const key = [aiFaceKey({ handle: identity.handle, avatarSeed: identity.avatarSeed, agentId: identity.id }), groupId]
      .filter(Boolean)
      .join("|");
    let agent = agentByLane.get(key);
    if (agent) {
      agent.isThinking ||= run.status === "in_progress";
    } else {
      const profile = identity.id ? viewerAgentById.get(identity.id) ?? null : null;
      agent = {
        ...identity,
        key,
        avatarSeed: profile?.avatarSeed.trim() ? profile.avatarSeed : identity.avatarSeed,
        displayName:
          getBuiltInAssistantDisplayName(identity.handle) ??
          (profile?.displayName?.trim() ? profile.displayName.trim() : `@${identity.handle}`),
        isThinking: run.status === "in_progress",
      };
      agentByLane.set(key, agent);
    }
    agentByRunId.set(run.id, agent);
  }
  return { agents: [...agentByLane.values()], agentByRunId };
}

export function extractAgentHandleFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const identity = extractAgentIdentityFromMetadata(metadata);
  return identity?.handle ?? null;
}

export function extractRunIdFromMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || !isRecord(metadata)) {
    return null;
  }
  const directRunId = typeof metadata.runId === "string" ? metadata.runId.trim() : "";
  if (directRunId) {
    return directRunId;
  }
  const snakeRunId = typeof metadata.run_id === "string" ? metadata.run_id.trim() : "";
  if (snakeRunId) {
    return snakeRunId;
  }
  const details = metadata.details;
  if (!isRecord(details)) {
    return null;
  }
  const detailsRunId = typeof details.runId === "string" ? details.runId.trim() : "";
  if (detailsRunId) {
    return detailsRunId;
  }
  const detailsSnakeRunId = typeof details.run_id === "string" ? details.run_id.trim() : "";
  if (detailsSnakeRunId) {
    return detailsSnakeRunId;
  }
  return null;
}

export function resolveAssistantHandleForMessage(
  message: ChatMessage | null | undefined,
  runAgentHandleByRunId?: Map<string, string>,
): string | null {
  if (!message || message.role !== "assistant") {
    return null;
  }
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  if (messageType === "agent_job_thread" || messageType === "run_cancellation") {
    return null;
  }
  if (
    messageType === "runtime_alert" &&
    typeof message.authorId === "string" &&
    message.authorId.trim().length > 0
  ) {
    return null;
  }
  const metadata =
    message.metadata && isRecord(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : null;
  const metadataHandle = extractAgentHandleFromMetadata(metadata);
  if (metadataHandle) {
    return metadataHandle;
  }
  const runId = extractRunIdFromMetadata(metadata);
  if (runId) {
    const runHandle = runAgentHandleByRunId?.get(runId) ?? null;
    if (runHandle) {
      return runHandle;
    }
  }
  if (messageType === "runtime_alert") {
    return null;
  }
  return getDefaultAssistantHandle();
}

export function resolvePreviousAssistantHandle(
  messages: ChatMessage[],
  index: number,
  runAgentHandleByRunId?: Map<string, string>,
): string | null {
  return resolvePreviousAssistantHandleAcrossTurns(
    messages,
    index,
    (candidate) => resolveAssistantHandleForMessage(candidate, runAgentHandleByRunId),
  );
}

export function shouldShowAssistantIdentityForMessage(
  message: ChatMessage,
  previousAssistantHandle: string | null,
  runAgentHandleByRunId?: Map<string, string>,
): boolean {
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  if (messageType === "run_cancellation") {
    return false;
  }
  if (messageType === "runtime_alert") {
    return resolveAssistantHandleForMessage(message, runAgentHandleByRunId) !== null;
  }
  const currentHandle =
    resolveAssistantHandleForMessage(message, runAgentHandleByRunId) ?? getDefaultAssistantHandle();
  if (!previousAssistantHandle) {
    return true;
  }
  return currentHandle !== previousAssistantHandle;
}

export function shouldShowAssistantAvatarForMessage(
  message: ChatMessage,
  runAgentHandleByRunId?: Map<string, string>,
): boolean {
  const messageType = (getMessageType(message) ?? "").trim().toLowerCase();
  if (
    messageType === "agent_job_thread" ||
    messageType === "run_cancellation"
  ) {
    return false;
  }
  if (messageType === "runtime_alert") {
    return resolveAssistantHandleForMessage(message, runAgentHandleByRunId) !== null;
  }
  return true;
}
