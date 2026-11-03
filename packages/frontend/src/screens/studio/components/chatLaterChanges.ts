import { createContext, useContext } from "react";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";
import { extractAgentJobId } from "./chatMessagePresentation";

/**
 * Whether a turn after the one that wrote `messageId` changed any of `paths`
 * in this chat: the files a message's row lists, from a later turn's rows.
 * Undo of a change no save took puts its files back as the saved version has
 * them, which would also take back what that later turn did to them.
 *
 * `undone` says whether the person already undid `messageId`'s change: the
 * chat holds the line the controller records for an Undo (`change_undone`),
 * so the row shows the change as undone, with no Undo, after a reload too.
 */
export type ChatLaterChanges = ((messageId: string, paths: readonly string[]) => boolean) & {
  undone?: (messageId: string) => boolean;
};

/** The `kind` of the hidden line an Undo leaves in the chat (runtime-controller `change_undone.rs`). */
export const CHANGE_UNDONE_KIND = "change_undone";

/** The change an Undo's line names: the row's message and its run. Null for any other message. */
export function readChangeUndone(message: ChatMessage): { messageId: string; runId: string | null } | null {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (record.kind !== CHANGE_UNDONE_KIND) return null;
  const messageId = typeof record.undoneMessageId === "string" ? record.undoneMessageId.trim() : "";
  if (!messageId) return null;
  const runId = typeof record.undoneRunId === "string" ? record.undoneRunId.trim() : "";
  return { messageId, runId: runId || null };
}

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
  const undone = new Set<string>();
  for (const message of messages) {
    const line = readChangeUndone(message);
    if (line) undone.add(line.messageId);
  }
  const later: ChatLaterChanges = (messageId, paths) => {
    const own = turnOfMessage.get(messageId);
    if (!own) return false;
    const wanted = paths.map(normalizePath);
    return changes.some(
      (change) => change.turn !== own.turn && change.at > own.at && wanted.some((path) => change.paths.has(path)),
    );
  };
  later.undone = (messageId) => undone.has(messageId);
  return later;
}
