import { createContext, useContext } from "react";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";
import { sitePreviewFromMessage } from "./sitePreviewRequest";

/**
 * Whether the chat has a site: a preview card in any of its turns. Files a
 * turn changes there are that site's, so the row under its reply says so
 * ("Changed the site"), whichever turn opened the card.
 */
export const ChatHasSiteContext = createContext(false);

export function useChatHasSite(): boolean {
  return useContext(ChatHasSiteContext);
}

function threadMessagesOf(message: ChatMessage): readonly ChatMessage[] {
  if ((getMessageType(message) ?? "").trim().toLowerCase() !== "agent_job_thread") {
    return [];
  }
  const metadata = message.metadata;
  const threadMessages =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).threadMessages
      : null;
  return Array.isArray(threadMessages) ? (threadMessages as ChatMessage[]) : [];
}

/** Whether any row of the chat, or any turn inside one, carries a site's preview card. */
export function conversationHasSite(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      sitePreviewFromMessage(message) !== null ||
      threadMessagesOf(message).some((threadMessage) => sitePreviewFromMessage(threadMessage) !== null),
  );
}
