import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Roster placement is covered by the rendered StudioTopBar tests. These source
 * checks retain the transcript's independent sticky-speaker placement guard. */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanelFile = path.resolve(componentsDir, "ChatPanel.tsx");

describe("transcript speaker placement", () => {
  const chatPanel = fs.readFileSync(chatPanelFile, "utf8");

  describe("sticky speaker pill lives in the transcript header", () => {
    const rowStart = chatPanel.indexOf('data-testid={conversationWorkspace && !jobThread ? "chat-sticky-speaker-row"');
    const rosterTag = chatPanel.indexOf("<ConversationRoster", rowStart);
    const transcriptTag = chatPanel.lastIndexOf("<ChatTranscriptViewport", rowStart);

    it("renders the pill inside the roster row, on the left of the roster avatars", () => {
      const pillOccurrences = chatPanel.match(/<ChatSpeakerStickyOverlay\b/g) ?? [];
      const pillTag = chatPanel.indexOf("<ChatSpeakerStickyOverlay", rowStart);

      // Exactly one placement — this is not duplicated into the transcript.
      expect(pillOccurrences).toHaveLength(1);
      expect(pillTag).toBeGreaterThan(rowStart);
      // Left of the roster avatars, and both are inside the row (before the
      // roster row's ChatColumn hands off to ChatTranscriptViewport).
      expect(pillTag).toBeLessThan(rosterTag);
      expect(transcriptTag).toBeLessThan(rowStart);
    });

    it("does not render the pill as a descendant of the message scroller", () => {
      // The viewport renders its header as a sibling of the role=log scroller.
      expect(transcriptTag).toBeGreaterThan(-1);
      expect(chatPanel).not.toContain("stickySpeaker={stickyChatSpeaker}");
      expect(chatPanel).not.toContain("stickySpeakerOverlayRef={stickySpeakerOverlayRef}");
    });
  });
});
