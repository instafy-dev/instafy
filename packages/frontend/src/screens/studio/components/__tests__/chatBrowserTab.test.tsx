// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import type { BrowserSessionPage } from "../browserSessionPages";
import {
  CHAT_BROWSER_TAB_COPY,
  CHAT_BROWSER_VIEW_START,
  CHAT_VIEW_TURN_TABS_START,
  chatBrowserHandoffPage,
  chatBrowserTab,
  chatBrowserTarget,
  chatPageOnScreen,
  chatViewPageIds,
  chatViewStepTab,
  nextChatViewTurnTabs,
  useChatViewTabs,
  forgetChatBrowserTabsForTests,
  lastChatBrowserTab,
  browserTurnUnderWay,
  newChatBrowserTabId,
  nextChatBrowserViewStep,
  unusedBlankBrowserTab,
  useChatBrowserTab,
  type ChatBrowserTabScope,
} from "../chatBrowserTab";

const RUNTIME = "runtime-1";
const MAP_CHAT = "chat-map";
const VACUUM_CHAT = "chat-vacuums";

function page(id: string, url: string, overrides: Partial<BrowserSessionPage> = {}): BrowserSessionPage {
  const host = url.startsWith("http") ? new URL(url).host : "";
  return { id, url, host, label: host || "New tab", title: null, lastReferencedAt: 1, isActive: false, ...overrides };
}

function browserRun(id: string, conversationId: string, pageId: string, createdAt: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id, projectId: "project-1", sessionId: null, conversationId, promptId: null, runType: "prompt",
    status: "success", progress: 1, progressStage: null, previewUrl: null, lastMessage: null, createdAt, updatedAt: createdAt,
    metadata: { browserTransport: "shared", browserRuntimeId: RUNTIME, browserPageId: pageId, initiatingUserId: "user-1" },
    ...overrides,
  };
}

function scope(conversationId: string): ChatBrowserTabScope {
  return { userId: "user-1", projectId: "project-1", conversationId, runtimeId: RUNTIME };
}

// Local drive, Oct 29: the map chat's browser turn left a Visit Lisboa page
// on screen, and the vacuum chat's first browser turn was sent there and read
// it. A chat's browser turns now use the chat's own tab.
const LISBON = page("PAGE-LISBON", "https://www.visitlisboa.com/en/places/ask-me-lisboa", { isActive: true });
const MAP_RUN = browserRun("run-map", MAP_CHAT, LISBON.id, "2026-10-29T09:55:20Z");

describe("a chat's own tab in Instafy's browser", () => {
  beforeEach(() => forgetChatBrowserTabsForTests());

  it("is the tab the chat's last browser turn ran in, while it is open", () => {
    const later = page("PAGE-BELEM", "https://www.visitlisboa.com/en/places/belem");
    const runs = [MAP_RUN, browserRun("run-map-2", MAP_CHAT, later.id, "2026-10-29T09:58:00Z")];
    expect(chatBrowserTab({ scope: scope(MAP_CHAT), runs, pages: [LISBON, later] })).toBe(later);
    // Once that tab is closed the chat has none: an older one is not reused.
    expect(chatBrowserTab({ scope: scope(MAP_CHAT), runs, pages: [LISBON] })).toBeNull();
    expect(lastChatBrowserTab(runs, { conversationId: MAP_CHAT, runtimeId: RUNTIME })?.pageId).toBe(later.id);
  });

  it("is never the tab another chat's turn left on screen", () => {
    expect(chatBrowserTab({ scope: scope(VACUUM_CHAT), runs: [MAP_RUN], pages: [LISBON] })).toBeNull();
    // Nor the chat's own page on another machine's browser.
    expect(chatBrowserTab({ scope: { ...scope(MAP_CHAT), runtimeId: "runtime-2" }, runs: [MAP_RUN], pages: [LISBON] })).toBeNull();
    // A blank tab another chat's turn was sent for is not free either.
    const mapBlank = page("PAGE-BLANK", "about:blank");
    expect(unusedBlankBrowserTab({ runs: [browserRun("run-x", MAP_CHAT, mapBlank.id, "2026-10-29T10:00:00Z")], pages: [mapBlank] }))
      .toBeNull();
  });

  // Browser turns from before one tab per chat ran in whatever tab was on
  // screen, so several chats' turns name the same tab. That tab is the chat's
  // whose turn ran there last; the others get a tab of their own instead of
  // the page that chat left there.
  it("is not a tab another chat's turn ran in since", () => {
    const vacuumRun = browserRun("run-vacuum", VACUUM_CHAT, LISBON.id, "2026-10-29T10:03:47Z");
    const runs = [MAP_RUN, vacuumRun];
    expect(chatBrowserTab({ scope: scope(MAP_CHAT), runs, pages: [LISBON] })).toBeNull();
    expect(chatBrowserTab({ scope: scope(VACUUM_CHAT), runs, pages: [LISBON] })).toBe(LISBON);
    // A turn of the map chat after that takes it back.
    const mapAgain = browserRun("run-map-3", MAP_CHAT, LISBON.id, "2026-10-29T10:10:00Z");
    expect(chatBrowserTab({ scope: scope(MAP_CHAT), runs: [...runs, mapAgain], pages: [LISBON] })).toBe(LISBON);
    expect(chatBrowserTab({ scope: scope(VACUUM_CHAT), runs: [...runs, mapAgain], pages: [LISBON] })).toBeNull();
  });

  it("gives a chat the blank tab a browser that just started shows, and never Octo's own", () => {
    const blank = page("PAGE-START", "about:blank", { isActive: true });
    expect(unusedBlankBrowserTab({ runs: [], pages: [blank] })).toBe(blank);
    expect(unusedBlankBrowserTab({ runs: [], pages: [{ ...blank, openedBy: "agent" }] })).toBeNull();
    expect(unusedBlankBrowserTab({ runs: [MAP_RUN], pages: [LISBON] })).toBeNull();
  });
});

