import { createContext, useContext } from "react";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";
import { extractAgentJobId } from "./chatMessagePresentation";
import { sitePreviewFromMessage } from "./sitePreviewRequest";

/**
 * The chat's site: a preview card in any of its turns. Files a turn changes
 * there are that site's, so the row under its reply says so ("Changed the
 * site"), whichever turn opened the card. Null in a chat with no site.
 */
export type ChatSite = {
  /**
   * When the chat's first change was made: the time of the newest files of
   * the turn that changed files first, as that turn's row under its reply has
   * it. Only that turn, or one that opened a card, made the site; any later
   * one changed it, also when every file it made is new. Null when no row has
   * files.
   */
  firstChangeAt: number | null;
};

export const ChatSiteContext = createContext<ChatSite | null>(null);

export function useChatSite(): ChatSite | null {
  return useContext(ChatSiteContext);
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

/** The chat's site, from its rows and the turns inside them; null when no row carries a site's preview card. */
export function conversationSite(messages: readonly ChatMessage[]): ChatSite | null {
  let hasSite = false;
  // Each turn's row shows the newest of its messages with files.
  const newestFilesByTurn = new Map<string, number>();
  const visit = (message: ChatMessage, turn: string) => {
    if (sitePreviewFromMessage(message) !== null) hasSite = true;
    if (!Array.isArray(message.files) || message.files.length === 0 || !Number.isFinite(message.timestamp)) return;
    newestFilesByTurn.set(turn, Math.max(newestFilesByTurn.get(turn) ?? -Infinity, message.timestamp));
  };
  for (const message of messages) {
    const thread = threadMessagesOf(message);
    if (thread.length > 0) {
      for (const threadMessage of thread) visit(threadMessage, message.id);
    } else {
      visit(message, extractAgentJobId(message) ?? `message:${message.id}`);
    }
  }
  if (!hasSite) return null;
  return { firstChangeAt: newestFilesByTurn.size > 0 ? Math.min(...newestFilesByTurn.values()) : null };
}
