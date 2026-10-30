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
 * - while that tab is still open, and while no other chat took it since: a
 *   turn of another chat ran in it later, or the person chose it in another
 *   chat later. That page is the other chat's now. (Turns from before one tab
 *   per chat ran in whatever tab was on screen, so several chats' turns may
 *   name one tab: it is the chat's whose turn ran there last.)
 * A chat without one gets a blank tab that no chat uses, the one a browser
 * that just started shows or a new one Studio opens for it, and the turn's
 * blank-page rule takes it to the task's site. The chat's Browser view shows
 * that tab (ChatPanel brings it forward).
 *
 * When a browser turn ends with the chat's tab still blank (Octo read in tabs
 * of its own), the runtime keeps the tab Octo worked in last open, as Take
 * over keeps a tab, and the browser's tab list names that turn on it
 * (`leftByRun`). Once the turn has ended that tab is the chat's: the page the
 * person is left with is the one Octo read, on every device and after a
 * reload too.
 */

/** A tab a chat chose or ran in, and when. */
type ChosenTab = { pageId: string; atMs: number };
/** A tab the person chose in a chat on this page, or one Studio gave the chat. */
type RememberedTab = ChosenTab & { browser: string; conversationId: string };

// What this page remembers, in module memory like the automatic starts: a
// reload starts empty, and the chats' runs say which tabs they used.
const rememberedTabs = new Map<string, RememberedTab>();
const MAX_REMEMBERED = 500;

function remember(tab: RememberedTab): void {
  const key = JSON.stringify([tab.browser, tab.conversationId, tab.pageId]);
  rememberedTabs.delete(key);
  rememberedTabs.set(key, tab);
  while (rememberedTabs.size > MAX_REMEMBERED) {
    const oldest = rememberedTabs.keys().next().value;
    if (oldest === undefined) break;
    rememberedTabs.delete(oldest);
  }
}

