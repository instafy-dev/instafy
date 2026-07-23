import { describe, expect, it } from "vitest";
import { readHostedVoiceUiTestConfigFromSearch } from "../voiceUiTestConfig";

describe("voiceUiTestConfig", () => {
  it("returns null when the hosted voice test query is missing", () => {
    expect(readHostedVoiceUiTestConfigFromSearch("?projectId=abc")).toBeNull();
  });

  it("reads the hosted voice test config from search params", () => {
    expect(
      readHostedVoiceUiTestConfigFromSearch(
        "?projectId=abc&uiTestHostedVoiceText=Tunnel%20voice%20status%20green.&uiTestHostedVoiceFileName=test.wav&uiTestHostedVoiceReadyDelayMs=200&uiTestHostedVoiceFinalDelayMs=300",
      ),
    ).toEqual({
      text: "Tunnel voice status green.",
      fileName: "test.wav",
      readyDelayMs: 200,
      finalDelayMs: 300,
    });
  });

  it("clamps invalid delay params and falls back to defaults", () => {
    expect(
      readHostedVoiceUiTestConfigFromSearch(
        "?uiTestHostedVoiceText=Tunnel%20voice%20status%20green.&uiTestHostedVoiceReadyDelayMs=-20&uiTestHostedVoiceFinalDelayMs=999999",
      ),
    ).toEqual({
      text: "Tunnel voice status green.",
      fileName: "ios-voice-tunnel-smoke.wav",
      readyDelayMs: 0,
      finalDelayMs: 10_000,
    });

    expect(
      readHostedVoiceUiTestConfigFromSearch(
        "?uiTestHostedVoiceText=Tunnel%20voice%20status%20green.&uiTestHostedVoiceReadyDelayMs=wat",
      ),
    ).toEqual({
      text: "Tunnel voice status green.",
      fileName: "ios-voice-tunnel-smoke.wav",
      readyDelayMs: 120,
      finalDelayMs: 150,
    });
  });
});
