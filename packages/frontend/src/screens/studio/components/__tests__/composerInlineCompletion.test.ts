import { describe, expect, it } from "vitest";

import {
  buildComposerInlineCompletionPath,
  buildComposerInlineSuggestion,
  normalizeComposerCompletionTail,
  readComposerInlineCompletionPreference,
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
        inlineCompletionEnabled: true,
        turnEnginePending: false,
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
        inlineCompletionEnabled: true,
        turnEnginePending: false,
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

  it("keeps ghost text off unless the user opted in", () => {
    const eligible = {
      projectId: "project-1",
      inputValue: "can you exp",
      anyAgentsEnabled: true,
      credentialsReady: true,
      hasImageAttachments: false,
      onboardingInputLocked: false,
      sendingAttachment: false,
      turnEnginePending: false,
    };
    expect(shouldRequestComposerInlineCompletion({ ...eligible, inlineCompletionEnabled: false })).toBe(false);
    expect(shouldRequestComposerInlineCompletion({ ...eligible, inlineCompletionEnabled: true })).toBe(true);
  });

  // docs/Local-Engine-Turns.md 5.2, 7.2: while an engine is chosen for the
  // next message, the draft is what that engine gets, and nothing Instafy
  // runs for that turn sends it to a model, also for a person who opted in.
  it("asks for nothing while an engine is chosen for the next message", () => {
    const eligible = {
      projectId: "project-1",
      inputValue: "fix the failing login te",
      anyAgentsEnabled: true,
      credentialsReady: true,
      hasImageAttachments: false,
      onboardingInputLocked: false,
      sendingAttachment: false,
      inlineCompletionEnabled: true,
    };
    expect(shouldRequestComposerInlineCompletion({ ...eligible, turnEnginePending: false })).toBe(true);
    expect(shouldRequestComposerInlineCompletion({ ...eligible, turnEnginePending: true })).toBe(false);
  });

  it("reads the opt-in from storage and defaults to off", () => {
    expect(readComposerInlineCompletionPreference(null)).toBe(false);
    expect(readComposerInlineCompletionPreference({ getItem: () => null })).toBe(false);
    expect(readComposerInlineCompletionPreference({ getItem: () => "1" })).toBe(true);
    expect(
      readComposerInlineCompletionPreference({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(false);
  });
});
