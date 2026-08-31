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
      'className={browserSubtab === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}',
    );
    const rosterRow = chatPanel.indexOf('data-testid="chat-conversation-roster-row"');
    // The read-only job-thread branch earlier in the file has its own scroll
    // container, so look for the one that belongs to this chat panel.
    const scrollContainer = chatPanel.indexOf('data-testid="chat-message-scroll"', rosterRow);

    expect(chatPanelWrapper).toBeGreaterThan(-1);
    expect(rosterRow).toBeGreaterThan(chatPanelWrapper);
    expect(scrollContainer).toBeGreaterThan(rosterRow);
    expect(chatPanel).toContain("<ConversationRoster");
  });

  it("keeps the roster row a flow row, never an overlay", () => {
    const rowClass = /className="([^"]*)"\s*\n\s*data-testid="chat-conversation-roster-row"/.exec(
      chatPanel,
    )?.[1];

    expect(rowClass).toBeDefined();
    expect(rowClass).toContain("flex-none");
    // Same horizontal padding as the scroll container beneath it.
    expect(rowClass).toContain("px-3");
    expect(rowClass).toContain("sm:px-4");
    expect(rowClass).not.toContain("absolute");
    expect(rowClass).not.toContain("fixed");
  });

  it("aligns the roster to the shared chat column, not the panel edge", () => {
    // The roster is right-aligned *inside* the 56rem ChatColumn so its edge
    // lands on the message column instead of the panel edge. Grab the source
    // between the roster row and its ConversationRoster and assert the column
    // wrapper is present and right-aligns its content.
    const rowStart = chatPanel.indexOf('data-testid="chat-conversation-roster-row"');
    const rosterTag = chatPanel.indexOf("<ConversationRoster", rowStart);
    const wrapper = chatPanel.slice(rowStart, rosterTag);

    expect(rowStart).toBeGreaterThan(-1);
    expect(rosterTag).toBeGreaterThan(rowStart);
    expect(wrapper).toContain("<ChatColumn");
    expect(wrapper).toContain("justify-end");
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

  it("no longer renders the roster from the workspace top bar", () => {
    const topBar = fs.readFileSync(topBarFile, "utf8");

    expect(topBar).not.toContain("ConversationRoster");
    expect(topBar).not.toContain("conversationRosterPresence");
  });
});
