import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * How ChatPanel closes a chat's Browser view: the Browser tab's close, in the
 * chat's own view bar and in the conversation's (ConversationWorkspaceViews).
 * ChatPanel is wired to a dozen providers, so mounting it in jsdom is not
 * practical (see chatPanelSharedBrowserLateAttach.test.ts). These assertions
 * read the source; useChatBrowserSessionState.test.tsx covers what closing
 * and opening again do to the browser session, conversationSurfaces.test.tsx
 * which view comes forward, and the view bar tests the tab and its keys.
 *
 * Owner report, Nov 20: Desktop showed a chat's Browser tab, with its address
 * bar, that nothing could close.
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

describe("ChatPanel's Browser tab close", () => {
  it("closes only the view: Chat comes forward, and the browser and a turn running in it go on", () => {
    const close = section(chatPanel, "const closeBrowserTab = useCallback(() => {", "\n  }, [");
    // Nothing else: no stop, cancel, take over or pause of Octo's turn, and no
    // change to the machine the browser is on.
    expect(close.split("\n").slice(1).map((line) => line.trim())).toEqual([
      "updateSurfaces(surfaceScope, closeConversationBrowser);",
      "closeBrowserView();",
    ]);
  });

  it("puts the close on the chat's Browser tab, in its own view bar and the conversation's", () => {
    const browserTab = section(chatPanel, "const resourceTabs: ConversationSurface[] = [", "...surfaces.files.map(");
    expect(browserTab).toContain("onClose: closeBrowserTab,");
    const published = section(chatPanel, "setConversationBrowser(surfaceScope, {", "});");
    expect(published).toContain("available: hasBrowserView,");
    expect(published).toContain("close: closeBrowserTab,");
  });

  it("leaves Octo's browser cards to the person while the view stays closed", () => {
    expect(chatPanel).toContain(
      "if (browserSessionStateHydrated && browserViewClosed) markBrowserAutoStartDeclined(browserRequestIdentity);",
    );
  });

  it("opens the view again from the composer, and when Octo pauses on the person's fields", () => {
    // The composer's "+" lists Open browser once the tab is gone.
    expect(chatPanel).toContain("browserOpen: browserSessionOpen || hasHiddenBrowserSession,");
    const subtab = section(chatPanel, "const handleBrowserSubtabChange = useCallback(", "\n  );");
    expect(subtab).toContain('if (tab === "browser" && !browserSessionOpen) {\n        handleToggleBrowserSession();');
    expect(chatPanel).toContain('const showBrowserForHumanInput = useCallback(() => handleBrowserSubtabChange("browser"), [handleBrowserSubtabChange]);');
  });
});
