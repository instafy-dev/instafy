import { describe, expect, it, vi } from "vitest";
import { syncDesktopSpeechRouteForProject } from "../sync";

describe("syncDesktopSpeechRouteForProject", () => {
  it("skips automatic tunnel publication until the Desktop host is healthy", async () => {
    const startDesktopSpeechTunnel = vi.fn();

    await expect(
      syncDesktopSpeechRouteForProject(
        {
          projectId: "project-123",
          controllerUrl: "https://controller.example.com",
        },
        {
          readDesktopVoiceHostStatus: async () => ({
            enabled: true,
            hostMode: "desktop",
            speechService: {
              state: "starting",
              managed: true,
              reachable: false,
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
          }),
          startDesktopSpeechTunnel,
        },
      ),
    ).resolves.toEqual({
      status: "skipped",
      reason: "desktop_host_unavailable",
      managedRoute: null,
    });

    expect(startDesktopSpeechTunnel).not.toHaveBeenCalled();
  });

  it("starts the Desktop tunnel and persists the active project route", async () => {
    const startDesktopSpeechTunnel = vi.fn().mockResolvedValue({
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
    const writeProjectSpeechRoutes = vi.fn().mockResolvedValue({
      success: true,
      scope: "project",
    });

    await expect(
      syncDesktopSpeechRouteForProject(
        {
          projectId: "project-123",
          controllerUrl: "https://controller.example.com",
        },
        {
          readDesktopVoiceHostStatus: async () => ({
            enabled: true,
            hostMode: "desktop",
            speechAuthToken: "speech-token",
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
          }),
          readDesktopSpeechTunnelStatus: async () => null,
          startDesktopSpeechTunnel,
          resolveControllerAccessToken: async () => "access-token",
          readProjectSpeechRoutes: async () => [],
          writeProjectSpeechRoutes,
        },
      ),
    ).resolves.toEqual({
      status: "synced",
      managedRoute: {
        projectId: "project-123",
        publicUrl: "https://speech.example.com",
        lanBaseUrl: null,
      },
    });

    expect(startDesktopSpeechTunnel).toHaveBeenCalledWith({
      projectId: "project-123",
      controllerUrl: "https://controller.example.com",
      controllerAccessToken: "access-token",
      forceRestart: false,
    });
    expect(writeProjectSpeechRoutes).toHaveBeenCalledWith(
      "project-123",
      [
        {
          baseUrl: "https://speech.example.com",
          authToken: "speech-token",
          connectionType: "tunnel",
          hostMode: "desktop",
        },
      ],
      "access-token",
    );
  });

  it("clears the previously managed project route when the tunnel moves to another project", async () => {
    const writeProjectSpeechRoutes = vi.fn().mockResolvedValue({
      success: true,
      scope: "project",
    });
    const readProjectSpeechRoutes = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          baseUrl: "https://old-speech.example.com",
          authToken: null,
          connectionType: "tunnel",
          hostMode: "desktop",
          updatedAt: "2026-04-13T12:00:00.000Z",
          source: "project",
        },
      ]);

    await expect(
      syncDesktopSpeechRouteForProject(
        {
          projectId: "project-456",
          controllerUrl: "https://controller.example.com",
          previousManagedRoute: {
            projectId: "project-123",
            publicUrl: "https://old-speech.example.com",
          },
        },
        {
          readDesktopVoiceHostStatus: async () => ({
            enabled: true,
            hostMode: "desktop",
            speechAuthToken: "speech-token",
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
          }),
          readDesktopSpeechTunnelStatus: async () => ({
            enabled: true,
            hostMode: "desktop",
            state: "active",
            managed: true,
            projectId: "project-456",
            tunnelId: "tunnel-456",
            publicUrl: "https://new-speech.example.com",
            hostname: "new-speech.example.com",
            localPort: 8796,
            readyPath: "/health",
          }),
          resolveControllerAccessToken: async () => "access-token",
          readProjectSpeechRoutes,
          writeProjectSpeechRoutes,
        },
      ),
    ).resolves.toEqual({
      status: "synced",
      managedRoute: {
        projectId: "project-456",
        publicUrl: "https://new-speech.example.com",
        lanBaseUrl: null,
      },
    });

    expect(writeProjectSpeechRoutes).toHaveBeenNthCalledWith(
      1,
      "project-456",
      [
        {
          baseUrl: "https://new-speech.example.com",
          authToken: "speech-token",
          connectionType: "tunnel",
          hostMode: "desktop",
        },
      ],
      "access-token",
    );
    expect(writeProjectSpeechRoutes).toHaveBeenNthCalledWith(2, "project-123", null, "access-token");
  });

  it("publishes both LAN and tunnel Desktop routes when LAN is available", async () => {
    const writeProjectSpeechRoutes = vi.fn().mockResolvedValue({
      success: true,
      scope: "project",
    });

    await expect(
      syncDesktopSpeechRouteForProject(
        {
          projectId: "project-123",
          controllerUrl: "https://controller.example.com",
        },
        {
          readDesktopVoiceHostStatus: async () => ({
            enabled: true,
            hostMode: "desktop",
            speechAuthToken: "speech-token",
            lan: {
              state: "available",
              bindHost: "0.0.0.0",
              healthHost: "127.0.0.1",
              port: 8796,
              healthUrl: "http://127.0.0.1:8796/health",
              publicHost: "192.168.1.20",
              baseUrl: "http://192.168.1.20:8796",
              authRequired: true,
              authToken: "lan-token",
            },
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
          }),
          readDesktopSpeechTunnelStatus: async () => ({
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
          }),
          resolveControllerAccessToken: async () => "access-token",
          readProjectSpeechRoutes: async () => [],
          writeProjectSpeechRoutes,
        },
      ),
    ).resolves.toEqual({
      status: "synced",
      managedRoute: {
        projectId: "project-123",
        publicUrl: "https://speech.example.com",
        lanBaseUrl: "http://192.168.1.20:8796",
      },
    });

    expect(writeProjectSpeechRoutes).toHaveBeenCalledWith(
      "project-123",
      [
        {
          baseUrl: "http://192.168.1.20:8796",
          authToken: "speech-token",
          connectionType: "lan",
          hostMode: "desktop",
        },
        {
          baseUrl: "https://speech.example.com",
          authToken: "speech-token",
          connectionType: "tunnel",
          hostMode: "desktop",
        },
      ],
      "access-token",
    );
  });

  it("rewrites the Desktop tunnel route when only the auth token changes", async () => {
    const writeProjectSpeechRoutes = vi.fn().mockResolvedValue({
      success: true,
      scope: "project",
    });

    await expect(
      syncDesktopSpeechRouteForProject(
        {
          projectId: "project-123",
          controllerUrl: "https://controller.example.com",
        },
        {
          readDesktopVoiceHostStatus: async () => ({
            enabled: true,
            hostMode: "desktop",
            speechAuthToken: "fresh-speech-token",
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
          }),
          readDesktopSpeechTunnelStatus: async () => ({
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
          }),
          resolveControllerAccessToken: async () => "access-token",
          readProjectSpeechRoutes: async () => [
            {
              baseUrl: "https://speech.example.com",
              authToken: null,
              connectionType: "tunnel",
              hostMode: "desktop",
              updatedAt: "2026-04-15T08:00:00.000Z",
              source: "project",
            },
          ],
          writeProjectSpeechRoutes,
        },
      ),
    ).resolves.toEqual({
      status: "synced",
      managedRoute: {
        projectId: "project-123",
        publicUrl: "https://speech.example.com",
        lanBaseUrl: null,
      },
    });

    expect(writeProjectSpeechRoutes).toHaveBeenCalledWith(
      "project-123",
      [
        {
          baseUrl: "https://speech.example.com",
          authToken: "fresh-speech-token",
          connectionType: "tunnel",
          hostMode: "desktop",
        },
      ],
      "access-token",
    );
  });
});