describe("useChatBrowserTab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useChatBrowserTab> | null;

  function Harness(props: Parameters<typeof useChatBrowserTab>[0]) {
    latest = useChatBrowserTab(props);
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetChatBrowserTabsForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(props: Partial<Parameters<typeof useChatBrowserTab>[0]> = {}) {
    const full: Parameters<typeof useChatBrowserTab>[0] = {
      scope: scope(VACUUM_CHAT), runs: [MAP_RUN], pages: [LISBON], canOpenPage: true,
      openPage: vi.fn(async () => "PAGE-NEW"), ...props,
    };
    await act(async () => root.render(<Harness {...full} />));
    return full;
  }

  it("sends a new chat's first browser turn to a blank tab of its own, never the page another chat left", async () => {
    const props = await render();
    expect(latest!.tab).toBeNull();
    let target: Awaited<ReturnType<ReturnType<typeof useChatBrowserTab>["resolveForTurn"]>> = null;
    await act(async () => { target = await latest!.resolveForTurn(); });
    expect(props.openPage).toHaveBeenCalledOnce();
    expect(target).toEqual({ id: "PAGE-NEW", url: "about:blank", host: "", label: "New tab" });
    // The chat's Browser view shows that tab once the browser lists it.
    const opened = page("PAGE-NEW", "about:blank");
    await render({ ...props, pages: [LISBON, opened] });
    expect(latest!.tab?.id).toBe("PAGE-NEW");
    // Its next turn goes there again, without opening another.
    await act(async () => { target = await latest!.resolveForTurn(); });
    expect(props.openPage).toHaveBeenCalledOnce();
    expect(target).toMatchObject({ id: "PAGE-NEW" });
  });

  // A new chat has no id of its own until its first message is sent. Its
  // first browser turn (from the Browser view's own composer) still gets a
  // tab of its own, never the page another chat left on screen.
  it("gives a new chat's first browser turn a tab of its own before the chat has its id", async () => {
    const props = await render({ scope: { ...scope(VACUUM_CHAT), conversationId: null } });
    let target: Awaited<ReturnType<ReturnType<typeof useChatBrowserTab>["resolveForTurn"]>> = null;
    await act(async () => { target = await latest!.resolveForTurn(); });
    expect(props.openPage).toHaveBeenCalledOnce();
    expect(target).toMatchObject({ id: "PAGE-NEW", url: "about:blank" });
  });

  // A chat with nothing sent yet: its Browser view shows a tab of its own,
  // kept under its local id, never the page another chat left in front. Its
  // first message gives it an id, and the page the person reached there stays
  // the chat's tab.
  it("keeps a new chat's own tab once its first message gives it an id", async () => {
    const newChat = newChatBrowserTabId("local-chat-1");
    const props = await render({ scope: { ...scope(VACUUM_CHAT), conversationId: newChat }, newChatId: newChat });
    expect(latest!.tab).toBeNull();
    await act(async () => { await latest!.resolveForTurn(); });
    expect(props.openPage).toHaveBeenCalledOnce();
    const browsed = page("PAGE-NEW", "https://www.roborock.com/");
    await render({ ...props, pages: [LISBON, browsed] });
    expect(latest!.tab?.id).toBe("PAGE-NEW");
    await render({ ...props, scope: scope(VACUUM_CHAT), pages: [LISBON, browsed] });
    expect(latest!.tab?.id).toBe("PAGE-NEW");
    // It is no other chat's.
    await render({ ...props, scope: scope(MAP_CHAT), newChatId: null, pages: [LISBON, browsed] });
    expect(latest!.tab?.id).toBe(LISBON.id);
  });

  it("keeps a chat's later turns in the tab its last turn used", async () => {
    const props = await render({ scope: scope(MAP_CHAT) });
    let target: Awaited<ReturnType<ReturnType<typeof useChatBrowserTab>["resolveForTurn"]>> = null;
    await act(async () => { target = await latest!.resolveForTurn(); });
    expect(target).toMatchObject({ id: LISBON.id, url: LISBON.url });
    expect(props.openPage).not.toHaveBeenCalled();
  });

  it("uses the tab the person chose in this chat over the one its last turn used", async () => {
    const other = page("PAGE-OTHER", "https://example.com/");
    await render({ scope: scope(MAP_CHAT), pages: [LISBON, other] });
    await act(async () => latest!.choose(other.id));
    expect(latest!.tab?.id).toBe(other.id);
    let target: Awaited<ReturnType<ReturnType<typeof useChatBrowserTab>["resolveForTurn"]>> = null;
    await act(async () => { target = await latest!.resolveForTurn(); });
    expect(target).toMatchObject({ id: other.id });
  });

  // The person picks the map chat's tab in the vacuum chat's Browser view and
  // sends it somewhere: it is the vacuum chat's tab now. The map chat's next
  // turn gets a tab of its own, never the page the vacuum chat left there,
  // also when this device's clock is behind the server's.
  it("gives a tab the person chose in another chat to that chat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T09:00:00Z"));
    try {
      await render({ scope: scope(VACUUM_CHAT) });
      await act(async () => latest!.choose(LISBON.id));
      expect(latest!.tab?.id).toBe(LISBON.id);
      expect(chatBrowserTab({ scope: scope(MAP_CHAT), runs: [MAP_RUN], pages: [LISBON] })).toBeNull();
      await render({ scope: scope(MAP_CHAT) });
      let target: Awaited<ReturnType<ReturnType<typeof useChatBrowserTab>["resolveForTurn"]>> = null;
      await act(async () => { target = await latest!.resolveForTurn(); });
      expect(target).toMatchObject({ id: "PAGE-NEW", url: "about:blank" });
    } finally {
      vi.useRealTimers();
    }
  });

  // Studio reads whether the browser opens tabs when it opens; until that
  // reading is in, a browser that can is not taken for one that cannot.
  it("tries to open the chat's tab before the browser said whether it can", async () => {
    const props = await render({ canOpenPage: null });
    let target: Awaited<ReturnType<ReturnType<typeof useChatBrowserTab>["resolveForTurn"]>> = null;
    await act(async () => { target = await latest!.resolveForTurn(); });
    expect(props.openPage).toHaveBeenCalledOnce();
    expect(target).toMatchObject({ id: "PAGE-NEW", url: "about:blank" });
    // One that could not open it says so, and the turn is not sent to the page on screen.
    forgetChatBrowserTabsForTests();
    await render({ canOpenPage: null, openPage: vi.fn(async () => null) });
    let failure: unknown = null;
    await act(async () => { await latest!.resolveForTurn().catch((error: unknown) => { failure = error; }); });
    expect((failure as Error | null)?.message).toBe(CHAT_BROWSER_TAB_COPY.notOpened);
  });

  it("opens one tab for two turns sent at once", async () => {
    let finish!: (id: string) => void;
    const openPage = vi.fn(() => new Promise<string | null>((resolve) => { finish = resolve; }));
    await render({ openPage });
    let first: Promise<unknown> | null = null;
    let second: Promise<unknown> | null = null;
    await act(async () => {
      first = latest!.resolveForTurn();
      second = latest!.resolveForTurn();
    });
    await act(async () => finish("PAGE-NEW"));
    expect(await first).toMatchObject({ id: "PAGE-NEW" });
    expect(await second).toMatchObject({ id: "PAGE-NEW" });
    expect(openPage).toHaveBeenCalledOnce();
  });

  it("never sends to another chat's page when the browser could not open this chat's tab", async () => {
    await render({ openPage: vi.fn(async () => null) });
    let failure: unknown = null;
    await act(async () => { await latest!.resolveForTurn().catch((error: unknown) => { failure = error; }); });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(CHAT_BROWSER_TAB_COPY.notOpened);
  });

  it("leaves the choice to the caller when an older browser cannot open a tab", async () => {
    const props = await render({ canOpenPage: false });
    let target: unknown = "unset";
    await act(async () => { target = await latest!.resolveForTurn(); });
    expect(target).toBeNull();
    expect(props.openPage).not.toHaveBeenCalled();
  });
});

