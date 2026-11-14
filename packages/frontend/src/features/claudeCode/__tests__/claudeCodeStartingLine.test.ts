import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_STARTING_LINE,
  CLAUDE_CODE_TURN_PRESENTATION,
  claudeCodeStartingLine,
} from "../claudeCodeTurnPresentation";
import { bannedWordIn } from "./claudeCodeBannedWords";

describe("a Claude Code turn's start", () => {
  it("reads the design's line until the first step for its sender, through the engine's presentation", () => {
    // docs/Local-Engine-Turns.md 5.7.
    expect(CLAUDE_CODE_STARTING_LINE).toBe("Starting Claude Code on this computer…");
    expect(claudeCodeStartingLine({ isViewer: true, name: "Sam" })).toBe(CLAUDE_CODE_STARTING_LINE);
    expect(CLAUDE_CODE_TURN_PRESENTATION.describeStart({ isViewer: true, name: null })).toBe(CLAUDE_CODE_STARTING_LINE);
  });

  // It starts on its sender's computer, never on a teammate's, as the speaker
  // line and the failure sentence say (5.5, D20).
  it("names the sender's computer for everyone else", () => {
    expect(claudeCodeStartingLine({ isViewer: false, name: "Sam" })).toBe("Starting Claude Code on Sam's computer…");
    expect(claudeCodeStartingLine({ isViewer: false, name: "  " })).toBe(
      "Starting Claude Code on the sender's computer…",
    );
    expect(claudeCodeStartingLine({ isViewer: false, name: null })).toBe(
      "Starting Claude Code on the sender's computer…",
    );
  });

  it("names no computer when the chat can't tell who sent the turn", () => {
    expect(claudeCodeStartingLine(null)).toBe("Starting Claude Code…");
    expect(CLAUDE_CODE_TURN_PRESENTATION.describeStart(null)).toBe("Starting Claude Code…");
  });

  it("never uses a word the banned-word fixture lists", () => {
    for (const owner of [{ isViewer: true, name: null }, { isViewer: false, name: "Sam" }, { isViewer: false, name: null }, null]) {
      expect(bannedWordIn(claudeCodeStartingLine(owner))).toBeNull();
    }
  });
});
