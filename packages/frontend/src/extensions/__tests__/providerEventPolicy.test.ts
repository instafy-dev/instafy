import { describe, expect, it } from "vitest";
import { resolveProviderEventHostReaction } from "../providerEventPolicy";

describe("providerEventPolicy", () => {
  it("surfaces camera capture events in conversations", () => {
    expect(
      resolveProviderEventHostReaction({
        kind: "camera.photo_captured",
      }),
    ).toBe("surface_in_conversation");

    expect(
      resolveProviderEventHostReaction({
        kind: "camera.photo_series_captured",
      }),
    ).toBe("surface_in_conversation");
  });

  it("marks wake word detections as trigger candidates", () => {
    expect(
      resolveProviderEventHostReaction({
        kind: "audio.wake_word_detected",
      }),
    ).toBe("candidate_agent_trigger");
  });

  it("keeps unknown events as record-only by default", () => {
    expect(
      resolveProviderEventHostReaction({
        kind: "robot.telemetry_sampled",
      }),
    ).toBe("record_only");

    expect(resolveProviderEventHostReaction(null)).toBe("record_only");
  });
});
