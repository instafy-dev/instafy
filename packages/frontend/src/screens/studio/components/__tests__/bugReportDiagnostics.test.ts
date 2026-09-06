import { describe, expect, it } from "vitest";
import { sanitizeBugReportLocation } from "../bugReportDiagnostics";

describe("sanitizeBugReportLocation", () => {
  it("keeps the origin and path while dropping query parameters and fragments", () => {
    expect(
      sanitizeBugReportLocation(
        "https://app.instafy.dev/studio/project?access_token=secret&search=private#oauth-code",
      ),
    ).toBe("https://app.instafy.dev/studio/project");
  });

  it("rejects credentials and non-http URLs", () => {
    expect(sanitizeBugReportLocation("https://user:password@example.com/studio")).toBeNull();
    expect(sanitizeBugReportLocation("file:///private/example.txt")).toBeNull();
    expect(sanitizeBugReportLocation("not a url")).toBeNull();
  });
});
