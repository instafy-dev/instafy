import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The roster describes *the conversation*, so it has to live inside the
 * conversation surface — not in workspace chrome, where it drifted with the tab
 * strip and vanished below `sm`.
 *
 * ChatPanel is a ~5k-line component wired to a dozen providers (runtime,
 * conversations, auth, workspace tabs, voice…), so mounting it in jsdom just to
 * check a wrapper's position is not practical. These assertions therefore read
 * the composed JSX: the ordering and the absence of a breakpoint guard are
 * exactly the two things that regressed, and both are visible in the source.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanelFile = path.resolve(componentsDir, "ChatPanel.tsx");
const topBarFile = path.resolve(componentsDir, "StudioTopBar.tsx");

describe("conversation roster placement", () => {
  const chatPanel = fs.readFileSync(chatPanelFile, "utf8");

  it("renders the roster inside the chat panel, above the message scroll container", () => {
    const chatPanelWrapper = chatPanel.indexOf(
      'className={chatVisible ? "flex h-full min-h-0 flex-col" : "hidden"}',
    );
    const rosterRow = chatPanel.indexOf('data-testid="chat-conversation-roster-row"');
    // The chat panel's scroll container is composed by ChatTranscriptViewport
    // (the read-only job-thread branch earlier in the file inlines its own),
    // so look for the viewport that belongs to this chat panel.
    const scrollContainer = chatPanel.indexOf("<ChatTranscriptViewport", chatPanelWrapper);

    expect(chatPanelWrapper).toBeGreaterThan(-1);
    expect(rosterRow).toBeGreaterThan(chatPanelWrapper);
    expect(scrollContainer).toBeGreaterThan(chatPanelWrapper);
    expect(rosterRow).toBeGreaterThan(scrollContainer);
    expect(chatPanel).toContain("<ConversationRoster");
  });

  it("keeps presence in the viewport header with the same message gutters", () => {
    const rowClass = /className="([^"]*)"\s*\n\s*data-testid="chat-conversation-roster-row"/.exec(
      chatPanel,
    )?.[1];

    expect(rowClass).toBeDefined();
    expect(chatPanel).toContain("header={");
    // Same horizontal padding as the scroll container beneath it.
    expect(rowClass).toContain("px-3");
    expect(rowClass).toContain("sm:px-4");
    expect(rowClass).not.toContain("absolute");
    expect(rowClass).not.toContain("fixed");
  });

  it("aligns the roster to the shared chat column, not the panel edge", () => {
    // The roster sits at the right end *inside* the 56rem ChatColumn so its
    // edge lands on the message column instead of the panel edge. Grab the
    // source between the roster row and its ConversationRoster and assert the
    // column wrapper is present and spreads its two children apart (the
    // sticky speaker pill on the left, the roster on the right) rather than
    // collapsing them both to the end.
    const rowStart = chatPanel.indexOf('data-testid="chat-conversation-roster-row"');
    const rosterTag = chatPanel.indexOf("<ConversationRoster", rowStart);
    const wrapper = chatPanel.slice(rowStart, rosterTag);

    expect(rowStart).toBeGreaterThan(-1);
    expect(rosterTag).toBeGreaterThan(rowStart);
    expect(wrapper).toContain("<ChatColumn");
    expect(wrapper).toContain("justify-between");
    expect(wrapper).not.toContain("justify-end");
  });

  it("shows the roster at every viewport width", () => {
    const rowClass = /className="([^"]*)"\s*\n\s*data-testid="chat-conversation-roster-row"/.exec(
      chatPanel,
    )?.[1];

    // No breakpoint guard: at 375px the roster must still be there.
    expect(rowClass).not.toMatch(/\bhidden\b/);
    expect(rowClass).not.toMatch(/\bsm:flex\b/);
    expect(rowClass).not.toMatch(/\bmd:flex\b/);
    expect(rowClass).not.toMatch(/\blg:flex\b/);
  });

  it("keeps the controls compact within the transcript header inset", () => {
    const rowClass = /className="([^"]*)"\s*\n\s*data-testid="chat-conversation-roster-row"/.exec(
      chatPanel,
    )?.[1];

    expect(rowClass).toBe("px-3 pt-2 sm:px-4");
  });

  it("no longer renders the roster from the workspace top bar", () => {
    const topBar = fs.readFileSync(topBarFile, "utf8");

    expect(topBar).not.toContain("ConversationRoster");
    expect(topBar).not.toContain("conversationRosterPresence");
  });

  describe("sticky speaker pill lives in the roster row", () => {
    const rowStart = chatPanel.indexOf('data-testid="chat-conversation-roster-row"');
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
