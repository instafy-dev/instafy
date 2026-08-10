import { describe, expect, it, vi } from "vitest";
import type { ControllerRequestContext } from "../../../services/runtimeController/core";
import type { DesktopSpeechTunnelBridgeStatus } from "../client";
import { syncDesktopSpeechRouteForProject } from "../sync";

const controllerAContext: ControllerRequestContext = {
  baseUrl: "https://controller-a.example.com",
  accessToken: "token-a",
  credentialSource: "ambient",
  generation: 1,
};

const controllerBContext: ControllerRequestContext = {
  baseUrl: "https://controller-b.example.com",
  accessToken: "token-b",
  credentialSource: "fixed",
  generation: 2,
};

const healthyDesktopHost = {
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
} as const;

function activeTunnel(input: {
  projectId?: string;
  publicUrl?: string;
  requestContext?: ControllerRequestContext;
  controllerBindingId?: string;
} = {}): DesktopSpeechTunnelBridgeStatus {
  const requestContext = input.requestContext ?? controllerAContext;
  const publicUrl = input.publicUrl ?? "https://speech.example.com";
  return {
    enabled: true,
    hostMode: "desktop",
    state: "active",
    managed: true,
    projectId: input.projectId ?? "project-123",
    controllerUrl: requestContext.baseUrl,
    controllerCredentialMode:
      requestContext.credentialSource === "ambient" ? "ambient" : "fixed",
    controllerBindingId: input.controllerBindingId ?? "binding-current",
    tunnelId: "tunnel-123",
    publicUrl,
    hostname: new URL(publicUrl).hostname,
    localPort: 8796,
    readyPath: "/health",
  };
}

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
            ...healthyDesktopHost,
            speechService: {
              ...healthyDesktopHost.speechService,
              state: "starting",
              reachable: false,
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

  it("starts the Desktop tunnel with the exact controller context and persists its binding", async () => {
    const startDesktopSpeechTunnel = vi
      .fn()
      .mockResolvedValue(activeTunnel({ requestContext: controllerAContext }));
    const readProjectSpeechRoutes = vi.fn().mockResolvedValue([]);
    const writeProjectSpeechRoutes = vi.fn().mockResolvedValue({
      success: true,
      scope: "project",
    });

    await expect(
      syncDesktopSpeechRouteForProject(
        {
          projectId: "project-123",
          controllerUrl: "https://stale-controller.example.com",
        },
        {
          readDesktopVoiceHostStatus: async () => healthyDesktopHost,
          startDesktopSpeechTunnel,
          resolveControllerRequestContext: async () => controllerAContext,
          readProjectSpeechRoutes,
          writeProjectSpeechRoutes,
        },
      ),
    ).resolves.toEqual({
      status: "synced",
      managedRoute: {
        projectId: "project-123",
        publicUrl: "https://speech.example.com",
        lanBaseUrl: null,
        controllerRequestContext: controllerAContext,
        controllerBindingId: "binding-current",
      },
    });

    expect(startDesktopSpeechTunnel).toHaveBeenCalledWith({
      projectId: "project-123",
      controllerUrl: controllerAContext.baseUrl,
      controllerAccessToken: controllerAContext.accessToken,
      controllerCredentialMode: "ambient",
      forceRestart: false,
    });
    expect(readProjectSpeechRoutes).toHaveBeenCalledWith(
      "project-123",
      "token-a",
      controllerAContext,
    );
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
      "token-a",
      controllerAContext,
    );
  });

  it("cleans up a same-project route through its originating controller after a controller switch", async () => {
    const oldManagedRoute = {
      projectId: "project-123",
      publicUrl: "https://old-speech.example.com",
      lanBaseUrl: null,
      controllerRequestContext: {
        ...controllerAContext,
        accessToken: "old-token-a",
      },
      controllerBindingId: "binding-old",
    };
    const startDesktopSpeechTunnel = vi.fn().mockResolvedValue(
      activeTunnel({
        requestContext: controllerBContext,
        publicUrl: "https://new-speech.example.com",
        controllerBindingId: "binding-new",
      }),
    );
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
    const writeProjectSpeechRoutes = vi.fn().mockResolvedValue({
      success: true,
      scope: "project",
    });

    const result = await syncDesktopSpeechRouteForProject(
      {
        projectId: "project-123",
        controllerUrl: controllerBContext.baseUrl,
        previousManagedRoute: oldManagedRoute,
      },
      {
        readDesktopVoiceHostStatus: async () => healthyDesktopHost,
        startDesktopSpeechTunnel,
        resolveControllerRequestContext: async () => controllerBContext,
        readProjectSpeechRoutes,
        writeProjectSpeechRoutes,
      },
    );

    expect(result).toEqual({
      status: "synced",
      managedRoute: {
        projectId: "project-123",
        publicUrl: "https://new-speech.example.com",
        lanBaseUrl: null,
        controllerRequestContext: controllerBContext,
        controllerBindingId: "binding-new",
      },
    });
    expect(readProjectSpeechRoutes).toHaveBeenNthCalledWith(
      1,
      "project-123",
      "token-b",
      controllerBContext,
    );
    expect(readProjectSpeechRoutes).toHaveBeenNthCalledWith(
      2,
      "project-123",
      "old-token-a",
      oldManagedRoute.controllerRequestContext,
    );
    expect(writeProjectSpeechRoutes).toHaveBeenNthCalledWith(
      1,
      "project-123",
      [
        {
          baseUrl: "https://new-speech.example.com",
          authToken: "speech-token",
          connectionType: "tunnel",
          hostMode: "desktop",
        },
      ],
      "token-b",
      controllerBContext,
    );
    expect(writeProjectSpeechRoutes).toHaveBeenNthCalledWith(
      2,
      "project-123",
      null,
      "old-token-a",
      oldManagedRoute.controllerRequestContext,
    );
  });

  it("publishes both LAN and tunnel Desktop routes when LAN is available", async () => {
    const writeProjectSpeechRoutes = vi.fn().mockResolvedValue({
      success: true,
      scope: "project",
    });

    const result = await syncDesktopSpeechRouteForProject(
      {
        projectId: "project-123",
        controllerUrl: controllerAContext.baseUrl,
      },
      {
        readDesktopVoiceHostStatus: async () => ({
          ...healthyDesktopHost,
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
        }),
        startDesktopSpeechTunnel: async () => activeTunnel(),
        resolveControllerRequestContext: async () => controllerAContext,
        readProjectSpeechRoutes: async () => [],
        writeProjectSpeechRoutes,
      },
    );

    expect(result).toEqual({
      status: "synced",
      managedRoute: {
        projectId: "project-123",
        publicUrl: "https://speech.example.com",
        lanBaseUrl: "http://192.168.1.20:8796",
        controllerRequestContext: controllerAContext,
        controllerBindingId: "binding-current",
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
      "token-a",
      controllerAContext,
    );
  });

  it("rewrites the Desktop tunnel route when only the auth token changes", async () => {
    const writeProjectSpeechRoutes = vi.fn().mockResolvedValue({
      success: true,
      scope: "project",
    });

    const result = await syncDesktopSpeechRouteForProject(
      {
        projectId: "project-123",
        controllerUrl: controllerAContext.baseUrl,
      },
      {
        readDesktopVoiceHostStatus: async () => ({
          ...healthyDesktopHost,
          speechAuthToken: "fresh-speech-token",
        }),
        startDesktopSpeechTunnel: async () => activeTunnel(),
        resolveControllerRequestContext: async () => controllerAContext,
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
    );

    expect(result.status).toBe("synced");
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
      "token-a",
      controllerAContext,
    );
  });

  it("does not publish a route when Desktop returns a different controller binding", async () => {
    const readProjectSpeechRoutes = vi.fn();
    const writeProjectSpeechRoutes = vi.fn();

    const result = await syncDesktopSpeechRouteForProject(
      {
        projectId: "project-123",
        controllerUrl: controllerBContext.baseUrl,
      },
      {
        readDesktopVoiceHostStatus: async () => healthyDesktopHost,
        startDesktopSpeechTunnel: async () => activeTunnel({ requestContext: controllerAContext }),
        resolveControllerRequestContext: async () => controllerBContext,
        readProjectSpeechRoutes,
        writeProjectSpeechRoutes,
      },
    );

    expect(result).toEqual({
      status: "error",
      error: "Desktop speech tunnel is unavailable.",
      managedRoute: null,
    });
    expect(readProjectSpeechRoutes).not.toHaveBeenCalled();
    expect(writeProjectSpeechRoutes).not.toHaveBeenCalled();
  });
});
