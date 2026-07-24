import { describe, expect, it } from "vitest";
import type { AppReleaseMetadata } from "../../../../updates/releaseMetadata";
import { formatAvailableUpdateVersion } from "../UpdateStatusDialog";

function metadata(runtimeSurface: AppReleaseMetadata["runtime_surface"]): AppReleaseMetadata {
  return {
    build: {
      app: "instafy-frontend",
      packageVersion: "1.2.3",
      gitCommit: "abcdef1234567890",
      gitCommitShort: "abcdef12",
      gitBranch: "main",
      builtAt: "2026-07-21T12:00:00.000Z",
      releaseId: "release-123",
    },
    runtime_surface: runtimeSurface,
    binary: {
      version: "1.2.3",
      label: "v1.2.3 (abcdef12)",
      platform: runtimeSurface === "desktop" ? "desktop-web" : "ios",
    },
    updates: {
      supported: true,
      is_enabled: true,
      primary_action: "download",
      channel: "stable",
      phase: "update_available",
      current_bundle_version: null,
      current_git_sha: null,
      available_version: "1.2.4",
      native_version: "1.2.3",
      feed_url: null,
      last_checked_at: null,
      last_downloaded_at: null,
      last_error: null,
      last_check_reason: null,
    },
  };
}

describe("formatAvailableUpdateVersion", () => {
  it("uses desktop release copy for Electron updates", () => {
    expect(formatAvailableUpdateVersion(metadata("desktop"))).toBe(
      "Available desktop version: 1.2.4",
    );
  });

  it("retains OTA copy for native live updates", () => {
    expect(formatAvailableUpdateVersion(metadata("native-ota"))).toBe(
      "Available OTA: 1.2.4",
    );
  });
});
