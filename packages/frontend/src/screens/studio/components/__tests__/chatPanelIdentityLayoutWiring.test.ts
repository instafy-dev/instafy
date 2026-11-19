import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What ChatPanel hands resolveChatTranscriptIdentityLayout as the chat's
 * history. ChatPanel is wired to a dozen providers, so mounting it in jsdom is
 * not practical (see chatPanelTurnEngineWiring.test.ts). These assertions read
 * the source; chatTranscriptIdentityLayout.test.ts covers the rule itself.
 *
 * Waiting for the complete history kept every one-on-one chat of more than a
 * few turns in the participants layout, with Octo's face and name on each
 * reply: history pages fill with hidden progress rows, so a page of 50 rows
 * holds only a few turns.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function resolverCall(): string {
  return between(chatPanel, "resolveChatTranscriptIdentityLayout({", "}), [");
}

describe("ChatPanel's history for the transcript identity layout", () => {
  it("decides once the newest page is in, for this chat's own transcript", () => {
    const call = resolverCall();
    const history = between(call, "historyLoaded:", "messages:");
    for (const required of [
      "Boolean(activeConversationEntry)",
      "hasResolvedRecentHistory",
      "!recentHistoryError",
      "!messageTargetActive",
      "!jobThread",
    ]) {
      expect(history).toContain(required);
    }
    expect(call).toContain("messages: recentMessages,");
  });

  it("does not wait for older pages or switch while one is loading", () => {
    const call = resolverCall();
    expect(call).not.toMatch(/\bhistoryComplete\b/);
    const history = between(call, "historyLoaded:", "messages:");
    // isRecentHistoryLoading is the older page on its way (isFetchingNextPage).
    expect(history).not.toMatch(/\bhasMoreRecentHistory\b/);
    expect(history).not.toMatch(/\bisRecentHistoryLoading\b/);
  });
});
