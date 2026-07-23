import { afterEach, describe, expect, it, vi } from "vitest";
import { appendProviderEventsToStore, clearProviderEventLogStore } from "../providerEventStore";
import {
  clearProviderTriggerQueue,
  dismissProviderTriggerCandidate,
  getProviderTriggerQueueSnapshot,
} from "../providerTriggerQueue";

describe("providerTriggerQueue", () => {
  afterEach(() => {
    clearProviderEventLogStore();
    clearProviderTriggerQueue();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tracks candidate triggers from the shared event log and supports dismissal", () => {
    appendProviderEventsToStore([
      {
        kind: "audio.wake_word_detected",
        providerId: "phone-mic",
        providerType: "phone_audio",
        timestampNs: 100,
        payload: { label: "hey instafy" },
      },
      {
        kind: "camera.photo_captured",
        providerId: "camera",
        providerType: "phone_camera",
        timestampNs: 200,
        payload: { lens: "rear" },
      },
    ]);

    const [candidate] = getProviderTriggerQueueSnapshot();
    expect(candidate?.latestEvent.kind).toBe("audio.wake_word_detected");

    dismissProviderTriggerCandidate(candidate!);
    expect(getProviderTriggerQueueSnapshot()).toEqual([]);
  });

  it("clears all pending trigger candidates without touching non-trigger events", () => {
    appendProviderEventsToStore([
      {
        kind: "audio.wake_word_detected",
        providerId: "phone-mic",
        providerType: "phone_audio",
        timestampNs: 100,
        payload: { label: "hey instafy" },
      },
      {
        kind: "audio.wake_word_detected",
        providerId: "phone-mic",
        providerType: "phone_audio",
        timestampNs: 200,
        payload: { label: "hello robot" },
      },
    ]);

    expect(getProviderTriggerQueueSnapshot()).toHaveLength(2);
    clearProviderTriggerQueue();
    expect(getProviderTriggerQueueSnapshot()).toEqual([]);
  });
});
