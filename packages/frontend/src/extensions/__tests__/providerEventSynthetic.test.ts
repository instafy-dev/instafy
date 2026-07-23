import { describe, expect, it } from "vitest";
import {
  createSyntheticProviderEvents,
  PROVIDER_EVENT_DEBUG_INJECT_EVENT,
} from "../providerEventSynthetic";

describe("providerEventSynthetic", () => {
  it("exports a stable debug inject event name", () => {
    expect(PROVIDER_EVENT_DEBUG_INJECT_EVENT).toBe("instafy:provider-events:inject");
  });

  it("creates a synthetic camera capture event with an artifact", () => {
    const events = createSyntheticProviderEvents("camera_capture", { nowMs: 1000 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "camera.photo_captured",
      providerId: "camera",
      providerType: "phone_camera",
      payload: expect.objectContaining({
        lens: "rear",
        completedCount: 1,
      }),
      artifactRefs: [
        expect.objectContaining({
          kind: "image_capture",
        }),
      ],
    });
  });

  it("creates a synthetic telemetry burst for coalescing tests", () => {
    const events = createSyntheticProviderEvents("telemetry_burst", { nowMs: 1000 });
    expect(events).toHaveLength(8);
    expect(events[0]?.kind).toBe("robot.telemetry_sampled");
    expect(events[7]?.kind).toBe("robot.telemetry_sampled");
    expect(events[0]?.timestampNs).toBe(1_000_000_000);
    expect(events[1]?.timestampNs).toBe(1_150_000_000);
  });
});
