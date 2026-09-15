import { describe, expect, it } from "vitest";
import type { ControllerBugReportSummary } from "../../../services/runtimeController/bugReports";
import { buildHomeSupportReports } from "../homeSupportReports";

const ID = "11111111-1111-4111-8111-111111111111";
function report(overrides: Partial<ControllerBugReportSummary> = {}): ControllerBugReportSummary {
  return {
    id: ID, message: "The tab cannot be dragged", createdAt: "2026-09-01T12:00:00Z", activityAt: "2026-09-08T12:00:00Z", updatedAt: null,
    projectId: null, status: "resolved", screenshotCount: 3, customerLastMessageAt: "2026-09-08T12:00:00Z",
    supportLastMessageAt: "2026-09-06T12:00:00Z", resolvedAt: "2026-09-07T12:00:00Z", hasUnreadResolution: true, hasUnreadSupportActivity: true,
    ...overrides,
  };
}

describe("Home support report projection", () => {
  it("exposes only the customer summary and observed support times", () => {
    expect(buildHomeSupportReports([report()])).toEqual([{
      id: ID, title: "The tab cannot be dragged", projectId: null,
      activityAt: "2026-09-07T12:00:00Z", supportLastMessageAt: "2026-09-06T12:00:00Z",
      resolvedAt: "2026-09-07T12:00:00Z", hasUnreadResolution: true,
    }]);
  });

  it("excludes read or invalid reports and deduplicates the same report across pages", () => {
    expect(buildHomeSupportReports([report({ hasUnreadSupportActivity: false }), report({ id: "bad" })])).toEqual([]);
    expect(buildHomeSupportReports([report(), report({ message: "older duplicate" })])).toHaveLength(1);
  });

  it("normalizes long titles and does not copy private fields into Home", () => {
    const source = { ...report({ message: `  Fix\n ${"long title ".repeat(30)}` }), details: "private diagnostics", screenshots: ["bytes"] };
    const [value] = buildHomeSupportReports([source]);
    expect(value.title).toHaveLength(160);
    expect(value.title).toMatch(/^Fix long title/);
    expect(value.title.endsWith("…")).toBe(true);
    expect(value).not.toHaveProperty("details");
    expect(value).not.toHaveProperty("screenshots");
  });

  it("uses a safe fallback label and ignores an invalid project identity", () => {
    const [value] = buildHomeSupportReports([report({ message: "\n ", projectId: "bad-project", supportLastMessageAt: null, resolvedAt: null })]);
    expect(value.title).toBe("Support report");
    expect(value.projectId).toBeNull();
    expect(value.activityAt).toBe("2026-09-08T12:00:00Z");
  });
});
