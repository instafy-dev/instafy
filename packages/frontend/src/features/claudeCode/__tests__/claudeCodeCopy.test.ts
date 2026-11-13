import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_COPY, claudeCodeNotReadySentence, claudeCodeSignInLine } from "../claudeCodeCopy";
import { bannedWordIn, stringsIn } from "./claudeCodeBannedWords";

describe("Claude Code composer wording", () => {
  it("never uses a word the product keeps out of these sentences", () => {
    for (const sentence of stringsIn(CLAUDE_CODE_COPY)) {
      expect(bannedWordIn(sentence), sentence).toBeNull();
    }
  });

  it("names Anthropic's current terms on both lines, and the plan only for a plan sign-in", () => {
    expect(claudeCodeSignInLine(true)).toBe("Runs on your own Claude plan, under Anthropic's current terms.");
    expect(claudeCodeSignInLine(false)).toBe(
      "Uses your own Claude Code sign-in, under Anthropic's current terms.",
    );
    expect(claudeCodeSignInLine(false)).not.toContain("plan");
  });

  it("keeps the design's row and token words", () => {
    expect(CLAUDE_CODE_COPY.rowTitle).toBe("Claude Code for the next message");
    expect(CLAUDE_CODE_COPY.rowHint).toBe(
      "Instafy gives Claude Code only your message. Everyone who can see this chat sees its steps and reply.",
    );
    expect(CLAUDE_CODE_COPY.tokenLabel).toBe("Claude Code · next message");
    expect(CLAUDE_CODE_COPY.tokenCancel).toBe("Don't use Claude Code");
  });

  it("has a sentence for every reason a runtime attests", () => {
    for (const reason of [
      "binary_missing",
      "binary_unsafe",
      "probe_failed",
      "unsupported_version",
      "bare_default",
    ] as const) {
      expect(claudeCodeNotReadySentence(reason)).toBe(CLAUDE_CODE_COPY.notReady[reason]);
    }
    expect(claudeCodeNotReadySentence(null)).toBe(CLAUDE_CODE_COPY.notReadyYet);
  });

  it("keeps the design's Your AI words", () => {
    expect(CLAUDE_CODE_COPY.yourAi.title).toBe("Claude Code on this computer");
    expect(CLAUDE_CODE_COPY.yourAi.enable).toBe("Use for my messages");
    expect(CLAUDE_CODE_COPY.yourAi.firstUse).toBe(
      "Sign in to Claude Code on this computer first: run claude in a terminal once.",
    );
  });
});
