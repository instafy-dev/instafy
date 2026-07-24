// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installDesktopUpdaterNow } from "../client";

describe("desktop updater client", () => {
  afterEach(() => {
    Object.defineProperty(window, "instafyDesktop", {
      configurable: true,
      value: undefined,
    });
  });

  it("preserves an explicit declined install request from the main process", async () => {
    Object.defineProperty(window, "instafyDesktop", {
      configurable: true,
      value: {
        desktopUpdaterInstall: vi.fn().mockResolvedValue({
          isEnabled: true,
          channel: "stable",
          currentVersion: "1.2.3",
          feedUrl: "https://downloads.instafy.dev/desktop-app/stable",
          phase: "downloaded",
          availableVersion: "1.2.4",
          lastInstallRequestAccepted: false,
        }),
      },
    });

    await expect(installDesktopUpdaterNow()).resolves.toMatchObject({
      phase: "downloaded",
      lastInstallRequestAccepted: false,
    });
  });
});
