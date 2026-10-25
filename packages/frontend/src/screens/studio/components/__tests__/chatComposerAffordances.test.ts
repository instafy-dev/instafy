import { describe, expect, it } from "vitest";

import { resolveChatComposerAffordances } from "../chatComposerAffordances";

type AffordanceInput = Parameters<typeof resolveChatComposerAffordances>[0];

function affordanceInput(overrides: Partial<AffordanceInput> = {}): AffordanceInput {
  return {
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
    sharedBrowserSendBlocked: false,
    submissionPending: false,
    totalQueuedCount: 0,
    voiceHoldActive: false,
    voiceInputListening: false,
    voiceInputStarting: false,
    voiceInputTranscribing: false,
    ...overrides,
  };
}

function resolveAffordances(overrides: Partial<AffordanceInput> = {}) {
  return resolveChatComposerAffordances(affordanceInput(overrides));
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

  it("disables Send while a send from the browser's composer would be refused", () => {
    const blocked = resolveAffordances({ inputValue: "Open example.com", sharedBrowserSendBlocked: true });
    expect(blocked.sendButtonDisabled).toBe(true);
    expect(blocked.sendButtonVariant).toBe("ghost");
    const ready = resolveAffordances({ inputValue: "Open example.com", sharedBrowserSendBlocked: false });
    expect(ready.sendButtonDisabled).toBe(false);
    expect(ready.sendButtonVariant).toBe("primary");
  });

  it("makes every caller say whether the browser would refuse a send", () => {
    // Leaving the browser's blocker out must fail to compile, or Send would
    // stay on while the browser is still connecting.
    const { sharedBrowserSendBlocked, ...withoutBlocker } = affordanceInput();
    expect(sharedBrowserSendBlocked).toBe(false);
    // @ts-expect-error sharedBrowserSendBlocked is required
    const incomplete: AffordanceInput = withoutBlocker;
    expect(incomplete).not.toHaveProperty("sharedBrowserSendBlocked");
  });
});
