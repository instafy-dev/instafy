import type { ChatMessage } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMessageType(message: ChatMessage): string {
  const direct = typeof message.messageType === "string" ? message.messageType.trim().toLowerCase() : "";
  if (direct) {
    return direct;
  }
  const metadata = message.metadata;
  if (!isRecord(metadata)) {
    return "";
  }
  const camel = typeof metadata["messageType"] === "string" ? metadata["messageType"].trim().toLowerCase() : "";
  if (camel) {
    return camel;
  }
  return typeof metadata["message_type"] === "string" ? metadata["message_type"].trim().toLowerCase() : "";
}

export function shouldSuppressOuterAvatarForConversationThread(message: ChatMessage): boolean {
  return normalizeMessageType(message) === "conversation_thread";
}
