import type { ChatMessage } from "../screens/studio/types";
import { isTimelineMessage } from "../conversations/conversationMessageUtils";

const INTERNAL_REPLY_PREFIXES = [
  "retrying:",
  "codex did not",
  "codex automation completed, but",
  "the codex reply produced no files",
];

function normalizeMessageType(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveMessageType(message: ChatMessage) {
  const direct = normalizeMessageType(message.messageType);
  if (direct) {
    return direct;
  }
  const metadata =
    message.metadata && typeof message.metadata === "object"
      ? (message.metadata as Record<string, unknown>)
      : null;
  return normalizeMessageType(metadata?.messageType) ?? normalizeMessageType(metadata?.message_type);
}

function firstNonEmptyString(values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function isInternalReplyFallbackText(content: string) {
  const normalized = content.trim().toLowerCase();
  return INTERNAL_REPLY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function resolveSpeechReplyPlaybackKey(
  message: Pick<ChatMessage, "id" | "metadata"> | null | undefined,
) {
  if (!message) {
    return null;
  }
  const metadata =
    message.metadata && typeof message.metadata === "object"
      ? (message.metadata as Record<string, unknown>)
      : null;
  return (
    firstNonEmptyString([
      metadata?.jobId,
      metadata?.job_id,
      metadata?.runId,
      metadata?.run_id,
    ]) ?? message.id
  );
}

export function isSpeakableAssistantReplyMessage(message: ChatMessage) {
  const messageType = resolveMessageType(message);
  return (
    message.role === "assistant" &&
    message.content.trim().length > 0 &&
    !isInternalReplyFallbackText(message.content) &&
    !isTimelineMessage(message) &&
    (messageType === null || messageType === "assistant")
  );
}

export function isDisplayableAssistantReplyMessage(message: ChatMessage) {
  return (
    message.role === "assistant" &&
    message.content.trim().length > 0 &&
    !isInternalReplyFallbackText(message.content) &&
    !isTimelineMessage(message)
  );
}

export function findLatestSpeakableAssistantReply(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isSpeakableAssistantReplyMessage(message)) {
      return message;
    }
  }
  return null;
}

export function findLatestDisplayableAssistantReply(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isDisplayableAssistantReplyMessage(message)) {
      return message;
    }
  }
  return null;
}

export function resolveSpeechReplyMessageForPlayback(
  latestAssistantMessage: ChatMessage | null | undefined,
  playbackFloorId: string | null | undefined,
) {
  if (!latestAssistantMessage) {
    return null;
  }
  if (latestAssistantMessage.id === playbackFloorId) {
    return null;
  }
  return {
    id: latestAssistantMessage.id,
    content: latestAssistantMessage.content,
    playbackKey: resolveSpeechReplyPlaybackKey(latestAssistantMessage),
  };
}
