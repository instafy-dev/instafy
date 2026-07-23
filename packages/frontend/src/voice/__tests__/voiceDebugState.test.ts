import { describe, expect, it } from "vitest";
import { buildVoiceDebugState } from "../voiceDebugState";

describe("voiceDebugState", () => {
  it("normalizes a shared voice debug snapshot", () => {
    expect(
      buildVoiceDebugState({
        route: "provider",
        capture: "hosted",
        state: "transcribing",
        supported: true,
        transcriptionBackendLabel: "Speech",
        mode: "provider",
        interactionMode: "conversation",
        providerReachable: true,
        lastError: null,
      }),
    ).toEqual({
      route: "provider",
      capture: "hosted",
      state: "transcribing",
      supported: true,
      transcriptionBackendLabel: "Speech",
      mode: "provider",
      interactionMode: "conversation",
      providerReachable: true,
      lastError: null,
    });
  });

  it("fills optional fields with nulls when they are omitted", () => {
    expect(
      buildVoiceDebugState({
        route: "device",
        capture: "device",
        state: "idle",
        supported: false,
      }),
    ).toEqual({
      route: "device",
      capture: "device",
      state: "idle",
      supported: false,
      transcriptionBackendLabel: null,
      mode: null,
      interactionMode: null,
      providerReachable: null,
      lastError: null,
    });
  });
});
