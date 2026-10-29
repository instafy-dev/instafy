import { useCallback, useMemo, useRef, useState } from "react";
import type { RunRecord } from "../../../types";
import {
  browserSessionPageIsPlaceholder,
  toBrowserSessionPageTarget,
  type BrowserSessionPage,
  type BrowserSessionPageTarget,
} from "./browserSessionPages";

/**
 * One tab per chat in Instafy's browser.
 *
 * The browser is shared by the space's chats, so a turn that took whatever
 * tab was on screen could start on another chat's page, and under routine
 * browsing nothing asks before that page is read. Instead a chat's browser
 * turns use the chat's own tab:
 * - the tab the person chose in this chat (the browser's own tab list or
 *   address bar), when that is newer than the chat's last browser turn;
 * - otherwise the tab the chat's last browser turn ran in (`browserPageId`);
 * - while that tab is still open. A chat without one gets a blank tab that no
 *   chat uses, the one a browser that just started shows or a new one Studio
 *   opens for it, and the turn's blank-page rule takes it to the task's site.
 * The chat's Browser view shows that tab (ChatPanel brings it forward).
 */

/** A tab the person chose in a chat, or one Studio opened for it, and when. */
type ChosenTab = { pageId: string; atMs: number };

// What this page remembers, in module memory like the automatic starts: a
// reload starts empty, and the chat's runs say which tab it used.
const chosenTabs = new Map<string, ChosenTab>();
const MAX_REMEMBERED = 500;

function remember(key: string, chosen: ChosenTab): void {
  chosenTabs.delete(key);
  chosenTabs.set(key, chosen);
  while (chosenTabs.size > MAX_REMEMBERED) {
    const oldest = chosenTabs.keys().next().value;
    if (oldest === undefined) break;
    chosenTabs.delete(oldest);
  }
}

/** Empties what this page remembers, as a reload would. Tests only. */
export function forgetChatBrowserTabsForTests(): void {
  chosenTabs.clear();
}

export type ChatBrowserTabScope = {
  userId: string | null;
  projectId: string | null;
  /** The chat's controller id, as its runs carry it. */
  conversationId: string | null;
  /** The machine Instafy's browser runs on. */
  runtimeId: string | null;
};

function scopeKey(scope: ChatBrowserTabScope): string | null {
  return scope.userId && scope.projectId && scope.conversationId && scope.runtimeId
    ? JSON.stringify([scope.userId, scope.projectId, scope.conversationId, scope.runtimeId])
    : null;
}

function runStartedAt(run: RunRecord): number {
  return Date.parse(run.createdAt ?? run.updatedAt ?? "") || 0;
}

function sharedBrowserPageId(run: RunRecord, runtimeId: string): string | null {
  const metadata = run.metadata;
  const pageId = metadata?.browserPageId;
  return metadata?.browserTransport === "shared" && metadata.browserRuntimeId === runtimeId &&
    typeof pageId === "string" && pageId.trim() ? pageId.trim() : null;
}

/** The tab a chat's newest browser turn on this browser ran in, and when it started. */
export function lastChatBrowserTab(
  runs: readonly RunRecord[],
  scope: { conversationId: string | null; runtimeId: string | null },
): ChosenTab | null {
  if (!scope.conversationId || !scope.runtimeId) return null;
  let newest: ChosenTab | null = null;
  for (const run of runs) {
    if (run.conversationId !== scope.conversationId) continue;
    const pageId = sharedBrowserPageId(run, scope.runtimeId);
    if (!pageId) continue;
    const atMs = runStartedAt(run);
    if (!newest || atMs > newest.atMs) newest = { pageId, atMs };
  }
  return newest;
}

/**
 * The chat's own tab among the browser's open tabs: the newer of the one the
 * person chose here and the one its last browser turn ran in, while it is
 * open. Null when the chat has none.
 */
export function chatBrowserTab<Page extends { id: string }>(input: {
  scope: ChatBrowserTabScope;
  runs: readonly RunRecord[];
  pages: readonly Page[];
}): Page | null {
  const key = scopeKey(input.scope);
  if (!key) return null;
  const chosen = chosenTabs.get(key) ?? null;
  const ran = lastChatBrowserTab(input.runs, input.scope);
  const candidates = [chosen, ran]
    .filter((entry): entry is ChosenTab => entry !== null)
    .sort((left, right) => right.atMs - left.atMs);
  for (const candidate of candidates) {
    const page = input.pages.find((entry) => entry.id === candidate.pageId);
    if (page) return page;
  }
  return null;
}

