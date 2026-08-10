import { describe, expect, it, vi } from "vitest";
import {
  desktopDownloadsConfig,
  resolveDesktopDownloadsConfig,
} from "../desktopDownloads";

describe("desktop downloads build configuration", () => {
  it("uses the canonical production contract by default", () => {
    expect(resolveDesktopDownloadsConfig({})).toEqual({
      downloadsBaseUrl: "https://downloads.instafy.dev",
      desktopPrefix: "desktop-app",
      desktopBaseUrl: "https://downloads.instafy.dev/desktop-app",
    });
    expect(desktopDownloadsConfig).toEqual(
      resolveDesktopDownloadsConfig(import.meta.env),
    );
  });

  it("builds a shared desktop base from configured origin and nested prefix", () => {
    expect(
      resolveDesktopDownloadsConfig({
        VITE_DOWNLOADS_BASE_URL: " https://cdn.example.test ",
        VITE_DESKTOP_DOWNLOADS_PREFIX: " products/desktop ",
      }),
    ).toEqual({
      downloadsBaseUrl: "https://cdn.example.test",
      desktopPrefix: "products/desktop",
      desktopBaseUrl: "https://cdn.example.test/products/desktop",
    });
  });

  it("drives manifest aliases and strict artifact validation from the same build contract", async () => {
    vi.stubEnv("VITE_DOWNLOADS_BASE_URL", "https://cdn.example.test");
    vi.stubEnv("VITE_DESKTOP_DOWNLOADS_PREFIX", "products/desktop");
    vi.resetModules();

    try {
      const releases = await import("../../updates/desktopReleaseManifest");
      const version = "1.2.3";
      const payload = {
        version,
        tag: `desktop-app-v${version}`,
        channel: "stable",
        sourceSha: "a".repeat(40),
        publishedAt: "2026-07-22T12:00:00Z",
        feedUrl: "https://cdn.example.test/products/desktop/stable",
        architectures: { mac: ["arm64"] },
        artifacts: {
          macDmg:
            `https://cdn.example.test/products/desktop/stable/instafy-${version}-mac-arm64.dmg`,
          macZip:
            `https://cdn.example.test/products/desktop/stable/instafy-${version}-mac-arm64.zip`,
          windowsExe:
            `https://cdn.example.test/products/desktop/stable/instafy-${version}-win.exe`,
        },
      };

      expect(releases.DESKTOP_APP_PUBLIC_LATEST_URL).toBe(
        "https://cdn.example.test/products/desktop/latest.json",
      );
      expect(releases.parseDesktopAppLatestPayload(payload)?.version).toBe(version);

      payload.artifacts.windowsExe =
        `https://downloads.instafy.dev/desktop-app/stable/instafy-${version}-win.exe`;
      expect(releases.parseDesktopAppLatestPayload(payload)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it.each([
    "http://downloads.example.test",
    "https://user:secret@downloads.example.test",
    "https://downloads.example.test:8443",
    "https://downloads.example.test/path",
    "https://downloads.example.test?target=desktop",
    "not a URL",
  ])("rejects an unsafe downloads base URL: %s", (downloadsBaseUrl) => {
    expect(() =>
      resolveDesktopDownloadsConfig({
        VITE_DOWNLOADS_BASE_URL: downloadsBaseUrl,
      }),
    ).toThrow(/VITE_DOWNLOADS_BASE_URL/);
  });

  it.each(["/desktop", "desktop/", "../desktop", "desktop//stable", "desktop#stable"])(
    "rejects an unsafe desktop prefix: %s",
    (desktopPrefix) => {
      expect(() =>
        resolveDesktopDownloadsConfig({
          VITE_DESKTOP_DOWNLOADS_PREFIX: desktopPrefix,
        }),
      ).toThrow(/VITE_DESKTOP_DOWNLOADS_PREFIX/);
    },
  );
});
