import { describe, expect, it } from "vitest";

import { resolveComposerGhostSuggestion } from "../composerGhostSuggestion";

describe("composerGhostSuggestion", () => {
  it("does not show a ghost suggestion before the user starts typing", () => {
    expect(resolveComposerGhostSuggestion("", ["", "Summarize the latest changes."])).toBeNull();
  });

  it("returns the missing tail when the draft prefixes the suggestion", () => {
    expect(
      resolveComposerGhostSuggestion("Summarize the lat", ["Summarize the latest changes."]),
    ).toEqual({
      suggestion: "Summarize the latest changes.",
      remainder: "est changes.",
    });
  });

  it("matches prefixes case-insensitively while preserving the original suggestion text", () => {
    expect(
      resolveComposerGhostSuggestion("summarize the lat", ["Summarize the latest changes."]),
    ).toEqual({
      suggestion: "Summarize the latest changes.",
      remainder: "est changes.",
    });
  });

  it("returns null when the current draft is not a prefix", () => {
    expect(resolveComposerGhostSuggestion("Explain recursion", ["Summarize the latest changes."])).toBeNull();
  });

  it("returns null for multiline drafts", () => {
    expect(resolveComposerGhostSuggestion("Summarize\nthis", ["Summarize the latest changes."])).toBeNull();
  });

  it("preserves a leading bridge space in inline completion suggestions", () => {
    expect(resolveComposerGhostSuggestion("how are", ["how are you doing"])).toEqual({
      suggestion: "how are you doing",
      remainder: " you doing",
    });
  });
});
