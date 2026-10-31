import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A message from the chat right after a browser turn. A local test, Oct 31:
 * for ten minutes after a browser turn, every message from the chat went to
 * the browser, whose turn cannot build, and the composer said "Goes to
 * Instafy's browser" meanwhile. The routing step decides that now, as for any
 * message, and a card it posts for the message goes on from the browser turn
 * before it: in that turn's tab, naming it, so the sites the person allowed
 * there keep their OK. ChatPanel is wired to a dozen providers, so mounting it
 * in jsdom is not practical (see chatPanelSharedBrowserLateAttach.test.ts):
 * this reads the source, and browserHandoffRouting.test.ts,
 * useChatBrowserRequest.test.tsx and useChatSubmitFlowBrowserFollowUp.test.tsx
 * cover what the parts decide.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

describe("ChatPanel after a browser turn", () => {
  it("sends the chat's next message as any other, and the composer says nothing about the browser", () => {
    expect(chatPanel).not.toContain("resolveSharedBrowserFollowUp");
    expect(chatPanel).not.toContain("browserFollowUp=");
  });

  it("carries the browser turn of a card the routing step posted on from the browser turn before it", () => {
    const start = chatPanel.indexOf("continueTask: (transport, message, extras) => {");
    expect(start).toBeGreaterThan(-1);
    const end = chatPanel.indexOf("\n    },\n", start);
    expect(end).toBeGreaterThan(start);
    const continueTask = chatPanel.slice(start, end);
    expect(continueTask).toContain("const followUp = extras.routedJobId");
    expect(continueTask).toContain("? sharedBrowserFollowUp(");
    expect(continueTask).toContain("routedJobId: extras.routedJobId,");
    expect(continueTask).toContain("takenByAnotherChat: chatBrowserTab.takenByAnotherChat,");
    expect(continueTask).toContain("[BROWSER_CONTINUES_RUN_METADATA_KEY]: followUp.runId");
    expect(continueTask).toContain("}, async () => followUpTab);");
    // Any other card's turn runs in the chat's own tab, with nothing carried.
    expect(continueTask).toContain("if (!followUp) return browserHandoff.continueShared(message, extras, resolveChatBrowserTab);");
  });
});
