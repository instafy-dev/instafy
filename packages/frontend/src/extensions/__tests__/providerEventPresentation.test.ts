import { describe, expect, it } from "vitest";
import { formatProviderEventSummaryLine } from "../providerEventPresentation";

describe("providerEventPresentation", () => {
  it("formats compact camera capture summaries", () => {
    expect(
      formatProviderEventSummaryLine([
        {
          kind: "camera.photo_captured",
          providerId: "camera",
          artifactRefs: [
            {
              kind: "image_capture",
              uri: "/tmp/capture-1.jpg",
            },
          ],
          payload: {
            lens: "rear",
            completedCount: 1,
          },
        },
      ]),
    ).toBe("Rear photo captured · 1 artifact");
  });

  it("formats compact camera series summaries", () => {
    expect(
      formatProviderEventSummaryLine([
        {
          kind: "camera.photo_series_captured",
          providerId: "camera",
          artifactRefs: [
            { kind: "image_capture", uri: "/tmp/capture-1.jpg" },
            { kind: "image_capture", uri: "/tmp/capture-2.jpg" },
          ],
          payload: {
            lens: "front",
            completedCount: 2,
          },
        },
      ]),
    ).toBe("2 front photos captured · 2 artifacts");
  });

  it("falls back to humanized event kinds and condenses multiple events", () => {
    expect(
      formatProviderEventSummaryLine([
        {
          kind: "audio.wake_word_detected",
          providerId: "microphone",
        },
        {
          kind: "camera.photo_captured",
          providerId: "camera",
          artifactRefs: [{ kind: "image_capture", uri: "/tmp/capture-1.jpg" }],
          payload: {
            lens: "rear",
            completedCount: 1,
          },
        },
      ]),
    ).toBe("Audio Wake Word Detected · +1 more");
  });

  it("does not surface record-only provider events in the chat summary line", () => {
    expect(
      formatProviderEventSummaryLine([
        {
          kind: "robot.telemetry_sampled",
          providerId: "demo",
        },
      ]),
    ).toBeNull();
  });

  it("can include record-only events for developer logs", () => {
    expect(
      formatProviderEventSummaryLine(
        [
          {
            kind: "robot.telemetry_sampled",
            providerId: "demo",
          },
        ],
        { includeRecordOnly: true },
      ),
    ).toBe("Robot Telemetry Sampled");
  });
});
