// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStoredDesktopUpdaterSnapshot } from "../../desktop/updates/state";
import { collectAppReleaseMetadata } from "../releaseMetadata";

describe("collectAppReleaseMetadata desktop fallback", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "instafyDesktop", {
      configurable: true,
      value: undefined,
    });
  });

  it("keeps the last verified desktop snapshot when the live IPC read fails", async () => {
    writeStoredDesktopUpdaterSnapshot({
      channel: "stable",
      currentVersion: "1.2.3",
      availableVersion: "1.2.4",
      phase: "downloaded",
      feedUrl: "https://downloads.instafy.dev/desktop-app/stable",
      lastCheckedAt: "2026-07-21T12:00:00.000Z",
      lastDownloadedAt: "2026-07-21T12:01:00.000Z",
      lastError: null,
    });
    Object.defineProperty(window, "instafyDesktop", {
      configurable: true,
      value: {
        desktopUpdaterStatus: vi.fn().mockRejectedValue(new Error("IPC temporarily unavailable")),
      },
    });

    const result = await collectAppReleaseMetadata();

    expect(result.runtime_surface).toBe("desktop");
    expect(result.updates).toMatchObject({
      supported: true,
      is_enabled: true,
      phase: "downloaded",
      primary_action: "install",
      available_version: "1.2.4",
    });
  });

  it("does not treat a browser as desktop solely because old snapshot data exists", async () => {
    writeStoredDesktopUpdaterSnapshot({
      channel: "stable",
      currentVersion: "1.2.3",
      availableVersion: "1.2.4",
      phase: "update_available",
      feedUrl: "https://downloads.instafy.dev/desktop-app/stable",
      lastCheckedAt: null,
      lastDownloadedAt: null,
      lastError: null,
    });

    const result = await collectAppReleaseMetadata();

    expect(result.runtime_surface).toBe("web");
  });

  it("keeps a failed desktop download directly retryable when a version is known", async () => {
    Object.defineProperty(window, "instafyDesktop", {
      configurable: true,
      value: {
        desktopUpdaterStatus: vi.fn().mockResolvedValue({
          isEnabled: true,
          channel: "stable",
          currentVersion: "1.2.3",
          availableVersion: "1.2.4",
          feedUrl: "https://downloads.instafy.dev/desktop-app/stable",
          phase: "error",
          lastError: "network unavailable",
        }),
      },
    });

    const result = await collectAppReleaseMetadata();

    expect(result.updates).toMatchObject({
      phase: "error",
      primary_action: "download",
      available_version: "1.2.4",
      last_error: "network unavailable",
    });
  });
});
