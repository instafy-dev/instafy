import { describe, expect, it } from "vitest";

import {
  buildComposerInlineCompletionPath,
  buildComposerInlineSuggestion,
  normalizeComposerCompletionTail,
  shouldRequestComposerInlineCompletion,
} from "../composerInlineCompletion";

describe("composerInlineCompletion", () => {
  it("builds a stable synthetic path for the active conversation", () => {
    expect(buildComposerInlineCompletionPath("conv-123")).toBe(".instafy/chat/conv-123.md");
    expect(buildComposerInlineCompletionPath(null)).toBe(".instafy/chat/composer.md");
  });

  it("only requests completions when the composer draft is eligible", () => {
    expect(
      shouldRequestComposerInlineCompletion({
        projectId: "project-1",
        inputValue: "can you exp",
        anyAgentsEnabled: true,
        credentialsReady: true,
        hasImageAttachments: false,
        onboardingInputLocked: false,
        sendingAttachment: false,
      }),
    ).toBe(true);

    expect(
      shouldRequestComposerInlineCompletion({
        projectId: "project-1",
        inputValue: "/lea",
        anyAgentsEnabled: true,
        credentialsReady: true,
        hasImageAttachments: false,
        onboardingInputLocked: false,
        sendingAttachment: false,
      }),
    ).toBe(false);
  });

  it("builds the full ghost suggestion text from the completion tail", () => {
    expect(buildComposerInlineSuggestion("can you exp", "lain that?")).toBe("can you explain that?");
    expect(buildComposerInlineSuggestion("can you exp", "")).toBeNull();
  });

  it("inserts a bridge space after sentence punctuation when the tail starts with a word", () => {
    expect(buildComposerInlineSuggestion("hello how are you?", "I can help")).toBe(
      "hello how are you? I can help",
    );
    expect(normalizeComposerCompletionTail("hello.", "Thanks")).toBe(" Thanks");
  });

  it("does not add an extra space when the tail already begins with spacing or punctuation", () => {
    expect(normalizeComposerCompletionTail("hello?", " thanks")).toBe(" thanks");
    expect(normalizeComposerCompletionTail("hello?", "...and more")).toBe("...and more");
  });
});