/**
 * A blank tab no chat uses, to give a chat as its own: never one a turn of any
 * chat was sent for, nor one remembered for another chat. The tab on screen
 * first, so a browser that just started keeps its one tab.
 */
export function unusedBlankBrowserTab<Page extends BrowserSessionPage>(input: {
  runs: readonly RunRecord[];
  pages: readonly Page[];
}): Page | null {
  const used = new Set<string>();
  for (const run of input.runs) {
    const pageId = run.metadata?.browserPageId;
    if (typeof pageId === "string" && pageId.trim()) used.add(pageId.trim());
  }
  for (const chosen of chosenTabs.values()) used.add(chosen.pageId);
  const blank = input.pages.filter((page) =>
    browserSessionPageIsPlaceholder(page) && page.openedBy !== "agent" && !used.has(page.id));
  return blank.find((page) => page.isActive) ?? blank[0] ?? null;
}

const BLANK_TAB_TARGET = { url: "about:blank", host: "", label: "New tab" } as const;

/** Said when the browser could not open the chat's own tab, so the turn was not sent. */
export const CHAT_BROWSER_TAB_COPY = {
  notOpened: "Instafy's browser could not open a tab for this chat. Try again.",
} as const;

/**
 * The chat's own tab in Instafy's browser (see above) for ChatPanel: the tab
 * now, what the person chose here, and the tab a browser turn of this chat is
 * sent for.
 */
export function useChatBrowserTab(input: {
  scope: ChatBrowserTabScope;
  runs: readonly RunRecord[];
  /** The browser's open tabs, blank ones included. */
  pages: readonly BrowserSessionPage[];
  /** Whether this browser opens a blank tab (an older one does not). */
  canOpenPage: boolean;
  /** Opens a blank tab behind the one on screen; null when it cannot. */
  openPage: () => Promise<string | null>;
}) {
  const latest = useRef(input);
  latest.current = input;
  const { scope, runs, pages } = input;
  const key = scopeKey(scope);
  // Bumped when a tab is chosen for a chat, so `tab` is read again.
  const [chosenVersion, setChosenVersion] = useState(0);
  const tab = useMemo(
    () => chatBrowserTab({ scope, runs, pages }),
    // `scope` is read through its key; `chosenVersion` stands for the memory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, runs, pages, chosenVersion],
  );
  const opening = useRef<{ key: string; promise: Promise<BrowserSessionPageTarget | null> } | null>(null);

  /** The person chose this tab in this chat: its later browser turns use it. */
  const choose = useCallback((pageId: string) => {
    const chosenKey = scopeKey(latest.current.scope);
    const id = pageId.trim();
    if (!chosenKey || !id) return;
    remember(chosenKey, { pageId: id, atMs: Date.now() });
    setChosenVersion((version) => version + 1);
  }, []);

  /**
   * The tab a browser turn of this chat is sent for: the chat's own tab, else
   * a blank tab no chat uses, else a new blank tab opened for the chat. Null
   * only on an older browser that cannot open one: the caller then keeps its
   * older behaviour. When this browser can open one and does not (it is full,
   * or did not answer), it throws with a plain reason: the turn is not sent to
   * another chat's page instead.
   */
  const resolveForTurn = useCallback(async (): Promise<BrowserSessionPageTarget | null> => {
    const current = latest.current;
    const turnKey = scopeKey(current.scope);
    if (!turnKey) return null;
    const own = chatBrowserTab({ scope: current.scope, runs: current.runs, pages: current.pages });
    if (own) return toBrowserSessionPageTarget(own);
    const blank = unusedBlankBrowserTab({ runs: current.runs, pages: current.pages });
    if (blank) {
      remember(turnKey, { pageId: blank.id, atMs: Date.now() });
      setChosenVersion((version) => version + 1);
      return toBrowserSessionPageTarget(blank);
    }
    if (!current.canOpenPage) return null;
    // Two sends at once open one tab between them.
    if (opening.current?.key === turnKey) return opening.current.promise;
    const promise = current.openPage().then((pageId) => {
      if (!pageId) throw new Error(CHAT_BROWSER_TAB_COPY.notOpened);
      remember(turnKey, { pageId, atMs: Date.now() });
      setChosenVersion((version) => version + 1);
      return { id: pageId, ...BLANK_TAB_TARGET };
    }).finally(() => {
      if (opening.current?.promise === promise) opening.current = null;
    });
    opening.current = { key: turnKey, promise };
    return promise;
  }, []);

  return { tab, choose, resolveForTurn };
}
