import { describe, expect, it } from "vitest";
import { describeDesktopVoiceStatusSummary } from "../voiceStatusSummary";

describe("describeDesktopVoiceStatusSummary", () => {
  it("reports ready when the Desktop host is healthy and the current space tunnel is active", () => {
    expect(
      describeDesktopVoiceStatusSummary({
        activeProjectId: "project-123",
        hostStatus: {
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
        },
        tunnelStatus: {
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
        },
      }),
    ).toMatchObject({
      label: "Desktop voice ready",
      tone: "success",
    });
  });

  it("reports switching when the Desktop tunnel belongs to another space", () => {
    expect(
      describeDesktopVoiceStatusSummary({
        activeProjectId: "project-456",
        hostStatus: {
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
        },
        tunnelStatus: {
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
        },
      }),
    ).toMatchObject({
      label: "Desktop voice switching",
      tone: "neutral",
    });
  });

  it("reports repair when the Desktop host is unavailable", () => {
    expect(
      describeDesktopVoiceStatusSummary({
        activeProjectId: "project-123",
        hostStatus: {
          enabled: true,
          hostMode: "desktop",
          speechService: {
            state: "error",
            managed: false,
            reachable: false,
            healthUrl: "http://127.0.0.1:8796/health",
            scriptPath: "/tmp/local-speech-service.mjs",
            lastError: "Missing insanely-fast-whisper.",
          },
          providerHost: {
            state: "stopped",
            managed: false,
            reachable: false,
            healthUrl: "http://127.0.0.1:8797/health",
            scriptPath: "/tmp/local-provider-host.mjs",
          },
        },
      }),
    ).toMatchObject({
      label: "Desktop voice needs repair",
      tone: "warning",
    });
  });

  it("reports install progress when Desktop is bootstrapping the managed runtime", () => {
    expect(
      describeDesktopVoiceStatusSummary({
        activeProjectId: "project-123",
        hostStatus: {
          enabled: true,
          hostMode: "desktop",
          bootstrap: {
            state: "installing",
            automatic: true,
            action: "install_transcription",
            detail: "Instafy Desktop is installing the managed transcription runtime.",
          },
          speechService: {
            state: "error",
            managed: false,
            reachable: false,
            healthUrl: "http://127.0.0.1:8796/health",
            scriptPath: "/tmp/local-speech-service.mjs",
          },
          providerHost: {
            state: "stopped",
            managed: false,
            reachable: false,
            healthUrl: "http://127.0.0.1:8797/health",
            scriptPath: "/tmp/local-provider-host.mjs",
          },
        },
      }),
    ).toMatchObject({
      label: "Desktop voice installing",
      tone: "neutral",
    });
  });

  it("stays quiet in the top bar when Desktop voice hosting is turned off", () => {
    expect(
      describeDesktopVoiceStatusSummary({
        activeProjectId: "project-123",
        hostStatus: {
          enabled: false,
          hostMode: "desktop",
          speechService: {
            state: "stopped",
            managed: false,
            reachable: false,
            healthUrl: "http://127.0.0.1:8796/health",
            scriptPath: "/tmp/local-speech-service.mjs",
          },
          providerHost: {
            state: "stopped",
            managed: false,
            reachable: false,
            healthUrl: "http://127.0.0.1:8797/health",
            scriptPath: "/tmp/local-provider-host.mjs",
          },
        },
      }),
    ).toBeNull();
  });
});
