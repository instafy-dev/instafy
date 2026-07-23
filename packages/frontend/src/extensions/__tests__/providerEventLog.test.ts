import { describe, expect, it } from "vitest";
import { appendProviderEventLog } from "../providerEventLog";

describe("providerEventLog", () => {
  it("coalesces rapid repeated events with the same signature", () => {
    const entries = appendProviderEventLog(
      [],
      [
        {
          kind: "robot.telemetry_sampled",
          providerId: "demo",
          providerType: "robot_embodiment",
          timestampNs: 1_000_000_000,
        },
        {
          kind: "robot.telemetry_sampled",
          providerId: "demo",
          providerType: "robot_embodiment",
          timestampNs: 2_000_000_000,
        },
      ],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      reaction: "record_only",
      count: 2,
      firstTimestampNs: 1_000_000_000,
      lastTimestampNs: 2_000_000_000,
    });
  });

  it("separates events when the coalesce window is exceeded or the signature changes", () => {
    const entries = appendProviderEventLog(
      [],
      [
        {
          kind: "audio.wake_word_detected",
          providerId: "microphone",
          providerType: "phone_microphone",
          timestampNs: 1_000_000_000,
          payload: {
            label: "hey demo",
          },
        },
        {
          kind: "audio.wake_word_detected",
          providerId: "microphone",
          providerType: "phone_microphone",
          timestampNs: 4_500_000_000,
          payload: {
            label: "hey demo",
          },
        },
        {
          kind: "audio.wake_word_detected",
          providerId: "microphone",
          providerType: "phone_microphone",
          timestampNs: 4_800_000_000,
          payload: {
            label: "okay robot",
          },
        },
      ],
      { coalesceWindowMs: 2_000 },
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]?.reaction).toBe("candidate_agent_trigger");
    expect(entries[0]?.count).toBe(1);
    expect(entries[1]?.count).toBe(1);
    expect(entries[2]?.count).toBe(1);
  });

  it("caps the log length", () => {
    const entries = appendProviderEventLog(
      [],
      [
        {
          kind: "event.one",
          providerId: "a",
          timestampNs: 1,
        },
        {
          kind: "event.two",
          providerId: "a",
          timestampNs: 2,
        },
        {
          kind: "event.three",
          providerId: "a",
          timestampNs: 3,
        },
      ],
      { maxEntries: 2, coalesceWindowMs: 0 },
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.latestEvent.kind).toBe("event.three");
    expect(entries[1]?.latestEvent.kind).toBe("event.two");
  });

  it("ignores duplicate dispatches of the exact same provider event envelope", () => {
    const event = {
      kind: "camera.photo_captured",
      providerId: "camera-main",
      providerType: "phone_camera",
      timestampNs: 500,
      payload: { lens: "rear", mode: "single", captureId: "capture-1" },
    };

    const entries = appendProviderEventLog([], [event, event]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.count).toBe(1);
    expect(entries[0]?.latestEvent).toEqual(event);
  });
});
