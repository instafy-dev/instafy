// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";
import type { BrowserSessionPage } from "../browserSessionPages";
import {
  CHAT_BROWSER_TAB_COPY,
  chatBrowserTab,
  forgetChatBrowserTabsForTests,
  lastChatBrowserTab,
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
