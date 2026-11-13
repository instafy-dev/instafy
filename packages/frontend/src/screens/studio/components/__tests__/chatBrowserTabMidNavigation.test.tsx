// @vitest-environment jsdom

// The Studio CI journey's white stage: a new chat's blank tab went to a page,
// one read of the browser's tabs listed that tab with no address on the way,
// and the chat's Browser view opened a new blank tab and showed that one
// instead of the page that arrived. The tabs hook, the chat's tab and its
// view as ChatPanel wires them, with only the browser's answers stubbed: they
// go through the real payload mapper.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchCapabilitiesMock,
  fetchPagesMock,
  focusPageMock,
  openPageMock,
} = vi.hoisted(() => ({
  fetchCapabilitiesMock: vi.fn(),
  fetchPagesMock: vi.fn(),
  focusPageMock: vi.fn(),
  openPageMock: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    browserSessions: {
      commandPage: vi.fn(),
      fetchCapabilities: fetchCapabilitiesMock,
      fetchPages: fetchPagesMock,
      focusPage: focusPageMock,
      openPage: openPageMock,
      isCapabilitiesIncompatibleError: () => false,
      isUnavailableError: () => false,
    },
  },
}));

import { mapRuntimeBrowserSessionPagesPayload } from "../../../../services/runtimeController/browserSession";
import { useBrowserSessionPages } from "../useBrowserSessionPages";
import {
  forgetChatBrowserTabsForTests,
  newChatBrowserTabId,
  useChatBrowserTab,
  useChatViewTabs,
} from "../chatBrowserTab";
import { useChatBrowserView } from "../useChatBrowserView";

const CHAT = newChatBrowserTabId("local-chat-1");
const SCOPE = { userId: "user-1", projectId: "project-1", conversationId: CHAT, runtimeId: "runtime-1" };
const SCOPE_KEY = JSON.stringify([SCOPE.userId, SCOPE.projectId, SCOPE.conversationId, SCOPE.runtimeId]);
const FIXTURE = "http://studio-browser-fixture.test/";

/** The browser's one tab, in front, as its `/browser/pages` lists it. */
function listed(url: string, label: string) {
  return {
    pages: [{
      id: "PAGE-1",
      url,
      host: url.startsWith("http") ? new URL(url).host : "",
      label,
      title: null,
      loading: false,
      isActive: true,
      canGoBack: false,
      canGoForward: false,
    }],
    activePageId: "PAGE-1",
  };
}

describe("a chat's tab the browser lists with no address on its way to a page", () => {
  let container: HTMLDivElement;
  let root: Root;
  let payload: unknown;
  let pages: ReturnType<typeof useBrowserSessionPages>;
  let chatTab: ReturnType<typeof useChatBrowserTab>;
  let shownIds: string[] | null;

  function Harness() {
    pages = useBrowserSessionPages({
      enabled: true,
      browserSessionId: "browser-surface-1",
      projectId: SCOPE.projectId,
      preferRuntimeId: SCOPE.runtimeId,
      includePlaceholder: true,
    });
    const canOpenPage = pages.capabilities ? pages.capabilities.controls.newPage === true : null;
    chatTab = useChatBrowserTab({
      scope: SCOPE, runs: [], pages: pages.pages, canOpenPage, openPage: pages.openPage, newChatId: CHAT,
    });
    const view = useChatViewTabs({
      chatKey: SCOPE_KEY, enabled: canOpenPage !== false, chatTab: chatTab.tab, pages: pages.pages,
      chatTurnUnderWay: false,
    });
    shownIds = view.pageIds;
    useChatBrowserView({
      scopeKey: SCOPE_KEY, onScreen: true, free: true, chatId: CHAT,
      tabId: view.stepTab?.id ?? null, tabActive: view.stepTab?.isActive === true,
      canOpenTab: pages.resolved && canOpenPage !== null,
      chatTurnUnderWay: false, anyTurnUnderWay: false,
      resolveTab: chatTab.resolveForTurn, focusTab: pages.focusPage,
    });
    return null;
  }

  async function settle() {
    await act(async () => {
      for (let step = 0; step < 6; step += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function read(next: unknown) {
    payload = next;
    await act(async () => { await pages.refresh(); });
    await settle();
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetChatBrowserTabsForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    payload = listed("about:blank", "New tab");
    fetchPagesMock.mockReset().mockImplementation(async () => mapRuntimeBrowserSessionPagesPayload(payload));
    fetchCapabilitiesMock.mockReset().mockResolvedValue({
      version: 2,
      viewerKinds: ["cdp-screencast"],
      preferredViewer: "cdp-screencast",
      viewportOnly: true,
      controls: { navigate: true, history: true, reload: true, focusPage: true, newPage: true },
    });
    openPageMock.mockReset().mockResolvedValue("PAGE-2");
    focusPageMock.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the tab the chat's, and its view on it, without opening another", async () => {
    await act(async () => root.render(<Harness />));
    await settle();
    // The view gave the new chat the browser's one blank tab.
    expect(chatTab.tab?.id).toBe("PAGE-1");
    expect(shownIds).toEqual(["PAGE-1"]);

    // The person goes to a page, and one read catches the tab on its way.
    await read(listed("", "Browser page"));
    expect(openPageMock).not.toHaveBeenCalled();
    expect(chatTab.tab?.id).toBe("PAGE-1");
    expect(shownIds).toEqual(["PAGE-1"]);
    expect(pages.pages).toEqual([expect.objectContaining({ id: "PAGE-1", url: "", isActive: true })]);
    // A browser turn sent meanwhile goes to the chat's tab too.
    let target: unknown = null;
    await act(async () => { target = await chatTab.resolveForTurn(); });
    expect(target).toEqual({ id: "PAGE-1", url: "", host: "", label: "Browser page" });
    expect(openPageMock).not.toHaveBeenCalled();

    await read(listed(FIXTURE, "studio-browser-fixture.test"));
    expect(chatTab.tab).toMatchObject({ id: "PAGE-1", url: FIXTURE });
    expect(shownIds).toEqual(["PAGE-1"]);
    expect(openPageMock).not.toHaveBeenCalled();
    expect(focusPageMock).not.toHaveBeenCalled();
  });
});
