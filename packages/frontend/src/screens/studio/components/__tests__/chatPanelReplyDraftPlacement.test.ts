import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A reply's draft grows in its turn's own row, where the reply lands
 * (placeReplyDrafts). A local test, Nov 3: as ten replies landed, a second Octo
 * row showed for 0.5 to 6 s: ChatPanel added each draft after the transcript,
 * as a row of its own. ChatPanel is wired to a dozen providers, so mounting it
 * in jsdom is not practical (see chatPanelSharedBrowserLateAttach.test.ts):
 * this reads what ChatPanel draws, and replyDraftOneRow.test.tsx covers what
 * the rows show for it.
 */
const componentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

describe("ChatPanel's transcript while a reply is written", () => {
  it("places each draft in its turn's row, and draws and scrolls that transcript", () => {
    const start = chatPanel.indexOf("const transcriptMessages = useMemo(");
    expect(start).toBeGreaterThan(-1);
    const transcript = chatPanel.slice(start, chatPanel.indexOf("]);", start));
    expect(transcript).toContain("placeReplyDrafts(displayedMessages, replyDrafts.messages)");
    expect(chatPanel).not.toMatch(/\[\.\.\.displayedMessages, \.\.\.replyDrafts\.messages\]/);
    expect(chatPanel).toMatch(/<ConversationMessageRows[\s\S]*?messages=\{transcriptMessages\}/);
    expect(chatPanel).toContain("displayedMessages: transcriptMessages,");
  });
});
