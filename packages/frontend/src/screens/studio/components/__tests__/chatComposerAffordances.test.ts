import { describe, expect, it } from "vitest";

import { resolveChatComposerAffordances } from "../chatComposerAffordances";

function resolveAffordances(overrides: Partial<Parameters<typeof resolveChatComposerAffordances>[0]> = {}) {
  return resolveChatComposerAffordances({
    compactBrowserViewport: false,
    composerGhostSuggestionRemainder: null,
    credentialsReady: true,
    activeConversationControllerId: "controller-1",
    imageAttachmentCount: 0,
    deferAiGatesForAmbientParticipation: false,
    inputRequiresAi: true,
    inputValue: "",
    onboardingInputLocked: false,
    outOfCredits: false,
    runtimeControllerEnabled: true,
    queueStatusLabel: null,
    sendingAttachment: false,
    submissionPending: false,
    totalQueuedCount: 0,
    voiceHoldActive: false,
    voiceInputListening: false,
    voiceInputStarting: false,
    voiceInputTranscribing: false,
    ...overrides,
  });
}

describe("resolveChatComposerAffordances", () => {
  it("allows queued text to be sent through the durable controller path while runtime is offline", () => {
    expect(
      resolveAffordances({
        queueStatusLabel: "Runtime offline",
        totalQueuedCount: 1,
      }).queueCanSendNow,
    ).toBe(true);
  });

  it("does not offer durable queue send before the conversation is synced", () => {
    expect(
      resolveAffordances({
        activeConversationControllerId: null,
        queueStatusLabel: "Runtime offline",
        totalQueuedCount: 1,
      }).queueCanSendNow,
    ).toBe(false);
  });

  it("keeps the queue blocked when runtime control is unavailable", () => {
    expect(
      resolveAffordances({
        runtimeControllerEnabled: false,
        queueStatusLabel: "Runtime offline",
        totalQueuedCount: 1,
      }).queueCanSendNow,
    ).toBe(false);
  });

  it("blocks an AI send when the account is out of credits", () => {
    expect(
      resolveAffordances({ inputRequiresAi: true, outOfCredits: true }).sendButtonDisabled,
    ).toBe(true);
  });

  it("still allows a non-AI send while out of credits", () => {
    expect(
      resolveAffordances({ inputRequiresAi: false, outOfCredits: true }).sendButtonDisabled,
    ).toBe(false);
  });

  it("allows an AI send when credits remain", () => {
    expect(
      resolveAffordances({ inputRequiresAi: true, outOfCredits: false }).sendButtonDisabled,
    ).toBe(false);
  });

  it("lets a plain p2p message send even while the first-run lock is set and AI is not ready", () => {
    // onboardingInputLocked no longer gates Send; only AI-targeted text is blocked.
    expect(
      resolveAffordances({
        onboardingInputLocked: true,
        inputRequiresAi: false,
        credentialsReady: false,
      }).sendButtonDisabled,
    ).toBe(false);
  });

  it("still blocks AI-targeted text when creds are not ready, regardless of the lock", () => {
    expect(
      resolveAffordances({
        onboardingInputLocked: true,
        inputRequiresAi: true,
        credentialsReady: false,
      }).sendButtonDisabled,
    ).toBe(true);
  });

  it("lets an ambient default-Octo candidate reach participation classification before AI gates", () => {
    expect(
      resolveAffordances({
        deferAiGatesForAmbientParticipation: true,
        inputRequiresAi: true,
        credentialsReady: false,
        outOfCredits: true,
      }).sendButtonDisabled,
    ).toBe(false);
  });

  it("disables Send while participation and submit preflight are in flight", () => {
    expect(resolveAffordances({ submissionPending: true }).sendButtonDisabled).toBe(true);
  });
});
