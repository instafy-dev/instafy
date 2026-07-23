import { describe, expect, it } from "vitest";
import { describeDesktopSpeechTunnelLifecycle } from "../client";

describe("describeDesktopSpeechTunnelLifecycle", () => {
  it("summarizes an active desktop tunnel", () => {
    const summary = describeDesktopSpeechTunnelLifecycle({
      enabled: true,
      hostMode: "desktop",
      state: "active",
      managed: true,
      projectId: "project-123",
      tunnelId: "tunnel-123",
      publicUrl: "https://speech.example.com",
      hostname: "speech.example.com",
      localPort: 8796,
      readyPath: "/health",
    });

    expect(summary).toMatchObject({
      badgeLabel: "Desktop tunnel active",
      badgeTone: "success",
      actionLabel: "Refresh Desktop tunnel",
    });
    expect(summary?.detail).toContain("speech.example.com");
  });

  it("surfaces tunnel errors as actionable warnings", () => {
    const summary = describeDesktopSpeechTunnelLifecycle({
      enabled: true,
      hostMode: "desktop",
      state: "error",
      managed: false,
      localPort: 8796,
      readyPath: "/health",
      lastError: "Tunnel grant failed.",
    });

    expect(summary).toMatchObject({
      badgeLabel: "Desktop tunnel unavailable",
      badgeTone: "warning",
      actionLabel: "Retry Desktop tunnel",
    });
    expect(summary?.detail).toContain("Tunnel grant failed.");
  });
});
