// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import type { BrowserSessionPage } from "../browserSessionPages";
import {
  CHAT_BROWSER_TAB_COPY,
  CHAT_BROWSER_VIEW_START,
  chatBrowserTab,
  forgetChatBrowserTabsForTests,
  lastChatBrowserTab,
  nextChatBrowserViewStep,
  noteOctoRunTabs,
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
// blank: the runtime keeps the tab Octo worked in last open, and that tab is
// the chat's page once the turn has ended.
describe("the page a browser turn leaves its chat", () => {
  const TRAM_CHAT = "chat-tram";
  const chatBlank = page("PAGE-CHAT", "about:blank");
  const metro = page("TAB-METRO", "https://www.metro.example/maps", { openedBy: "agent", agentTabNumber: 1 });
  const planner = page("TAB-PLANNER", "https://www.trams.example/planner", { openedBy: "agent", agentTabNumber: 2, isActive: true });
  const running = browserRun("run-tram", TRAM_CHAT, chatBlank.id, "2026-10-29T19:47:34Z", { status: "in_progress" });
  const ended = { ...running, status: "success" as const };

  beforeEach(() => forgetChatBrowserTabsForTests());

  it("is the tab Octo worked in last, once the turn has ended and the tab is no longer Octo's", () => {
    expect(noteOctoRunTabs({ scope: scope(TRAM_CHAT), runs: [running], pages: [chatBlank, metro, planner] })).toBe(true);
    // Seen again, nothing new.
    expect(noteOctoRunTabs({ scope: scope(TRAM_CHAT), runs: [running], pages: [chatBlank, metro, planner] })).toBe(false);
    // While the turn runs, the chat's tab is the one it was sent for.
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [running], pages: [chatBlank, metro, planner] })?.id)
      .toBe(chatBlank.id);
    // Ended, with the tab still badged as Octo's (its closing pass is not done): not yet.
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [ended], pages: [chatBlank, metro, planner] })?.id)
      .toBe(chatBlank.id);
    // The run let go: the planner tab stayed open as an ordinary tab, the other closed.
    const kept = { ...planner, openedBy: undefined, agentTabNumber: undefined };
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [ended], pages: [chatBlank, kept] })?.id).toBe(kept.id);
    // Never another chat's.
    expect(chatBrowserTab({ scope: scope(MAP_CHAT), runs: [MAP_RUN, ended], pages: [LISBON, chatBlank, kept] })?.id)
      .toBe(LISBON.id);
  });

  it("is the chat's own tab when every tab of Octo's closed", () => {
    noteOctoRunTabs({ scope: scope(TRAM_CHAT), runs: [running], pages: [chatBlank, metro, planner] });
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [ended], pages: [chatBlank] })?.id).toBe(chatBlank.id);
  });

  it("is never taken from tabs seen while two turns were under way", () => {
    const other = browserRun("run-other", MAP_CHAT, LISBON.id, "2026-10-29T19:47:40Z", { status: "in_progress" });
    expect(noteOctoRunTabs({ scope: scope(TRAM_CHAT), runs: [running, other], pages: [chatBlank, LISBON, metro, planner] }))
      .toBe(false);
    const kept = { ...planner, openedBy: undefined, agentTabNumber: undefined };
    expect(chatBrowserTab({ scope: scope(TRAM_CHAT), runs: [ended], pages: [chatBlank, kept] })?.id).toBe(chatBlank.id);
  });

  it("gives way to a later pick of the person's", async () => {
    noteOctoRunTabs({ scope: scope(TRAM_CHAT), runs: [running], pages: [chatBlank, metro, planner] });
    const kept = { ...planner, openedBy: undefined, agentTabNumber: undefined };
    const picked = page("PAGE-PICKED", "https://example.com/");
    let latest: ReturnType<typeof useChatBrowserTab> | null = null;
    function Harness() {
      latest = useChatBrowserTab({
        scope: scope(TRAM_CHAT), runs: [ended], pages: [chatBlank, kept, picked], canOpenPage: true,
        openPage: vi.fn(async () => null),
      });
      return null;
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      expect(latest!.tab?.id).toBe(kept.id);
      await act(async () => latest!.choose(picked.id));
      expect(latest!.tab?.id).toBe(picked.id);
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});

describe("the chat's Browser view", () => {
  const view = (overrides: Partial<Parameters<typeof nextChatBrowserViewStep>[0]>) => nextChatBrowserViewStep({
    onScreen: true, free: true, chatId: MAP_CHAT, tab: null, canOpenTab: true, state: CHAT_BROWSER_VIEW_START, ...overrides,
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
});