// A browser turn that read in Octo's own tabs while the chat's tab stayed
// blank: the runtime keeps the tab Octo worked in last open, and the
// browser's tab list names that turn on it (`leftByRun`). That tab is the
// chat's page once the turn has ended, wherever the chat is opened.
describe("the page a browser turn leaves its chat", () => {
  const TRAM_CHAT = "chat-tram";
  const TRAM_RUN = "7a1f6f0e-2c4b-4c1e-9a43-0d6c2b1e5f10";
  const chatBlank = page("PAGE-CHAT", "about:blank");
  const planner = page("TAB-PLANNER", "https://www.trams.example/planner", { openedBy: "agent", agentTabNumber: 2, isActive: true });
  const running = browserRun(TRAM_RUN, TRAM_CHAT, chatBlank.id, "2026-10-29T19:47:34Z", { status: "in_progress" });
  const ended = { ...running, status: "success" as const };
  const left = { ...planner, openedBy: undefined, agentTabNumber: undefined, leftByRun: TRAM_RUN };

  beforeEach(() => forgetChatBrowserTabsForTests());

  // Studio used to learn that tab only by watching the turn, in this page's
  // memory: after a reload, on another device or for another member the chat
  // went back to its blank tab, and its view brought that blank tab forward
  // over the page Octo read.
  it("is the tab the browser says the chat's turn left it, in a page that never watched the turn", () => {
    // While the turn runs, the chat's tab is the one it was sent for.
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [running], pages: [chatBlank, planner] })?.id)
      .toBe(chatBlank.id);
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [running], pages: [chatBlank, left] })?.id)
      .toBe(chatBlank.id);
    // Ended: the tab it left is the chat's.
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [ended], pages: [chatBlank, left] })?.id).toBe(left.id);
    // Never another chat's.
    expect(chatBrowserTab({ scope: scope(MAP_CHAT), runs: [MAP_RUN, ended], pages: [LISBON, chatBlank, left] })?.id)
      .toBe(LISBON.id);
  });

  it("is the chat's own tab when the turn left none", () => {
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [ended], pages: [chatBlank, { ...left, leftByRun: undefined }] })?.id)
      .toBe(chatBlank.id);
    // A tab an earlier turn of the chat left gives way to the chat's newer turn.
    const newer = page("PAGE-NEWER", "about:blank");
    const later = browserRun("run-tram-2", TRAM_CHAT, newer.id, "2026-10-29T19:52:00Z");
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [ended, later], pages: [chatBlank, left, newer] })?.id).toBe(newer.id);
  });

  // Two chats' turns, one after the other, while the tab list was read
  // between polls: a tab is the chat's only when the browser names that
  // chat's own turn on it, never because it was in the list while a turn ran.
  it("is never another chat's turn's tab", () => {
    const otherRun = browserRun("0b9e4c4e-58c1-4d5a-9a0e-3f1c7d2a6b44", MAP_CHAT, "PAGE-MAP-BLANK", "2026-10-29T19:48:00Z");
    const mapBlank = page("PAGE-MAP-BLANK", "about:blank");
    const pages = [chatBlank, left, mapBlank];
    expect(chatBrowserTab({ scope: scope(MAP_CHAT), runs: [ended, otherRun], pages })?.id).toBe(mapBlank.id);
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [ended, otherRun], pages })?.id).toBe(left.id);
  });

  it("gives way to a later pick of the person's", async () => {
    const picked = page("PAGE-PICKED", "https://example.com/");
    let latest: ReturnType<typeof useChatBrowserTab> | null = null;
    function Harness() {
      latest = useChatBrowserTab({
        scope: scope(TRAM_CHAT), runs: [ended], pages: [chatBlank, left, picked], canOpenPage: true,
        openPage: vi.fn(async () => null),
      });
      return null;
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      expect(latest!.tab?.id).toBe(left.id);
      await act(async () => latest!.choose(picked.id));
      expect(latest!.tab?.id).toBe(picked.id);
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});

// Local test, Oct 30: the composer aimed a message, and named the Browser
// tab, after the tab in front, which was another chat's page; when the
// browser named none in front, after its first tab.
describe("where a chat's messages go in Instafy's browser", () => {
  const otherChat = page("PAGE-PICO", "https://www.raspberrypi.com/products/raspberry-pi-pico-2/", { isActive: true });
  const own = page("PAGE-GITHUB", "https://github.com/");
  const blank = page("PAGE-BLANK", "about:blank");

  it("is the chat's own tab, never the tab another chat left in front", () => {
    expect(chatBrowserTarget({ tab: own, pages: [otherChat, own], resolved: true, canOpenPage: true }))
      .toEqual({ page: own, bindingPage: own, tabAvailable: true });
    // A chat with no tab yet names no page; a turn sent now gets a tab of its own.
    expect(chatBrowserTarget({ tab: null, pages: [otherChat, own], resolved: true, canOpenPage: true }))
      .toEqual({ page: null, bindingPage: null, tabAvailable: true });
    expect(chatBrowserTarget({ tab: null, pages: [otherChat], resolved: true, canOpenPage: null }))
      .toEqual({ page: null, bindingPage: null, tabAvailable: true });
    // Nor the browser's first tab when the browser names none in front.
    expect(chatBrowserTarget({ tab: null, pages: [{ ...otherChat, isActive: false }, own], resolved: true, canOpenPage: true }).page)
      .toBeNull();
  });

  it("binds a turn to the chat's blank tab without naming it", () => {
    expect(chatBrowserTarget({ tab: blank, pages: [otherChat, blank], resolved: true, canOpenPage: true }))
      .toEqual({ page: null, bindingPage: blank, tabAvailable: true });
  });

  it("keeps the tab in front only for an older browser that cannot open a tab", () => {
    expect(chatBrowserTarget({ tab: null, pages: [otherChat], resolved: true, canOpenPage: false }))
      .toEqual({ page: otherChat, bindingPage: otherChat, tabAvailable: true });
    expect(chatBrowserTarget({ tab: own, pages: [otherChat, own], resolved: true, canOpenPage: false }).page).toBe(own);
    expect(chatBrowserTarget({ tab: null, pages: [{ ...otherChat, isActive: false }], resolved: true, canOpenPage: false }))
      .toEqual({ page: null, bindingPage: null, tabAvailable: false });
  });

  it("offers nothing until the tabs are read, or while they are stale", () => {
    expect(chatBrowserTarget({ tab: own, pages: [own], resolved: false, canOpenPage: true }))
      .toEqual({ page: null, bindingPage: null, tabAvailable: false });
    expect(chatBrowserTarget({ tab: null, pages: [], resolved: true, canOpenPage: true }).tabAvailable).toBe(false);
  });
});

describe("the chat's Browser view", () => {
  const view = (overrides: Partial<Parameters<typeof nextChatBrowserViewStep>[0]>) => nextChatBrowserViewStep({
    onScreen: true, free: true, chatId: MAP_CHAT, tab: null, canOpenTab: true, chatTurnUnderWay: false,
    anyTurnUnderWay: false, state: CHAT_BROWSER_VIEW_START, ...overrides,
  });

  // A chat with no tab of its own used to show whatever tab another chat
  // left in front. It gets its own blank tab, once.
  it("opens a chat's own blank tab instead of showing the tab another chat left in front", () => {
    const first = view({});
    expect(first.step).toBe("open-blank-tab");
    expect(view({ state: first.state }).step).toBe("none");
    expect(view({ canOpenTab: false }).step).toBe("none");
    expect(view({ chatId: null }).step).toBe("none");
  });

  // The browser started again (Clear data, or its machine came back) under
  // new tab ids: the chat's tab is gone. Its view shows only the chat's own
  // tab, so it gets a blank one again instead of a stage left blank.
  it("gives a chat a blank tab again once the tab it had is gone", () => {
    const first = view({});
    expect(first.step).toBe("open-blank-tab");
    const given = view({ tab: { id: "PAGE-BLANK", isActive: true }, state: first.state });
    expect(given.step).toBe("none");
    expect(view({ state: given.state }).step).toBe("open-blank-tab");
  });

  // Octo's turn held the browser while the view was on screen. Once it is
  // done, the chat's tab comes forward, never the neighbour another chat left.
  it("brings the chat's tab forward once whoever else controls the browser is done", () => {
    const tab = { id: "PAGE-CHAT", isActive: false };
    const busy = view({ tab, free: false });
    expect(busy.step).toBe("none");
    const done = view({ tab, state: busy.state });
    expect(done.step).toBe("focus");
    expect(view({ tab, state: done.state }).step).toBe("none");
    // A new tab for the chat (the page its turn left it) comes forward too.
    expect(view({ tab: { id: "PAGE-LEFT", isActive: false }, state: done.state }).step).toBe("focus");
    // Already in front: nothing to do.
    expect(view({ tab: { ...tab, isActive: true } }).step).toBe("none");
    // Off screen and back: again once.
    const off = view({ tab, onScreen: false, state: done.state });
    expect(off.state).toEqual(CHAT_BROWSER_VIEW_START);
    expect(view({ tab, state: off.state }).step).toBe("focus");
  });

  // The view showed the chat's tab, then another chat's turn took the
  // browser and ended on its own page, in front. The view stayed there,
  // possibly on another member's signed-in page.
  it("brings the chat's tab back after another chat's turn, once that turn has ended", () => {
    const tab = { id: "PAGE-CHAT", isActive: true };
    const shown = view({ tab });
    expect(shown.step).toBe("none");
    // Another chat's turn holds the browser: the view shows what it does.
    const busy = view({ tab: { ...tab, isActive: false }, free: false, anyTurnUnderWay: true, state: shown.state });
    expect(busy.step).toBe("none");
    // Control is back while that turn is still under way: not yet.
    const waiting = view({ tab: { ...tab, isActive: false }, anyTurnUnderWay: true, state: busy.state });
    expect(waiting.step).toBe("none");
    // It ended with its page in front: the chat's tab comes back, once.
    const back = view({ tab: { ...tab, isActive: false }, state: waiting.state });
    expect(back.step).toBe("focus");
    expect(view({ tab: { ...tab, isActive: false }, state: back.state }).step).toBe("none");
    // Another person drove the browser for a while: the same once they let go.
    const person = view({ tab, free: false, state: back.state });
    expect(view({ tab: { ...tab, isActive: false }, state: person.state }).step).toBe("focus");
  });

  // The chat's own turn ends where it ends: its page, or the tab the person
  // took over and kept. The view does not pull them off it.
  it("leaves the browser where the chat's own turn left it", () => {
    const tab = { id: "PAGE-CHAT", isActive: true };
    const shown = view({ tab });
    const own = view({ tab: { ...tab, isActive: false }, free: false, chatTurnUnderWay: true, anyTurnUnderWay: true, state: shown.state });
    // The person took over another tab during the turn, which then ended.
    const tookOver = view({ tab: { ...tab, isActive: false }, chatTurnUnderWay: true, anyTurnUnderWay: true, state: own.state });
    expect(tookOver.step).toBe("none");
    expect(view({ tab: { ...tab, isActive: false }, state: tookOver.state }).step).toBe("none");
    // Even when another chat's turn held the browser before this chat's own.
    const other = view({ tab, free: false, anyTurnUnderWay: true, state: shown.state });
    const then = view({ tab: { ...tab, isActive: false }, free: false, chatTurnUnderWay: true, anyTurnUnderWay: true, state: other.state });
    expect(view({ tab: { ...tab, isActive: false }, state: then.state }).step).toBe("none");
  });

  it("knows which browser turns are under way", () => {
    const running = browserRun("run-tram", "chat-tram", "PAGE-CHAT", "2026-10-29T19:47:34Z", { status: "in_progress" });
    const on = (conversationId: string) => ({ conversationId, runtimeId: RUNTIME });
    expect(browserTurnUnderWay([running, MAP_RUN], on("chat-tram"), "chat")).toBe(true);
    expect(browserTurnUnderWay([running, MAP_RUN], on(MAP_CHAT), "chat")).toBe(false);
    expect(browserTurnUnderWay([running, MAP_RUN], on(MAP_CHAT), "any")).toBe(true);
    expect(browserTurnUnderWay([{ ...running, status: "queued" }], on("chat-tram"), "any")).toBe(false);
    expect(browserTurnUnderWay([running], { conversationId: "chat-tram", runtimeId: "runtime-2" }, "any")).toBe(false);
  });
});

// Take over pressed in the first seconds of a chat's browser turn, while the
// page another chat's turn left is still in front behind the chat's blank
// stage, made that page this chat's tab: the chat showed it, its next browser
// turn ran there, and the other chat lost it. And Let Octo continue went on in
// the tab in front, or the browser's first tab when none was named in front.
describe("the page Take over and Let Octo continue act on", () => {
  const PICO = "https://www.raspberrypi.com/products/raspberry-pi-pico-2/";
  const own = page("PAGE-PORTO", "https://www.visitporto.travel/");
  const otherChat = page("PAGE-PICO", PICO, { isActive: true });
  const octo = page("PAGE-OCTO", "https://www.metrodoporto.pt/", { openedBy: "agent", agentTabNumber: 2 });

  it("is the tab in front only while the chat's view shows it", () => {
    expect(chatPageOnScreen([own, otherChat], [own.id])).toBeNull();
    expect(chatPageOnScreen([{ ...own, isActive: true }, { ...otherChat, isActive: false }], [own.id])?.id).toBe(own.id);
    // Octo's own tab of the chat's turn.
    expect(chatPageOnScreen([own, { ...octo, isActive: true }], [own.id, octo.id])?.id).toBe(octo.id);
    // No tab named in front: never the browser's first tab.
    expect(chatPageOnScreen([{ ...otherChat, isActive: false }, own], [own.id])).toBeNull();
    // A view that is not a chat's own (an older browser) acts on the tab in front.
    expect(chatPageOnScreen([own, otherChat], null)).toBe(otherChat);
    expect(chatPageOnScreen([own, { ...otherChat, isActive: false }], null)).toBeNull();
  });

  it("goes on in the chat's own tab while another chat's page, or none, is in front", () => {
    expect(chatBrowserHandoffPage({ pages: [own, otherChat], chatPageIds: [own.id], chatTab: own })).toBe(own);
    expect(chatBrowserHandoffPage({ pages: [{ ...otherChat, isActive: false }, own], chatPageIds: [own.id], chatTab: own }))
      .toBe(own);
    const octoInFront = { ...octo, isActive: true };
    expect(chatBrowserHandoffPage({ pages: [own, octoInFront], chatPageIds: [own.id, octo.id], chatTab: own }))
      .toBe(octoInFront);
    // A chat with no tab of its own sends nothing, never to the page in front.
    expect(chatBrowserHandoffPage({ pages: [otherChat], chatPageIds: [], chatTab: null })).toBeNull();
    // An older browser: the tab in front, else the chat's own tab (where
    // Take over finds the chat's turn), never the browser's first tab.
    expect(chatBrowserHandoffPage({ pages: [own, otherChat], chatPageIds: null, chatTab: own })).toBe(otherChat);
    expect(chatBrowserHandoffPage({ pages: [{ ...otherChat, isActive: false }, own], chatPageIds: null, chatTab: own }))
      .toBe(own);
    expect(chatBrowserHandoffPage({ pages: [{ ...otherChat, isActive: false }], chatPageIds: null, chatTab: null }))
      .toBeNull();
  });

  it("leaves each chat its own tab when the person takes over over a blank stage", () => {
    forgetChatBrowserTabsForTests();
    const porto = browserRun("run-porto", "chat-porto", own.id, "2026-10-30T11:01:56Z", { status: "in_progress" });
    const pico = browserRun("run-pico", "chat-pico", otherChat.id, "2026-10-30T10:55:14Z");
    const runs = [pico, porto];
    const pages = [own, otherChat];
    const portoTab = chatBrowserTab({ scope: scope("chat-porto"), runs, pages });
    const portoView = chatViewPageIds(portoTab?.id ?? null, CHAT_VIEW_TURN_TABS_START);
    // What ChatPanel makes the chat's tab once the take-over is acknowledged.
    expect(chatPageOnScreen(pages, portoView)).toBeNull();
    expect(chatBrowserTab({ scope: scope("chat-porto"), runs, pages })?.id).toBe(own.id);
    expect(chatBrowserTab({ scope: scope("chat-pico"), runs, pages })?.id).toBe(otherChat.id);
    expect(chatBrowserHandoffPage({ pages, chatPageIds: portoView, chatTab: portoTab })?.id).toBe(own.id);
  });
});

// What a chat's Browser view shows of Octo's tabs. Octo's tabs of the chat's
// turn are the chat's while the turn runs. When it ends, the tab Octo read in
// last stays as the chat's page, but the view knew that only from the next
// read of the tab list: meanwhile its stage went blank, and it brought the
// chat's older page forward, then the kept tab again. And a list read before
// another chat's turn ended still named that turn's tab as Octo's when this
// chat's turn started, so the view showed it.
describe("the tabs a chat's Browser view shows", () => {
  const chat = JSON.stringify(["user-1", "project-1", "chat-porto", RUNTIME]);
  const own = page("PAGE-PORTO", "https://www.visitporto.travel/");
  const octo = (isActive = false) => page("PAGE-METRO", "https://www.metrodoporto.pt/", { openedBy: "agent", agentTabNumber: 2, isActive });
  const otherTurns = page("PAGE-PICO", "https://www.raspberrypi.com/products/raspberry-pi-pico-2/", { openedBy: "agent", agentTabNumber: 1, isActive: true });

  it("shows Octo's tabs of the chat's turn, never another chat's turn's that a list read earlier names", () => {
    const idle = nextChatViewTurnTabs(CHAT_VIEW_TURN_TABS_START, { chatKey: chat, pages: [own, otherTurns], chatTurnUnderWay: false });
    expect(chatViewPageIds(own.id, idle)).toEqual([own.id]);
    // The chat's turn starts while the list still names the other turn's tab.
    const starting = nextChatViewTurnTabs(idle, { chatKey: chat, pages: [own, otherTurns], chatTurnUnderWay: true });
    expect(chatViewPageIds(own.id, starting)).toEqual([own.id]);
    // Octo opens a tab of its own for this turn.
    const reading = nextChatViewTurnTabs(starting, { chatKey: chat, pages: [own, { ...otherTurns, isActive: false }, octo(true)], chatTurnUnderWay: true });
    expect(chatViewPageIds(own.id, reading)).toEqual([own.id, "PAGE-METRO"]);
  });

  /** The chat's turn started on its own tab, then read in a tab of Octo's. */
  function readingTurn() {
    const started = nextChatViewTurnTabs(
      { ...CHAT_VIEW_TURN_TABS_START, chatKey: chat },
      { chatKey: chat, pages: [{ ...own, isActive: true }], chatTurnUnderWay: true },
    );
    return nextChatViewTurnTabs(started, { chatKey: chat, pages: [own, octo(true)], chatTurnUnderWay: true });
  }

  it("keeps the tab the chat's turn read in last until the list names it the chat's page", () => {
    const reading = readingTurn();
    // The turn has ended; the list read during the turn still names Octo's tab.
    const ended = nextChatViewTurnTabs(reading, { chatKey: chat, pages: [own, octo(true)], chatTurnUnderWay: false });
    expect(chatViewPageIds(own.id, ended)).toEqual([own.id, "PAGE-METRO"]);
    // The view does not bring the chat's older page forward over it.
    expect(chatViewStepTab({ chatTab: { id: own.id, isActive: false }, pages: [own, octo(true)], turnTabs: ended }))
      .toEqual({ id: "PAGE-METRO", isActive: true });
    // The next list: an ordinary tab, the page the turn left the chat.
    const kept = page("PAGE-METRO", "https://www.metrodoporto.pt/", { isActive: true, leftByRun: "run-metro" });
    const read = nextChatViewTurnTabs(ended, { chatKey: chat, pages: [own, kept], chatTurnUnderWay: false });
    expect(read.tabs).toEqual([]);
    expect(chatViewPageIds(kept.id, read)).toEqual([kept.id]);
    expect(chatViewStepTab({ chatTab: { id: kept.id, isActive: true }, pages: [own, kept], turnTabs: read }))
      .toEqual({ id: kept.id, isActive: true });
    // Had Octo gone back to the chat's page, its tab closes, and that page comes forward.
    const closed = nextChatViewTurnTabs(ended, { chatKey: chat, pages: [{ ...own, isActive: true }], chatTurnUnderWay: false });
    expect(chatViewPageIds(own.id, closed)).toEqual([own.id]);
    // A tab of Octo's that does not close is left over: no chat's.
    const leftover = nextChatViewTurnTabs(ended, { chatKey: chat, pages: [own, { ...octo(true), leftover: true }], chatTurnUnderWay: false });
    expect(chatViewPageIds(own.id, leftover)).toEqual([own.id]);
  });

  it("shows another chat's own turn's tabs only in that chat", () => {
    const reading = readingTurn();
    // The person opens another chat whose turn is under way: Octo's tab of
    // the chat before is not its.
    const other = JSON.stringify(["user-1", "project-1", "chat-pico", RUNTIME]);
    const switched = nextChatViewTurnTabs(reading, { chatKey: other, pages: [own, octo(true)], chatTurnUnderWay: true });
    expect(chatViewPageIds(null, switched)).toEqual([]);
    // Seen from the middle of its turn, with no chat before it: Octo's tabs are that turn's.
    const fresh = nextChatViewTurnTabs(CHAT_VIEW_TURN_TABS_START, { chatKey: other, pages: [own, octo(true)], chatTurnUnderWay: true });
    expect(chatViewPageIds(null, fresh)).toEqual(["PAGE-METRO"]);
  });
});

describe("useChatViewTabs", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useChatViewTabs> | null;
  function Harness(props: Parameters<typeof useChatViewTabs>[0]) {
    latest = useChatViewTabs(props);
    return null;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("follows the chat's turn into Octo's tab, and stays there after it until the list is read again", async () => {
    const own = page("PAGE-PORTO", "https://www.visitporto.travel/");
    const octo = page("PAGE-METRO", "https://www.metrodoporto.pt/", { openedBy: "agent", agentTabNumber: 2, isActive: true });
    const props = { chatKey: "chat-porto", enabled: true, chatTab: own, pages: [own], chatTurnUnderWay: false };
    await act(async () => root.render(<Harness {...props} />));
    expect(latest!.pageIds).toEqual([own.id]);
    await act(async () => root.render(<Harness {...props} chatTurnUnderWay />));
    await act(async () => root.render(<Harness {...props} pages={[own, octo]} chatTurnUnderWay />));
    expect(latest!.pageIds).toEqual([own.id, octo.id]);
    await act(async () => root.render(<Harness {...props} pages={[own, octo]} />));
    expect(latest!.pageIds).toEqual([own.id, octo.id]);
    expect(latest!.stepTab).toEqual({ id: octo.id, isActive: true });
    // An older browser that cannot give a chat a tab: the view shows the tab in front.
    await act(async () => root.render(<Harness {...props} enabled={false} />));
    expect(latest!.pageIds).toBeNull();
  });
});
