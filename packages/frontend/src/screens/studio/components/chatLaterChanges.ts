import { createContext, useContext } from "react";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";
import { extractAgentJobId } from "./chatMessagePresentation";

/**
 * Whether a turn after the one that wrote `messageId` changed any of `paths`
 * in this chat: the files a message's row lists, from a later turn's rows.
 * Undo of a change no save took puts its files back as the saved version has
 * them, which would also take back what that later turn did to them.
 */
export type ChatLaterChanges = (messageId: string, paths: readonly string[]) => boolean;

export const ChatLaterChangesContext = createContext<ChatLaterChanges | null>(null);

export function useChatLaterChanges(): ChatLaterChanges | null {
  return useContext(ChatLaterChangesContext);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "").trim();
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

type FilesOfTurn = { turn: string; at: number; paths: ReadonlySet<string> };

/**
 * The chat's changes by turn, from its rows and the turns inside them: a
 * turn is its job, else its row.
 */
export function conversationLaterChanges(messages: readonly ChatMessage[]): ChatLaterChanges {
  const changes: FilesOfTurn[] = [];
  const turnOfMessage = new Map<string, { turn: string; at: number }>();
  const visit = (message: ChatMessage, turn: string) => {
    turnOfMessage.set(message.id, { turn, at: message.timestamp });
    if (!Array.isArray(message.files) || message.files.length === 0 || !Number.isFinite(message.timestamp)) return;
    const paths = new Set(
      message.files
        .map((file) => normalizePath(file.workspacePath || file.path || ""))
        .filter((path) => path.length > 0),
    );
    if (paths.size > 0) changes.push({ turn, at: message.timestamp, paths });
  };
  for (const message of messages) {
    const thread = threadMessagesOf(message);
    const rowTurn = extractAgentJobId(message) ?? `message:${message.id}`;
    if (thread.length > 0) {
      turnOfMessage.set(message.id, { turn: rowTurn, at: message.timestamp });
      for (const threadMessage of thread) visit(threadMessage, extractAgentJobId(threadMessage) ?? rowTurn);
    } else {
      visit(message, rowTurn);
    }
  }
  return (messageId, paths) => {
    const own = turnOfMessage.get(messageId);
    if (!own) return false;
    const wanted = paths.map(normalizePath);
    return changes.some(
      (change) => change.turn !== own.turn && change.at > own.at && wanted.some((path) => change.paths.has(path)),
    );
  };
}
