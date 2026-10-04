import { describe, expect, it } from "vitest";

import { describeFileViewerFacts, formatFileSize, formatModifiedTimestamp } from "../filesViewerFooter";

describe("describeFileViewerFacts", () => {
  it("lists size, modified time and MIME type when they are known", () => {
    const modified = "2026-10-04T09:30:00.000Z";
    expect(describeFileViewerFacts({ size: 2048, modified, mimeType: "text/markdown" })).toEqual([
      { label: "Size", value: "2 KB" },
      { label: "Modified", value: new Date(modified).toLocaleString() },
      { label: "MIME", value: "text/markdown" },
    ]);
  });

  it("leaves out a fact it does not know instead of drawing a placeholder", () => {
    // Files read from saved history carry no modified time.
    const facts = describeFileViewerFacts({ size: 12, modified: null, mimeType: null });
    expect(facts).toEqual([{ label: "Size", value: "12 B" }]);
    expect(describeFileViewerFacts({ size: null, modified: "  ", mimeType: "" })).toEqual([]);
    expect(JSON.stringify(describeFileViewerFacts({}))).not.toMatch(/—/);
  });

  it("formats sizes and keeps an unparseable timestamp as written", () => {
    expect(formatFileSize(Number.NaN)).toBeNull();
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatFileSize(3 * 1024 * 1024 * 1024)).toBe("3 GB");
    expect(formatModifiedTimestamp("yesterday")).toBe("yesterday");
    expect(formatModifiedTimestamp(undefined)).toBeNull();
  });
});
