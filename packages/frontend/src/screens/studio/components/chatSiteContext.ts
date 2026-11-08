import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";
import { getMessageType } from "./chatMessageMetadata";
import { extractAgentJobId } from "./chatMessagePresentation";
import { sitePreviewFromMessage } from "./sitePreviewRequest";

/**
 * The chat's site: a preview card in any of its turns. Files a turn changes
 * there are that site's, so the row under its reply says so ("Changed the
 * site", or the page by its title), whichever turn opened the card. Null in a
 * chat with no site.
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
  /**
   * The title of each page this chat opened a card for, by its folder's name
   * (`sites/<name>/`): the card of the turn whose files are that page's, or
   * the chat's one card when all its pages' files are one page's.
   */
  pageTitles: ReadonlyMap<string, string>;
};

/**
 * The chat's site, null when it has none, and undefined while the chat's
 * history is still coming in: a card may yet arrive, so a row that would name
 * its page by it waits, and never reads one name, then another.
 */
export const ChatSiteContext = createContext<ChatSite | null | undefined>(null);

export function useChatSite(): ChatSite | null | undefined {
  return useContext(ChatSiteContext);
}

/**
 * The longest a turn's files row waits for the chat's history before it shows
 * anyway: a history that never comes in must not keep the files, and their
 * Undo, away.
 */
export const CHAT_HISTORY_WAIT_MS = 3_000;

/**
 * Whether a chat's history is in for its rows, which name pages by its cards:
 * its newest page has come, and no older page is on its way by itself to fill
 * the window, as one may hold the card that names a row's page. An older page
 * the person scrolls up for never holds the rows back.
 */
export function chatHistoryIn({ newestPage, olderPageOnItsWay }: { newestPage: boolean; olderPageOnItsWay: boolean }): boolean {
  return newestPage && !olderPageOnItsWay;
}

/**
 * The chat's site to give its rows: undefined until the chat's history has
 * come in ({@link chatHistoryIn}), at most {@link CHAT_HISTORY_WAIT_MS} for
 * each chat. Once its rows have shown, they never wait again.
 */
export function useKnownChatSite(site: ChatSite | null, historyReady: boolean, chatKey: string | null): ChatSite | null | undefined {
  // The chat whose rows have shown with its history in: kept without a render
  // of its own, which would draw every row again.
  const shownFor = useRef<{ chatKey: string | null } | null>(null);
  // The chat whose history the rows stopped waiting for.
  const [waitedOut, setWaitedOut] = useState<{ chatKey: string | null } | null>(null);
  useEffect(() => {
    if (historyReady) shownFor.current = { chatKey };
  }, [chatKey, historyReady]);
  const settled = shownFor.current?.chatKey === chatKey || waitedOut?.chatKey === chatKey;
  useEffect(() => {
    if (historyReady || settled) return;
    const timer = window.setTimeout(() => setWaitedOut({ chatKey }), CHAT_HISTORY_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [chatKey, historyReady, settled]);
  return historyReady || settled ? site : undefined;
}

/** The page a file is in, by its folder's name, when it is in one (`sites/<name>/…`, where the space's pages are made). */
export function pageFolderOf(workspacePath: string): string | null {
  const [top, name, ...inside] = workspacePath.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/");
  return top === "sites" && name && inside.length > 0 ? name : null;
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
  const cardTitles = new Set<string>();
  // Each turn's row shows the newest of its messages with files.
  const newestFilesByTurn = new Map<string, number>();
  // Each turn's card title, and the page its files are all in (null when they are not one page's), oldest first.
  const turns = new Map<string, { title: string | null; folder: string | null | undefined }>();
  const visit = (message: ChatMessage, turn: string) => {
    const entry = turns.get(turn) ?? { title: null, folder: undefined };
    turns.set(turn, entry);
    const card = sitePreviewFromMessage(message);
    if (card !== null) {
      cardTitles.add(card.title);
      entry.title = card.title;
    }
    if (!Array.isArray(message.files) || message.files.length === 0 || !Number.isFinite(message.timestamp)) return;
    newestFilesByTurn.set(turn, Math.max(newestFilesByTurn.get(turn) ?? -Infinity, message.timestamp));
    for (const file of message.files) {
      const folder = pageFolderOf(file.workspacePath || file.path || "");
      entry.folder = entry.folder === undefined || entry.folder === folder ? folder : null;
    }
  };
  for (const message of messages) {
    const thread = threadMessagesOf(message);
    if (thread.length > 0) {
      for (const threadMessage of thread) visit(threadMessage, message.id);
    } else {
      visit(message, extractAgentJobId(message) ?? `message:${message.id}`);
    }
  }
  if (cardTitles.size === 0) return null;
  const pageTitles = new Map<string, string>();
  for (const { title, folder } of turns.values()) {
    if (title !== null && folder) pageTitles.set(folder, title);
  }
  const folders = new Set([...turns.values()].map(({ folder }) => folder).filter((folder) => folder !== undefined));
  const [onlyFolder] = folders;
  if (pageTitles.size === 0 && cardTitles.size === 1 && folders.size === 1 && onlyFolder) {
    pageTitles.set(onlyFolder, [...cardTitles][0]!);
  }
  return {
    firstChangeAt: newestFilesByTurn.size > 0 ? Math.min(...newestFilesByTurn.values()) : null,
    pageTitles,
  };
}
