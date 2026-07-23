import { describe, expect, it } from "vitest";
import { describeDesktopVoiceHostLifecycle } from "../client";

describe("describeDesktopVoiceHostLifecycle", () => {
  it("summarizes a healthy desktop-managed host", () => {
    const summary = describeDesktopVoiceHostLifecycle({
      enabled: true,
      hostMode: "desktop",
      speechService: {
        state: "running",
        managed: true,
        reachable: true,
        healthUrl: "http://127.0.0.1:8796/health",
        scriptPath: "/tmp/local-speech-service.mjs",
      },
      providerHost: {
        state: "running",
        managed: true,
        reachable: true,
        healthUrl: "http://127.0.0.1:8797/health",
        scriptPath: "/tmp/local-provider-host.mjs",
      },
    });

    expect(summary).toMatchObject({
      badgeLabel: "Desktop host running",
      badgeTone: "success",
      actionLabel: "Restart Desktop host",
    });
    expect(summary?.detail).toContain("Desktop is managing the local voice host");
  });

  it("summarizes an external host without claiming Desktop manages it", () => {
    const summary = describeDesktopVoiceHostLifecycle({
      enabled: true,
      hostMode: "desktop",
      speechService: {
        state: "external",
        managed: false,
        reachable: true,
        healthUrl: "http://127.0.0.1:8796/health",
        scriptPath: "/tmp/local-speech-service.mjs",
      },
      providerHost: {
        state: "external",
        managed: false,
        reachable: true,
        healthUrl: "http://127.0.0.1:8797/health",
        scriptPath: "/tmp/local-provider-host.mjs",
      },
    });

    expect(summary).toMatchObject({
      badgeLabel: "External host active",
      badgeTone: "neutral",
    });
    expect(summary?.detail).toContain("already-running local voice host");
  });

  it("surfaces host failures as restartable warnings", () => {
    const summary = describeDesktopVoiceHostLifecycle({
      enabled: true,
      hostMode: "desktop",
      speechService: {
        state: "error",
        managed: false,
        reachable: false,
        healthUrl: "http://127.0.0.1:8796/health",
        scriptPath: "/tmp/local-speech-service.mjs",
        lastError: "Speech service exited unexpectedly.",
      },
      providerHost: {
        state: "stopped",
        managed: false,
        reachable: false,
        healthUrl: "http://127.0.0.1:8797/health",
        scriptPath: "/tmp/local-provider-host.mjs",
      },
    });

    expect(summary).toMatchObject({
      badgeLabel: "Desktop host unavailable",
      badgeTone: "warning",
      actionLabel: "Restart Desktop host",
    });
    expect(summary?.detail).toContain("Speech service failed");
    expect(summary?.detail).toContain("Speech service exited unexpectedly.");
  });
});
