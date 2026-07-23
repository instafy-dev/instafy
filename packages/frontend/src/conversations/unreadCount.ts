import type { ChatMessage } from "../screens/studio/types";
import { isTimelineMessage } from "./conversationMessageUtils";

export function isUnreadEligibleAssistantMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && !isTimelineMessage(message);
}

export function isUnreadEligibleConversationMessage(
  message: ChatMessage,
  currentUserId: string | null | undefined,
): boolean {
  if (isUnreadEligibleAssistantMessage(message)) {
    return true;
  }
  if (message.role !== "user") {
    return false;
  }

  const authorId = message.authorId?.trim() ?? "";
  const viewerId = currentUserId?.trim() ?? "";
  return authorId.length > 0 && viewerId.length > 0 && authorId !== viewerId;
}

function getUnreadMessageKey(message: ChatMessage): string {
  const id = typeof message.id === "string" ? message.id.trim() : "";
  if (id.length > 0) {
    return `id:${id}`;
  }
  return `fallback:${message.role}:${Math.floor(message.timestamp)}:${message.content.trim()}`;
}

function countNewUnreadMessages(
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
  isEligible: (message: ChatMessage) => boolean,
): number {
  const seen = new Set<string>();
  previousMessages.forEach((message) => {
    if (!isEligible(message)) {
      return;
    }
    seen.add(getUnreadMessageKey(message));
  });

  let added = 0;
  nextMessages.forEach((message) => {
    if (!isEligible(message)) {
      return;
    }
    const key = getUnreadMessageKey(message);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    added += 1;
  });

  return added;
}

export function countNewUnreadAssistantMessages(
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
): number {
  return countNewUnreadMessages(
    previousMessages,
    nextMessages,
    isUnreadEligibleAssistantMessage,
  );
}

export function countNewUnreadConversationMessages(
  previousMessages: ChatMessage[],
  nextMessages: ChatMessage[],
  currentUserId: string | null | undefined,
): number {
  return countNewUnreadMessages(previousMessages, nextMessages, (message) =>
    isUnreadEligibleConversationMessage(message, currentUserId),
  );
}
