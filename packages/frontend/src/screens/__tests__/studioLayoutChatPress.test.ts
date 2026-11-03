import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A press on a chat of the open space opens it in the press itself
 * (openChat.ts): an open chat's tab, and View on a prompt waiting in another
 * chat. Through the address alone, React Router renders the change later, as a
 * transition, and the chat and its tab followed in effects after it. A local
 * test, Nov 3: right after a press on the Seville chat's tab, the GitHub chat's
 * sign-in page with "Let Octo continue" stayed on screen for up to a quarter
 * second. StudioLayout is wired to dozens of providers, so mounting it in
 * jsdom is not practical: this reads what StudioLayout wires in, and
 * chatSwitchFrames.test.tsx covers what openChat and the tabs do with it.
 */
const screensDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const layout = fs.readFileSync(path.resolve(screensDir, "StudioLayout.tsx"), "utf8");

function block(startText: string, endText: string): string {
  const start = layout.indexOf(startText);
  expect(start).toBeGreaterThan(-1);
  const end = layout.indexOf(endText, start);
  expect(end).toBeGreaterThan(start);
  return layout.slice(start, end);
}

describe("StudioLayout's presses on a chat", () => {
  it("opens a chat of this space in the press, with a history entry, and another space's through the address", () => {
    const opener = block("const openChatFromPress = useCallback(", "\n  // The chats where a prompt");
    expect(opener).toContain("openChat(destination, {");
    expect(opener).toContain("navigate: navigateToDestination,");
    expect(opener).toMatch(
      /open: \(conversationId, openOptions\) => runStudioNavigation\(\(\) => \{\s*requestHistoryPush\(\);\s*openConversationTab\(conversationId, openOptions\);\s*\}\)/,
    );
  });

  it("opens the chat of an open chat's tab through it", () => {
    const tabs = block("const organizationTabActions = {", "\n    // Every listed tab is the open space's.");
    expect(tabs).toMatch(/onSelect: \(id: string\) => \{[\s\S]*openChatFromPress\(\{ kind: "conversation", projectId: tab\.projectId,/);
    expect(tabs).not.toContain("navigateToDestination(");
  });

  it("opens the chat of View on a prompt waiting in another chat through it, and anything else through the address", () => {
    const view = block("const viewChatAwaitingOk = useCallback(", "\n  const organizationTabActions = {");
    expect(view).toMatch(
      /navigate: \(destination\) => destination\.kind === "conversation"\s*\? openChatFromPress\(destination, \{ restoreWorkspace: false \}\)\s*: navigateToDestination\(destination\)/,
    );
  });

  // chatSwitchFrames.test.tsx draws the chat area as StudioLayout keys it.
  it("mounts the chat area once per active tab", () => {
    expect(layout).toContain('<div key={activeWorkspaceTab?.id ?? "empty"} className="h-full"');
  });
});
