import { describe, expect, it } from "vitest";
import { selectProviderTriggerCandidates } from "../providerEventTriggers";

describe("providerEventTriggers", () => {
  it("returns only candidate trigger entries and respects the cap", () => {
    const entries = [
      {
        key: "wake-word-newest",
        reaction: "candidate_agent_trigger" as const,
        count: 2,
        firstTimestampNs: 30,
        lastTimestampNs: 40,
        latestEvent: {
          kind: "audio.wake_word_detected",
          providerId: "phone-mic",
          providerType: "phone_audio",
          timestampNs: 40,
          payload: { label: "hey instafy" },
        },
      },
      {
        key: "camera",
        reaction: "surface_in_conversation" as const,
        count: 1,
        firstTimestampNs: 20,
        lastTimestampNs: 20,
        latestEvent: {
          kind: "camera.photo_captured",
          providerId: "camera",
          providerType: "phone_camera",
          timestampNs: 20,
          payload: { lens: "rear" },
        },
      },
      {
        key: "wake-word-older",
        reaction: "candidate_agent_trigger" as const,
        count: 1,
        firstTimestampNs: 10,
        lastTimestampNs: 10,
        latestEvent: {
          kind: "audio.wake_word_detected",
          providerId: "phone-mic",
          providerType: "phone_audio",
          timestampNs: 10,
          payload: { label: "hello robot" },
        },
      },
    ];

    expect(selectProviderTriggerCandidates(entries, { maxEntries: 1 })).toEqual([entries[0]]);
    expect(selectProviderTriggerCandidates(entries)).toEqual([entries[0], entries[2]]);
  });
});
