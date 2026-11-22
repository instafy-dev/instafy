import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * How ChatPanel leads back to a pause in Instafy's browser that still waits
 * for the person: the row at the chat's end and the chat's Browser tab.
 * ChatPanel is wired to a dozen providers, so mounting it in jsdom is not
 * practical (see chatPanelBrowserTabClose.test.ts). These assertions read the
 * source; useShowBrowserOnRequest.test.tsx covers which pause still waits,
 * BrowserPauseRow.test.tsx the row, useBrowserPauseTab.test.tsx which
 * browser the row and the Browser tab open, and
 * ConversationWorkspaceViews.test.tsx the conversation's view bar.
 *
 * Dogfood, Nov 22: after a reload the morning after Octo paused on a sign-in,
 * its reply had no button, the chat had no Browser tab, and only the
 * composer's + menu could open the browser again.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  expect(source.indexOf(start, from + 1)).toBe(-1);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

/** ChatPanel's call of useBrowserPauseTab, from the names it takes back to its arguments. */
function pauseTabCall(): string {
  const call = section(chatPanel, "offersTab: pauseOffersBrowserTab,", "});");
  expect(call).toContain("} = useBrowserPauseTab({");
  return call;
}

describe("ChatPanel's way back to a paused browser task", () => {
  it("reads the pause from the chat's latest messages, for the person whose turn it was", () => {
    expect(chatPanel).toContain("openBrowserPause(recentMessages, runRecords, currentUserId)");
  });

  it("puts one row at the chat's end while Instafy's browser is not on screen", () => {
    const row = section(chatPanel, "<BrowserPauseRow", "/>");
    expect(row).toContain("pause={openPause}");
    expect(row).toContain('browserVisible={browserVisible && browserTransport === "shared"}');
    expect(row).toContain("onOpen={openBrowserForPause}");
    // At the end of the transcript, with the rows that stand in for a turn's
    // status, and never under an earlier part of the chat shown around a message.
    const tail = section(chatPanel, "{openPause && !messageTargetActive ? (", "</ChatColumn>");
    expect(tail).toContain("<WorkspaceStartStalledRow");
  });

  it("only brings Instafy's browser forward, and sends Octo nothing", () => {
    const pauseTab = pauseTabCall();
    expect(pauseTab).toContain("open: openBrowserForPause,");
    expect(pauseTab).toContain("pause: openPause,");
    expect(pauseTab).toContain("revealInstafyBrowser: revealSharedBrowserApproval,");
    expect(pauseTab).toContain("selectView: handleBrowserSubtabChange,");
  });

  it("keeps the chat's Browser tab while the pause waits, unless the person closed the view here", () => {
    const pauseTab = pauseTabCall();
    expect(pauseTab).toContain("offersTab: pauseOffersBrowserTab,");
    expect(pauseTab).toContain("hasView: hasBrowserView,");
    expect(pauseTab).toContain("viewStateHydrated: browserSessionStateHydrated,");
    expect(pauseTab).toContain("viewClosed: browserViewClosed,");
    expect(chatPanel).toContain("const browserTabShown = hasBrowserView || pauseOffersBrowserTab;");
    const tabs = section(chatPanel, "const resourceTabs: ConversationSurface[] = [", "...surfaces.files.map(");
    expect(tabs).toContain("...(browserTabShown ? [{");
    expect(tabs).toContain("onClose: closeBrowserTab,");
    // The conversation's view bar shows it too, without counting it as an open view.
    const published = section(chatPanel, "setConversationBrowser(surfaceScope, {", "});");
    expect(published).toContain("available: hasBrowserView,");
    expect(published).toContain("offered: pauseOffersBrowserTab,");
    // Beside the composer as well, where a phone shows the chat's views.
    expect(chatPanel).toContain("showComposerNavigationButton && (hasResources || pauseOffersBrowserTab ||");
  });

  // Review, Nov 22: on Desktop, which shows its own browser for a chat with
  // no view saved, picking the tab opened that browser, with no pause in it.
  it("opens Instafy's browser for the tab, from the chat's own tabs and from the conversation's view bar", () => {
    const pauseTab = pauseTabCall();
    expect(pauseTab).toContain("select: selectChatView,");
    expect(chatPanel.match(/onSelect=\{selectChatView\}/g)).toHaveLength(2);
    expect(chatPanel).not.toContain("onSelect={handleBrowserSubtabChange}");
    expect(pauseTab).toContain(
      'browserPicked: conversationWorkspace && !jobThread && surfaces.activeId === "browser" && !browserSessionOpen,',
    );
    // A hidden browser's own tab opens its view where it is, as before.
    const hidden = section(
      chatPanel,
      'if (conversationWorkspace && !jobThread && surfaces.activeId === "browser" && hasHiddenBrowserSession && !browserSessionOpen) {',
      "}, [",
    );
    expect(hidden).toContain("handleToggleBrowserSession();");
    expect(hidden).not.toContain("pauseOffersBrowserTab");
  });

  it("tells the Browser view which tab the pause is on", () => {
    expect(chatPanel).toContain("pausedPageId={openPause?.pageId ?? null}");
  });
});
