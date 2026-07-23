import { describe, expect, it } from "vitest";
import {
  getNativeVoiceInputErrorMessage,
  getNativeVoiceRestartCooldownMs,
  getWebVoiceInputErrorMessage,
  isBenignNoSpeechVoiceInputError,
  mergeVoiceTranscript,
  shouldAutoRetryNativeVoiceError,
} from "../useVoiceInput";

describe("mergeVoiceTranscript", () => {
  it("returns the transcript when the composer is empty", () => {
    expect(mergeVoiceTranscript("", "hello world")).toBe("hello world");
  });

  it("preserves the existing draft and inserts a separating space", () => {
    expect(mergeVoiceTranscript("Plan a launch", "for next week")).toBe(
      "Plan a launch for next week",
    );
  });

  it("does not duplicate whitespace when the base already ends with space", () => {
    expect(mergeVoiceTranscript("Plan a launch ", "for next week")).toBe(
      "Plan a launch for next week",
    );
  });

  it("ignores empty transcripts", () => {
    expect(mergeVoiceTranscript("Keep this", "   ")).toBe("Keep this");
  });
});

describe("getNativeVoiceRestartCooldownMs", () => {
  it("adds a cooldown for transient iOS speech interruptions", () => {
    expect(
      getNativeVoiceRestartCooldownMs(
        "Voice input failed: The operation couldn’t be completed. (kAFAssistantErrorDomain error 1107.)",
      ),
    ).toBe(2500);
  });

  it("adds a shorter cooldown for overlapping native starts", () => {
    expect(
      getNativeVoiceRestartCooldownMs(
        "Voice input failed: The operation couldn’t be completed. (kAFAssistantErrorDomain error 1100.)",
      ),
    ).toBe(1200);
  });

  it("does not add a cooldown for unrelated errors", () => {
    expect(getNativeVoiceRestartCooldownMs("Microphone permission was denied.")).toBe(0);
  });
});

describe("getNativeVoiceInputErrorMessage", () => {
  it("maps transient native interruption errors to user-facing copy", () => {
    expect(
      getNativeVoiceInputErrorMessage(
        "Voice input failed: The operation couldn’t be completed. (kAFAssistantErrorDomain error 1107.)",
      ),
    ).toBe("Voice input was interrupted. Try holding to talk again.");
  });

  it("maps overlapping native starts to a retry hint", () => {
    expect(
      getNativeVoiceInputErrorMessage(
        "Voice input failed: The operation couldn’t be completed. (kAFAssistantErrorDomain error 1100.)",
      ),
    ).toBe("Voice input is resetting. Try again in a moment.");
  });

  it("preserves unknown native errors as-is", () => {
    expect(getNativeVoiceInputErrorMessage("Microphone permission was denied.")).toBe(
      "Microphone permission was denied.",
    );
  });
});

describe("isBenignNoSpeechVoiceInputError", () => {
  it("treats the native no-speech code as non-actionable", () => {
    expect(
      isBenignNoSpeechVoiceInputError(
        "Voice input failed: The operation couldn’t be completed. (kAFAssistantErrorDomain error 1110.)",
      ),
    ).toBe(true);
  });

  it("treats plain no-speech text as non-actionable", () => {
    expect(isBenignNoSpeechVoiceInputError("No speech detected")).toBe(true);
  });

  it("keeps real errors actionable", () => {
    expect(isBenignNoSpeechVoiceInputError("Microphone permission was denied.")).toBe(false);
  });
});

describe("shouldAutoRetryNativeVoiceError", () => {
  it("retries one transient native failure while the hold is still active", () => {
    expect(
      shouldAutoRetryNativeVoiceError(
        "Voice input failed: The operation couldn’t be completed. (kAFAssistantErrorDomain error 1107.)",
        true,
        0,
      ),
    ).toBe(true);
  });

  it("stops retrying after the first transient recovery attempt", () => {
    expect(
      shouldAutoRetryNativeVoiceError(
        "Voice input failed: The operation couldn’t be completed. (kAFAssistantErrorDomain error 1107.)",
        true,
        1,
      ),
    ).toBe(false);
  });

  it("does not retry once the user has released voice input", () => {
    expect(
      shouldAutoRetryNativeVoiceError(
        "Voice input failed: The operation couldn’t be completed. (kAFAssistantErrorDomain error 1107.)",
        false,
        0,
      ),
    ).toBe(false);
  });
});

describe("getWebVoiceInputErrorMessage", () => {
  it("maps network failures to a browser-speech-service message", () => {
    expect(getWebVoiceInputErrorMessage("network")).toBe(
      "Browser voice input could not reach its speech recognition service.",
    );
  });

  it("maps microphone permission failures to actionable copy", () => {
    expect(getWebVoiceInputErrorMessage("not-allowed")).toBe(
      "Microphone permission was denied for browser voice input.",
    );
  });

  it("prefers a detailed browser message for unknown errors", () => {
    expect(getWebVoiceInputErrorMessage("unexpected", "Something went wrong")).toBe(
      "Voice input failed: Something went wrong",
    );
  });
});
