import { describe, expect, it } from "vitest";
import { deriveChatVoiceComposerViewState } from "../chatVoiceComposerViewState";

function createInput(
  overrides: Partial<Parameters<typeof deriveChatVoiceComposerViewState>[0]> = {},
) {
  return {
    chatVoiceInteractionMode: "hold" as const,
    composerHasSendPayload: false,
    continuousAwaitingAssistantReply: false,
    continuousConversationActive: false,
    continuousPauseMessage: null,
    continuousVoiceResolving: false,
    voiceHoldActive: false,
    voiceInputListening: false,
    voiceInputStarting: false,
    voiceInputSupported: true,
    voiceInputTranscript: "",
    voiceInputTranscribing: false,
    ...overrides,
  };
}

describe("deriveChatVoiceComposerViewState", () => {
  it("describes hold-mode listening state", () => {
    const result = deriveChatVoiceComposerViewState(
      createInput({
        voiceHoldActive: true,
        voiceInputListening: true,
      }),
    );

    expect(result.voiceActionActive).toBe(true);
    expect(result.showVoiceStatus).toBe(true);
    expect(result.voiceStatusMessage).toBe("Listening. Speak now and release to stop.");
    expect(result.recordingIndicatorLabel).toBe("Voice input recording");
    expect(result.showVoicePrimaryAction).toBe(true);
    expect(result.showVoiceSecondaryAction).toBe(false);
  });

  it("describes tap-mode startup state", () => {
    const result = deriveChatVoiceComposerViewState(
      createInput({
        chatVoiceInteractionMode: "tap",
        voiceInputStarting: true,
      }),
    );

    expect(result.voiceStatusMessage).toBe("Starting voice input. Tap again to stop.");
    expect(result.recordingIndicatorLabel).toBe("Starting voice input");
  });

  it("describes continuous mode provider resolution and pause states", () => {
    const resolving = deriveChatVoiceComposerViewState(
      createInput({
        chatVoiceInteractionMode: "continuous",
        continuousVoiceResolving: true,
      }),
    );
    expect(resolving.voiceStatusMessage).toBe(
      "Checking the space speech provider for continuous voice…",
    );

    const paused = deriveChatVoiceComposerViewState(
      createInput({
        chatVoiceInteractionMode: "continuous",
        continuousPauseMessage: "Continuous voice paused.",
      }),
    );
    expect(paused.voiceStatusMessage).toBe("Continuous voice paused.");
    expect(paused.showVoiceStatus).toBe(true);
  });

  it("hides the voice action when capture is unsupported", () => {
    const result = deriveChatVoiceComposerViewState(
      createInput({
        voiceInputSupported: false,
      }),
    );

    expect(result.showVoicePrimaryAction).toBe(false);
    expect(result.showVoiceSecondaryAction).toBe(false);
  });

  it("keeps a dedicated voice action beside Send when a draft exists", () => {
    const result = deriveChatVoiceComposerViewState(
      createInput({
        composerHasSendPayload: true,
      }),
    );

    expect(result.showVoicePrimaryAction).toBe(false);
    expect(result.showVoiceSecondaryAction).toBe(true);
  });

  it("keeps the dedicated draft mic in one slot through a hold and release", () => {
    const lifecycleStates = [
      createInput({ composerHasSendPayload: true }),
      createInput({
        composerHasSendPayload: true,
        voiceHoldActive: true,
        voiceInputStarting: true,
      }),
      createInput({
        composerHasSendPayload: true,
        voiceHoldActive: true,
        voiceInputListening: true,
      }),
      createInput({
        composerHasSendPayload: true,
        voiceInputTranscribing: true,
      }),
    ];

    for (const state of lifecycleStates) {
      const result = deriveChatVoiceComposerViewState(state);
      expect(result.showVoicePrimaryAction).toBe(false);
      expect(result.showVoiceSecondaryAction).toBe(true);
    }
  });

  it("describes continuous active transcript state", () => {
    const result = deriveChatVoiceComposerViewState(
      createInput({
        chatVoiceInteractionMode: "continuous",
        continuousConversationActive: true,
        voiceInputListening: true,
        voiceInputTranscript: "take a look at this",
      }),
    );

    expect(result.voiceActionActive).toBe(true);
    expect(result.voiceStatusMessage).toBe("Continuous voice heard: take a look at this");
    expect(result.showVoicePrimaryAction).toBe(true);
  });
});
