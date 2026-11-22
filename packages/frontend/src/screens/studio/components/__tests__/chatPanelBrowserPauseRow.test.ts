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
 * BrowserPauseRow.test.tsx the row, and ConversationWorkspaceViews.test.tsx
 * the conversation's view bar.
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
    const press = section(chatPanel, "const openBrowserForPause = useCallback(() => {", "\n  }, [");
    expect(press.split("\n").slice(1).map((line) => line.trim())).toEqual([
      "revealSharedBrowserApproval();",
      "showBrowserForHumanInput();",
    ]);
  });

  it("keeps the chat's Browser tab while the pause waits, unless the person closed the view here", () => {
    expect(chatPanel).toContain(
      "const pauseOffersBrowserTab = openPause !== null && !hasBrowserView && browserSessionStateHydrated && !browserViewClosed;",
    );
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

  it("opens the view when that tab is selected in the conversation's view bar", () => {
    const opens = section(chatPanel, "conversationWorkspace && !jobThread && surfaces.activeId === \"browser\" && !browserSessionOpen &&", "}, [");
    expect(opens).toContain("(hasHiddenBrowserSession || pauseOffersBrowserTab)");
    expect(opens).toContain("handleToggleBrowserSession();");
  });

  it("tells the Browser view which tab the pause is on", () => {
    expect(chatPanel).toContain("pausedPageId={openPause?.pageId ?? null}");
  });
});
