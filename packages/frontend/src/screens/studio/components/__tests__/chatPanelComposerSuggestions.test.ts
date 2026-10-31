import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What the composer offers. A reply's offered replies were never shown in
 * Studio, yet Enter in an empty composer sent the last reply's first one, in
 * the person's name, and they were the ghost text once the person typed their
 * first letters. Now the composer offers only its own completion, and an
 * empty composer sends nothing. ChatPanel is wired to a dozen providers, so
 * mounting it in jsdom is not practical (see chatPanelSharedBrowserLateAttach.test.ts):
 * these assertions read the source, and useChatSubmitFlowQueuedComposerDraft.test.tsx
 * covers what an empty composer sends.
 */
const componentsDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const chatPanel = fs.readFileSync(path.resolve(componentsDir, "ChatPanel.tsx"), "utf8");

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  expect(source.indexOf(start, from + 1)).toBe(-1);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("ChatPanel's composer", () => {
  it("reads no reply's offered replies, and an empty composer falls back to none", () => {
    for (const gone of ["resolveComposerUiSuggestedReplies", "suggestedReplies", "softPrefillSuggestion", "fallbackSuggestion"]) {
      expect(chatPanel).not.toContain(gone);
    }
  });

  it("takes its ghost text from its own completion only", () => {
    const ghost = section(chatPanel, "const composerGhostSuggestion = useMemo(", "\n  );");
    expect(ghost).toContain("composerInlineSuggestion ? [composerInlineSuggestion] : []");
    expect(ghost).not.toContain("messages");
  });
});
