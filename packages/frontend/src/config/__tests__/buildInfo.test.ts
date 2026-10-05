import { describe, expect, it } from "vitest";
import { formatInstafyBuildLabel, instafyBuildInfo, resolveInstafyBuildInfo } from "../buildInfo";

describe("build info", () => {
  it("uses the build's own info when the build defines it", () => {
    const info: InstafyBuildInfo = {
      app: "instafy-frontend",
      packageVersion: "1.2.3",
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      gitCommitShort: "0123456",
      gitBranch: "main",
      builtAt: "2026-10-05T00:00:00Z",
      releaseId: "r1",
    };
    expect(resolveInstafyBuildInfo(info)).toBe(info);
  });

  it("falls back to neutral info when a runner loads the module without the build define", () => {
    const info = resolveInstafyBuildInfo(undefined);
    expect(info).toMatchObject({ app: "instafy-frontend", packageVersion: "unknown", gitCommitShort: null });
    expect(formatInstafyBuildLabel(info)).toBe("vunknown");
  });

  it("exposes build info in this test build", () => {
    expect(typeof instafyBuildInfo.app).toBe("string");
  });
});
