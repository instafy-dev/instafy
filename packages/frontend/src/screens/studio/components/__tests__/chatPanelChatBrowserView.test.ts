import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * How ChatPanel joins a chat's Browser view to the chat's own tabs
 * (chatBrowserTab.ts). ChatPanel is wired to a dozen providers, so mounting it
 * in jsdom is not practical (see chatPanelSharedBrowserLateAttach.test.ts).
 * These assertions read the source; chatBrowserTab.test.tsx covers what the
 * helpers decide.
 *
 * Local test, Oct 30: Take over pressed while another chat's page was still
 * in front behind the chat's blank stage made that page the chat's tab, and
 * Let Octo continue went on in the tab in front, or in the browser's first
 * tab when the browser named none in front.
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

describe("ChatPanel's Take over and Let Octo continue", () => {
  it("makes a tab the person takes over the chat's only when the chat's view shows it", () => {
    const takeOver = section(chatPanel, "const takeOverSharedBrowser = useCallback(", "\n  }, [");
    expect(takeOver).toContain("const taken = chatPageOnScreen(sharedBrowserChromePages, chatViewPageIds);");
    expect(takeOver).not.toContain("page.isActive");
  });

  it("lets Octo continue in the chat's own tab, never another chat's page or the browser's first tab", () => {
    expect(chatPanel).toMatch(
      /const browserHandoffPage = sharedBrowserChrome\n\s*\? chatBrowserHandoffPage\(\{ pages: sharedBrowserChrome\.pages, chatPageIds: chatViewPageIds, chatTab: chatBrowserTab\.tab \}\)\n\s*: null;/,
    );
    expect(chatPanel).not.toContain("pages[0]");
  });
});

describe("ChatPanel's chat Browser view", () => {
  it("shows the chat's tabs, and brings forward the tab its view keeps", () => {
    const view = section(chatPanel, "const chatView = useChatViewTabs({", "});");
    expect(view).toContain("chatTab: chatBrowserTab.tab,");
    expect(view).toContain("pages: sharedBrowserChromePages,");
    expect(view).toContain("chatTurnUnderWay: chatBrowserTurnUnderWay,");
    expect(chatPanel).toContain("chatPageIds={chatViewPageIds}");
    expect(chatPanel).toContain("tab: chatViewStepTabId ? { id: chatViewStepTabId, isActive: chatViewStepTabActive } : null,");
    expect(chatPanel).toContain("else if (step === \"focus\" && chatViewStepTabId) void focusSharedBrowserPageQuietly(chatViewStepTabId)");
  });
});

// Seen Oct 30: no browser card opened by itself while the person
// stayed in Chat. The card waited for the page Take over acts on, which a
// chat with no tab yet has only while its Browser view is on screen.
// chatBrowserCardStart.test.tsx covers the card with chatBrowserCardReady, and
// useBrowserSessionPages.test.tsx the reads with sharedBrowserPagesFast; these
// read that ChatPanel uses both.
describe("ChatPanel's browser cards", () => {
  it("send a card's turn once a tab is there for it, with the chat's Browser view off screen too", () => {
    expect(chatPanel).toContain("sharedReady: chatBrowserCardReady({ runtimeId: resolvedBrowserRuntimeId, target: chatBrowserMessageTarget }),");
    expect(chatPanel).not.toMatch(/sharedReady:[^\n]*browserHandoffPage/);
    // The page on screen stays what Take over and Let Octo continue act on.
    expect(chatPanel).toContain("page: browserHandoffPage,");
  });

  it("read the browser's tabs at the fast pace while a card opens it", () => {
    expect(chatPanel).toMatch(/sharedBrowserPagesPollFast: sharedBrowserPagesFast\(\{\n\s*runActive: spaceRunActive,\n\s*cardOpening: browserCardOpening,\n\s*presence: sharedBrowserPresence,\n\s*\}\),/);
    expect(chatPanel).toContain("() => anyBrowserCardOpening(browserRequestState.cardStates),");
    expect(chatPanel).toContain("setBrowserCardOpening(browserCardOpeningNow);");
  });
});
