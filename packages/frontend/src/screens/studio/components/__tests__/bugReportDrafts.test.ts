import { describe, expect, it } from "vitest";
import {
  buildBugReportScreenshotDraftFromDataUrl,
  buildBugReportScreenshotDrafts,
  isSupportedBugReportScreenshotMediaType,
} from "../bugReportDrafts";

describe("bug report screenshot formats", () => {
  it("accepts only the raster formats supported by the controller", () => {
    expect(isSupportedBugReportScreenshotMediaType("image/png")).toBe(true);
    expect(isSupportedBugReportScreenshotMediaType("IMAGE/JPEG")).toBe(true);
    expect(isSupportedBugReportScreenshotMediaType("image/webp")).toBe(true);
    expect(isSupportedBugReportScreenshotMediaType("image/gif")).toBe(false);
    expect(isSupportedBugReportScreenshotMediaType("image/svg+xml")).toBe(false);
  });

  it("rejects unsupported selected files before reading them", async () => {
    await expect(
      buildBugReportScreenshotDrafts([
        { name: "recording.gif", type: "image/gif", size: 128 } as File,
      ]),
    ).rejects.toThrow("Choose a PNG, JPEG, or WebP screenshot to attach.");
  });

  it("rejects unsupported annotated data URLs", () => {
    expect(() =>
      buildBugReportScreenshotDraftFromDataUrl("data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA=="),
    ).toThrow("Screenshots must be PNG, JPEG, or WebP images.");
  });

  it("rejects a selection that would exceed the 12 MB report total", async () => {
    await expect(
      buildBugReportScreenshotDrafts(
        [{ name: "four-megabytes.png", type: "image/png", size: 4 * 1024 * 1024 } as File],
        [{ byteLength: 9 * 1024 * 1024 }],
      ),
    ).rejects.toThrow("Screenshots must total 12 MB or less.");
  });
});
