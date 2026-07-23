import { describe, expect, it } from "vitest";
import {
  RUNTIME_LIFECYCLE_MARKERS,
  summarizeRuntimeLifecycleLogs,
} from "../playwright/utils/runtimeLifecycleDiagnostics.js";

describe("summarizeRuntimeLifecycleLogs", () => {
  it("counts only the allowlisted exact lifecycle markers and retains their latest timestamps", () => {
    const summary = summarizeRuntimeLifecycleLogs(
      [
        '2026-07-14T08:00:02.123456789Z INFO message="registration loop failed" status=503 detail="discard me"',
        '2026-07-14T08:00:00.000000001Z INFO message="registered runtime" status=201',
        '2026-07-14T08:00:01.000000001Z INFO message="registration loop failed" status=401',
        '2026-07-14T08:00:03.000000001Z INFO message="unregistered runtime" status=500',
        '2026-07-14T08:00:04.000000001Z INFO message="registered runtimes" status=502',
        '2026-07-14T08:00:05.000000001Z WARN message="origin registration failed" http_status=502',
        '2026-07-14T08:00:06.000000001Z INFO message="tunnel refresh requested" statusCode=202',
      ].join("\n"),
    );

    expect(summary.markers["registered runtime"]).toEqual({
      count: 1,
      lastTimestamp: "2026-07-14T08:00:00.000000001Z",
    });
    expect(summary.markers["registration loop failed"]).toEqual({
      count: 2,
      lastTimestamp: "2026-07-14T08:00:02.123456789Z",
    });
    expect(summary.markers["origin registration failed"].count).toBe(1);
    expect(summary.markers["tunnel refresh requested"].count).toBe(1);
    expect(summary.httpStatusCounts).toEqual({
      "201": 1,
      "202": 1,
      "401": 1,
      "502": 1,
      "503": 1,
    });
  });

  it("ignores status codes and arbitrary content outside marker lines", () => {
    const summary = summarizeRuntimeLifecycleLogs(
      [
        '2026-07-14T08:00:00Z ERROR request failed status=500 token="must-not-survive"',
        '2026-07-14T08:00:01Z INFO message="lease returned no jobs" url="https://example.test/?status=403"',
        '2026-07-14T08:00:02Z WARN message="lease request failed" {"status_code":429}',
      ].join("\n"),
    );

    expect(summary.httpStatusCounts).toEqual({ "429": 1 });
    expect(JSON.stringify(summary)).not.toContain("must-not-survive");
    expect(JSON.stringify(summary)).not.toContain("example.test");
  });

  it("returns a stable zeroed shape when no lifecycle markers are present", () => {
    const summary = summarizeRuntimeLifecycleLogs("arbitrary output");

    expect(Object.keys(summary.markers)).toEqual([...RUNTIME_LIFECYCLE_MARKERS]);
    expect(Object.values(summary.markers)).toEqual(
      RUNTIME_LIFECYCLE_MARKERS.map(() => ({ count: 0, lastTimestamp: null })),
    );
    expect(summary.httpStatusCounts).toEqual({});
  });
});