/** Empties what this page remembers, as a reload would. Tests only. */
export function forgetChatBrowserTabsForTests(): void {
  rememberedTabs.clear();
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

/** The browser a scope's chats share, as this page sees it. */
function browserKey(scope: ChatBrowserTabScope): string | null {
  return scope.userId && scope.projectId && scope.runtimeId
    ? JSON.stringify([scope.userId, scope.projectId, scope.runtimeId])
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

/** A run that has not ended, and one that may hold the browser now. */
const RUN_ON_ITS_WAY = new Set(["queued", "in_progress", "awaiting_approval"]);
const RUN_UNDER_WAY = new Set(["in_progress", "awaiting_approval"]);

/** The chat's newest browser turn on this browser. */
function newestChatBrowserRun(
  runs: readonly RunRecord[],
  scope: { conversationId: string | null; runtimeId: string | null },
): RunRecord | null {
  if (!scope.conversationId || !scope.runtimeId) return null;
  let newest: RunRecord | null = null;
  for (const run of runs) {
    if (run.conversationId !== scope.conversationId || !sharedBrowserPageId(run, scope.runtimeId)) continue;
    if (!newest || runStartedAt(run) > runStartedAt(newest)) newest = run;
  }
  return newest;
}

/** Whether a browser turn is under way on this browser: of this chat only, or of any chat. */
export function browserTurnUnderWay(
  runs: readonly RunRecord[],
  scope: { conversationId: string | null; runtimeId: string | null },
  whose: "chat" | "any",
): boolean {
  const runtimeId = scope.runtimeId;
  if (!runtimeId) return false;
  return runs.some((run) => RUN_UNDER_WAY.has(run.status) && sharedBrowserPageId(run, runtimeId) !== null &&
    (whose === "any" || (scope.conversationId !== null && run.conversationId === scope.conversationId)));
}

/**
 * The tab the chat's newest browser turn left it, once that turn has ended:
 * the tab the browser's tab list says that turn left open as its chat's page
 * (`leftByRun`). It counts from just after the turn started, so it takes the
 * place of the tab the turn was sent for.
 */
function tabLeftForChat(
  scope: ChatBrowserTabScope,
  runs: readonly RunRecord[],
  pages: readonly { id: string; leftByRun?: string }[],
): ChosenTab | null {
  const run = newestChatBrowserRun(runs, scope);
  if (!run || RUN_ON_ITS_WAY.has(run.status)) return null;
  const left = pages.find((page) => page.leftByRun === run.id);
  return left ? { pageId: left.id, atMs: runStartedAt(run) + 1 } : null;
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

/** The tab the person last chose in this chat on this page, or Studio gave it. */
function chosenChatBrowserTab(scope: ChatBrowserTabScope): ChosenTab | null {
  const browser = browserKey(scope);
  if (!browser || !scope.conversationId) return null;
  let newest: ChosenTab | null = null;
  for (const tab of rememberedTabs.values()) {
    if (tab.browser !== browser || tab.conversationId !== scope.conversationId) continue;
    if (!newest || tab.atMs > newest.atMs) newest = { pageId: tab.pageId, atMs: tab.atMs };
  }
  return newest;
}

/**
 * Whether another chat took this tab after `sinceMs`: a turn of another chat
 * ran in it later, or the person chose it in another chat later.
 */
function takenByAnotherChat(
  pageId: string,
  sinceMs: number,
  scope: ChatBrowserTabScope & { runtimeId: string },
  runs: readonly RunRecord[],
): boolean {
  for (const run of runs) {
    if (run.conversationId === scope.conversationId) continue;
    if (sharedBrowserPageId(run, scope.runtimeId) === pageId && runStartedAt(run) > sinceMs) return true;
  }
  const browser = browserKey(scope);
  for (const tab of rememberedTabs.values()) {
    if (tab.browser === browser && tab.conversationId !== scope.conversationId &&
        tab.pageId === pageId && tab.atMs > sinceMs) return true;
  }
  return false;
}

/**
 * Whether another chat took this tab after `sinceMs` (see above). A follow-up
 * asks it too: it goes on in its turn's tab only while that is still the
 * chat's own.
 */
export function browserTabTakenByAnotherChat(input: {
  scope: ChatBrowserTabScope;
  runs: readonly RunRecord[];
  pageId: string;
  sinceMs: number;
}): boolean {
  const { scope } = input;
  if (!scopeKey(scope) || !scope.runtimeId) return false;
  return takenByAnotherChat(input.pageId, input.sinceMs, { ...scope, runtimeId: scope.runtimeId }, input.runs);
}

/**
 * When a tab chosen on this page counts from: now, and never before a turn on
 * that browser this page knows of, so a clock behind the server's does not
 * make a pick look older than the turns it follows.
 */
function chosenAt(runs: readonly RunRecord[], runtimeId: string): number {
  let newest = 0;
  for (const run of runs) {
    if (sharedBrowserPageId(run, runtimeId)) newest = Math.max(newest, runStartedAt(run));
  }
  return Math.max(Date.now(), newest + 1);
}

/**
 * The chat's own tab among the browser's open tabs: the newest of the one the
 * person chose here, the one its last browser turn ran in and the one that
 * turn left it (see above), while it is open and no other chat took it since.
 * Null when the chat has none.
 */
export function chatBrowserTab<Page extends { id: string; leftByRun?: string }>(input: {
  scope: ChatBrowserTabScope;
  runs: readonly RunRecord[];
  pages: readonly Page[];
}): Page | null {
  const { scope } = input;
  if (!scopeKey(scope) || !scope.runtimeId) return null;
  const owned = { ...scope, runtimeId: scope.runtimeId };
  const chosen = chosenChatBrowserTab(scope);
  const ran = lastChatBrowserTab(input.runs, scope);
  const left = tabLeftForChat(scope, input.runs, input.pages);
  const candidates = [chosen, left, ran]
    .filter((entry): entry is ChosenTab => entry !== null)
    .sort((left, right) => right.atMs - left.atMs);
  for (const candidate of candidates) {
    const page = input.pages.find((entry) => entry.id === candidate.pageId);
    if (page && !takenByAnotherChat(candidate.pageId, candidate.atMs, owned, input.runs)) return page;
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
  for (const tab of rememberedTabs.values()) used.add(tab.pageId);
  const blank = input.pages.filter((page) =>
    browserSessionPageIsPlaceholder(page) && page.openedBy !== "agent" && !used.has(page.id));
  return blank.find((page) => page.isActive) ?? blank[0] ?? null;
}

/**
 * What the chat's Browser view did so far while on screen: the chat's tab it
 * brought forward, the chat it asked a blank tab for, and whether someone
 * other than this chat's own turn controlled the browser since, so the
 * chat's tab comes forward again once they are done.
 */
export type ChatBrowserViewState = { shown: string | null; blankTabFor: string | null; refocus: boolean };

export const CHAT_BROWSER_VIEW_START: ChatBrowserViewState = { shown: null, blankTabFor: null, refocus: false };

/**
 * The chat's Browser view shows the chat's own tab, never the tab another
 * chat left in front: once when the view comes on screen for the chat, once
 * for each new tab the chat gets (the page its browser turn left it
 * included), and once after someone else controlled the browser (another
 * chat's turn, or another person), when they are done and no browser turn is
 * under way; each time unless it is in front already. Never over the
 * person's own pick (a pick is the chat's tab), and not while someone else,
 * Octo included, controls the browser: the view then shows what they do.
 * This chat's own turn leaves the browser where the turn ends (its page, or a
 * tab the person took over). A chat with no tab yet gets its own blank one,
 * once while the view is on screen.
 */
export function nextChatBrowserViewStep(input: {
  onScreen: boolean;
  /** Who is in the browser is known, and nobody else controls it. */
  free: boolean;
  chatId: string | null;
  tab: { id: string; isActive: boolean } | null;
  /** The browser's tabs are read, and this person may open one. */
  canOpenTab: boolean;
  /** A browser turn of this chat is under way: it holds the browser, or the person took it over. */
  chatTurnUnderWay: boolean;
  /** A browser turn of any chat is under way on this browser. */
  anyTurnUnderWay: boolean;
  state: ChatBrowserViewState;
}): { state: ChatBrowserViewState; step: "none" | "open-blank-tab" | "focus" } {
  if (!input.onScreen) return { state: CHAT_BROWSER_VIEW_START, step: "none" };
  let { state } = input;
  if (input.chatTurnUnderWay) {
    if (state.refocus) state = { ...state, refocus: false };
  } else if (!input.free && !state.refocus) {
    state = { ...state, refocus: true };
  }
  if (!input.free) return { state, step: "none" };
  if (!input.tab) {
    if (!input.chatId || !input.canOpenTab || state.blankTabFor === input.chatId) return { state, step: "none" };
    return { state: { ...state, blankTabFor: input.chatId }, step: "open-blank-tab" };
  }
  const shown = JSON.stringify([input.chatId, input.tab.id]);
  const step = input.tab.isActive ? "none" : "focus";
  if (state.shown !== shown) return { state: { ...state, shown, refocus: false }, step };
  if (state.refocus && !input.anyTurnUnderWay) return { state: { ...state, refocus: false }, step };
  return { state, step: "none" };
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
  /**
   * Whether this browser opens a blank tab: false for an older one that does
   * not, null until the browser said.
   */
  canOpenPage: boolean | null;
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

  /** Gives this chat the tab: its later browser turns use it, and no other chat's do. */
  const give = useCallback((scope: ChatBrowserTabScope, pageId: string) => {
    const browser = browserKey(scope);
    const id = pageId.trim();
    if (!browser || !scope.conversationId || !scope.runtimeId || !id) return;
    remember({ browser, conversationId: scope.conversationId, pageId: id, atMs: chosenAt(latest.current.runs, scope.runtimeId) });
    setChosenVersion((version) => version + 1);
  }, []);

  /** The person chose this tab in this chat: its later browser turns use it. */
  const choose = useCallback((pageId: string) => give(latest.current.scope, pageId), [give]);

  /** Whether another chat took this tab after `sinceMs`: a follow-up then stays in the chat. */
  const tabTakenByAnotherChat = useCallback(
    (pageId: string, sinceMs: number) =>
      browserTabTakenByAnotherChat({ scope: latest.current.scope, runs: latest.current.runs, pageId, sinceMs }),
    // Read again when the chat, its runs or the memory change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, runs, chosenVersion],
  );

  /**
   * The tab a browser turn of this chat is sent for: the chat's own tab, else
   * a blank tab no chat uses, else a new blank tab opened for the chat. Null
   * only on an older browser that cannot open one: the caller then keeps its
   * older behaviour. When this browser does not open one (it is full, did not
   * answer, or has not said yet whether it can and cannot), it throws with a
   * plain reason: the turn is not sent to another chat's page instead.
   *
   * A new chat has no id until its first message is sent: its first turn gets
   * a blank tab too, which its run then names as the chat's tab.
   */
  const resolveForTurn = useCallback(async (): Promise<BrowserSessionPageTarget | null> => {
    const current = latest.current;
    const turnScope = current.scope;
    const browser = browserKey(turnScope);
    if (!browser) return null;
    const turnKey = scopeKey(turnScope) ?? JSON.stringify([browser, "a new chat"]);
    const own = chatBrowserTab({ scope: turnScope, runs: current.runs, pages: current.pages });
    if (own) return toBrowserSessionPageTarget(own);
    const blank = unusedBlankBrowserTab({ runs: current.runs, pages: current.pages });
    if (blank) {
      give(turnScope, blank.id);
      return toBrowserSessionPageTarget(blank);
    }
    if (current.canOpenPage === false) return null;
    // Two sends at once open one tab between them.
    if (opening.current?.key === turnKey) return opening.current.promise;
    const promise = current.openPage().then((pageId) => {
      if (!pageId) throw new Error(CHAT_BROWSER_TAB_COPY.notOpened);
      give(turnScope, pageId);
      return { id: pageId, ...BLANK_TAB_TARGET };
    }).finally(() => {
      if (opening.current?.promise === promise) opening.current = null;
    });
    opening.current = { key: turnKey, promise };
    return promise;
  }, [give]);

  return { tab, choose, resolveForTurn, takenByAnotherChat: tabTakenByAnotherChat };
}
