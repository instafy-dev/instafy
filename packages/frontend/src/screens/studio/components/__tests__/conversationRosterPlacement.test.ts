import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Roster placement is covered by the rendered StudioTopBar tests. These source
 * checks retain the transcript header's own placement guard. */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanelFile = path.resolve(componentsDir, "ChatPanel.tsx");

describe("transcript header", () => {
  const chatPanel = fs.readFileSync(chatPanelFile, "utf8");

  // A local test, on a phone and on a desktop: a sticky "octo" chip sat over
  // the first row, right above that turn's own "octo · 3m ago" header.
  it("has no sticky speaker chip: each turn's own header names who wrote it", () => {
    expect(chatPanel).not.toMatch(/StickyOverlay|stickyChatSpeaker|chat-sticky-speaker-row/u);
  });

  it("keeps the roster row outside the message scroller", () => {
    const rowStart = chatPanel.indexOf('data-testid="chat-conversation-roster-row"');
    const rosterTag = chatPanel.indexOf("<ConversationRoster", rowStart);
    const transcriptTag = chatPanel.lastIndexOf("<ChatTranscriptViewport", rowStart);
    expect(rowStart).toBeGreaterThan(-1);
    expect(rosterTag).toBeGreaterThan(rowStart);
    // The viewport renders its header as a sibling of the role=log scroller.
    expect(transcriptTag).toBeGreaterThan(-1);
    expect(transcriptTag).toBeLessThan(rowStart);
  });
});
