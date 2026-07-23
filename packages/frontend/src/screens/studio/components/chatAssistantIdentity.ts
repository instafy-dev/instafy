import { getDefaultAssistantHandle } from "../../../assistants/localBuiltInAssistantCatalog";
import type { OctoMarkMotion } from "../../../components/OctoMark";
import type { ChatMessage } from "../types";
import { resolvePreviousAssistantHandleAcrossTurns } from "./assistantMessageGrouping";
import { getMessageType } from "./chatMessageMetadata";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type AssistantAgentIdentity = {
  handle: string;
  avatarSeed: string;
};

export type AssistantAvatarMotion = OctoMarkMotion;

export type AssistantAvatarRenderOptions = {
  motion?: AssistantAvatarMotion;
  scrollReactive?: boolean;
};

export type AssistantTypingAgent = AssistantAgentIdentity & {
  displayName: string;
  isThinking: boolean;
};

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
  const avatarSeedRaw = agent.avatarSeed;
  const avatarSeed =
    typeof avatarSeedRaw === "string" && avatarSeedRaw.trim().length > 0
      ? avatarSeedRaw.trim()
      : normalizedHandle;
  return { handle: normalizedHandle, avatarSeed };
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
