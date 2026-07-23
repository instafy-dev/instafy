import { describe, expect, it } from "vitest";
import {
  buildReleaseMetadataDetailRows,
  deriveNativeOtaPhaseAction,
  resolveNativeOtaAvailableVersion,
  summarizeAppUpdateState,
  type AppReleaseMetadata,
} from "../releaseMetadata";

function makeMetadata(
  overrides: Partial<AppReleaseMetadata["updates"]> = {},
): AppReleaseMetadata {
  return {
    build: {
      app: "instafy-frontend",
      packageVersion: "1.2.3",
      gitCommit: "abcdef1234567890",
      gitCommitShort: "abcdef12",
      gitBranch: "main",
      builtAt: "2026-03-19T12:00:00.000Z",
      releaseId: "release-123",
    },
    runtime_surface: "desktop",
    binary: {
      version: "1.2.3",
      label: "v1.2.3 (abcdef12)",
      platform: "desktop-web",
    },
    updates: {
      supported: true,
      is_enabled: true,
      primary_action: "check",
      channel: "stable",
      phase: "idle",
      current_bundle_version: null,
      current_git_sha: null,
      available_version: null,
      native_version: "1.2.3",
      feed_url: "https://downloads.instafy.dev/desktop-app/stable",
      last_checked_at: null,
      last_downloaded_at: null,
      last_error: null,
      last_check_reason: null,
      ...overrides,
    },
  };
}

describe("summarizeAppUpdateState", () => {
  it("surfaces an available update without showing the version by default", () => {
    const result = summarizeAppUpdateState(
      makeMetadata({
        phase: "update_available",
        primary_action: "download",
        available_version: "1.2.4",
      }),
    );

    expect(result).toEqual({
      title: "Update available",
      detail: "New",
      emphasis: "attention",
      show: true,
    });
  });

  it("hides unsupported update surfaces", () => {
    const result = summarizeAppUpdateState(
      makeMetadata({
        supported: false,
        is_enabled: false,
        primary_action: null,
        phase: null,
      }),
    );

    expect(result.show).toBe(false);
  });

  it("surfaces an up-to-date app as current instead of falling back to check now", () => {
    const result = summarizeAppUpdateState(
      makeMetadata({
        phase: "up_to_date",
        primary_action: "check",
      }),
    );

    expect(result).toEqual({
      title: "Up to date",
      detail: "Current",
      emphasis: "success",
      show: true,
    });
  });
});

describe("buildReleaseMetadataDetailRows", () => {
  it("includes binary and OTA bundle detail when present", () => {
    const rows = buildReleaseMetadataDetailRows(
      makeMetadata({
        current_bundle_version: "20260319T120000Z-abcdef12",
        current_git_sha: "abcdef1234567890",
        available_version: "20260319T130000Z-fedcba98",
      }),
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        { label: "Binary", value: "1.2.3" },
        { label: "Build", value: "release-123" },
        { label: "OTA bundle", value: "20260319T120000Z-abcdef12" },
        { label: "Available", value: "20260319T130000Z-fedcba98" },
      ]),
    );
  });

  it("includes OTA download timing and error details when present", () => {
    const rows = buildReleaseMetadataDetailRows(
      makeMetadata({
        last_downloaded_at: "2026-03-19T12:19:21.805Z",
        last_error: "Signature verification failed.",
      }),
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        { label: "Last downloaded", value: "2026-03-19T12:19:21.805Z" },
        { label: "Error", value: "Signature verification failed." },
      ]),
    );
  });
});

describe("deriveNativeOtaPhaseAction", () => {
  it("surfaces a staged native update as ready to install", () => {
    const result = deriveNativeOtaPhaseAction({
      supported: true,
      state: {
        current: {
          bundle_version: "release-123",
          git_sha: "abcdef1234567890",
        },
        pending: {
          release_id: "ios-stable-release-124",
          bundle_version: "20260319T120000Z-fedcba98",
          git_sha: "fedcba9876543210",
        },
      },
      lastCheck: {
        checked_at: "2026-03-19T12:00:00.000Z",
        update_available: true,
        reason: "new_release_available",
        release_id: "ios-stable-release-124",
        bundle_version: "20260319T120000Z-fedcba98",
        git_sha: "fedcba9876543210",
      },
    });

    expect(result).toEqual({
      phase: "downloaded",
      primary_action: "install",
    });
  });

  it("treats a current bundle that matches the available bundle as up to date", () => {
    const result = deriveNativeOtaPhaseAction({
      supported: true,
      state: {
        current: {
          bundle_version: "20260319T120000Z-fedcba98",
          git_sha: "fedcba9876543210",
        },
        pending: {
          release_id: null,
          bundle_version: null,
          git_sha: null,
        },
      },
      lastCheck: {
        checked_at: "2026-03-19T12:00:00.000Z",
        update_available: true,
        reason: "new_release_available",
        release_id: "ios-stable-release-124",
        bundle_version: "20260319T120000Z-fedcba98",
        git_sha: "fedcba9876543210",
      },
    });

    expect(result).toEqual({
      phase: "up_to_date",
      primary_action: "check",
    });
  });
});

describe("resolveNativeOtaAvailableVersion", () => {
  it("hides the available version when the current bundle already matches it", () => {
    const result = resolveNativeOtaAvailableVersion({
      current_bundle_version: "20260319T115116Z-91e962e9",
      phase: "up_to_date",
      lastCheck: {
        checked_at: "2026-03-19T12:00:00.000Z",
        update_available: true,
        reason: "new_release_available",
        release_id: "ios-stable-20260319T115116Z-91e962e9",
        bundle_version: "20260319T115116Z-91e962e9",
        git_sha: "91e962e93970152289a0bb9b422f345941b73a3b",
      },
    });

    expect(result).toBeNull();
  });

  it("keeps the available version visible when the current bundle is older", () => {
    const result = resolveNativeOtaAvailableVersion({
      current_bundle_version: "release-123",
      phase: "update_available",
      lastCheck: {
        checked_at: "2026-03-19T12:00:00.000Z",
        update_available: true,
        reason: "new_release_available",
        release_id: "ios-stable-20260319T115116Z-91e962e9",
        bundle_version: "20260319T115116Z-91e962e9",
        git_sha: "91e962e93970152289a0bb9b422f345941b73a3b",
      },
    });

    expect(result).toBe("20260319T115116Z-91e962e9");
  });
});
