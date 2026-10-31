import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A message from the chat right after a browser turn. A local test, Oct 31:
 * for ten minutes after a browser turn, every message from the chat went to
 * the browser, whose turn cannot build, and the composer said "Goes to
 * Instafy's browser" meanwhile. The routing step decides that now, as for any
 * message, and a card it posts for the message goes on from the person's own
 * browser turn before it, while the browser is open in this chat: by itself,
 * in that turn's tab, naming it so the sites the person allowed there keep
 * their OK. ChatPanel is wired to a dozen providers, so mounting it in jsdom
 * is not practical (see chatPanelSharedBrowserLateAttach.test.ts): this reads
 * the source for what ChatPanel passes in, and browserHandoffRouting.test.ts
 * (routedBrowserFollowUp) and useChatBrowserRequest.test.tsx cover what the
 * parts decide.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function block(startText: string, endText: string): string {
  const start = chatPanel.indexOf(startText);
  expect(start).toBeGreaterThan(-1);
  const end = chatPanel.indexOf(endText, start);
  expect(end).toBeGreaterThan(start);
  return chatPanel.slice(start, end);
}

describe("ChatPanel after a browser turn", () => {
  it("sends the chat's next message as any other, and the composer says nothing about the browser", () => {
    expect(chatPanel).not.toContain("resolveSharedBrowserFollowUp");
    expect(chatPanel).not.toContain("browserFollowUp=");
  });

  // A check that looked for a few names only still passed with no pages, or
  // another id for the conversation, and either one carries nothing over: so
  // it checks each one.
  it("reads the person's browser turn a routed card goes on from in this chat's own browser", () => {
    const resolver = block(
      "const resolveRoutedBrowserFollowUp = useCallback((routedJobId: string) => routedBrowserFollowUp(runRecords, {",
      "}, routedJobId), [",
    );
    for (const field of [
      "open: browserTransport === \"shared\" && browserSessionOpen,",
      "conversationId: activeConversationEntry?.controllerId ?? null,",
      "runtimeId: resolvedBrowserRuntimeId,",
      "userId: currentUserId,",
      "pages: sharedBrowserChromePages,",
      "takenByAnotherChat: chatBrowserTab.takenByAnotherChat,",
    ]) {
      expect(resolver).toContain(field);
    }
    const request = block("const browserRequestState = useChatBrowserRequest({", "\n  });\n");
    expect(request).toContain("followUp: resolveRoutedBrowserFollowUp,");
  });

  it("sends that card's turn in that turn's tab, and any other card's in the chat's own tab", () => {
    const continueTask = block("continueTask: (transport, message, extras) => {", "\n    },\n");
    expect(continueTask).toContain("const followUpTab = extras.tab;");
    expect(continueTask).toContain(
      "return browserHandoff.continueShared(message, extras, followUpTab ? async () => followUpTab : resolveChatBrowserTab);",
    );
  });

  it("opens nothing for a turn that goes on in the browser open in this chat", () => {
    const activate = block("activate: (transport, plan) => {", "\n    },\n");
    const early = activate.indexOf("if (plan?.kind === \"continue\") return;");
    expect(early).toBeGreaterThan(-1);
    for (const opens of ["resumeBrowserSession(", "openBrowserSession(", "setBrowserSubtab(", "setBrowserTransport("]) {
      expect(activate.indexOf(opens)).toBeGreaterThan(early);
    }
  });
});
