import { describe, expect, it } from "vitest";
import {
  deriveDiscoveredDesktopLanSpeechRoutes,
  describeDesktopLanTokenHint,
} from "../desktopLanDiscovery";
import type { ProjectSpeechRoute } from "../projectSpeechRoute";

describe("desktopLanDiscovery", () => {
  it("derives a discovered desktop LAN route from a matching token hint", () => {
    const projectRoutes = [
      {
        baseUrl: "http://192.168.1.40:8796",
        authToken: "desktop-lan-token-value",
        connectionType: "lan" as const,
        hostMode: "desktop" as const,
        updatedAt: "2026-04-14T10:00:00.000Z",
        source: "project" as const,
      },
    ] satisfies ProjectSpeechRoute[];

    expect(
      deriveDiscoveredDesktopLanSpeechRoutes(projectRoutes, [
        {
          serviceName: "Instafy Taylor",
          serviceType: "_instafy-speech._tcp.",
          host: "instafy-macbook.local",
          port: 8796,
          baseUrl: "http://instafy-macbook.local:8796",
          tokenHint: describeDesktopLanTokenHint("desktop-lan-token-value"),
          hostMode: "desktop",
          authRequired: true,
          updatedAt: "2026-04-14T10:05:00.000Z",
        },
      ]),
    ).toEqual([
      {
        baseUrl: "http://instafy-macbook.local:8796",
        authToken: "desktop-lan-token-value",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T10:05:00.000Z",
        source: "desktop_lan_discovery",
      },
    ]);
  });

  it("ignores services with the wrong token hint or host mode", () => {
    const projectRoutes = [
      {
        baseUrl: "http://192.168.1.40:8796",
        authToken: "desktop-lan-token-value",
        connectionType: "lan" as const,
        hostMode: "desktop" as const,
        updatedAt: "2026-04-14T10:00:00.000Z",
        source: "project" as const,
      },
    ] satisfies ProjectSpeechRoute[];

    expect(
      deriveDiscoveredDesktopLanSpeechRoutes(projectRoutes, [
        {
          serviceName: "Wrong host mode",
          serviceType: "_instafy-speech._tcp.",
          host: "server.local",
          port: 8796,
          baseUrl: "http://server.local:8796",
          tokenHint: describeDesktopLanTokenHint("desktop-lan-token-value"),
          hostMode: "server",
          authRequired: true,
          updatedAt: "2026-04-14T10:05:00.000Z",
        },
        {
          serviceName: "Wrong token",
          serviceType: "_instafy-speech._tcp.",
          host: "instafy-macbook.local",
          port: 8796,
          baseUrl: "http://instafy-macbook.local:8796",
          tokenHint: "nope…nope",
          hostMode: "desktop",
          authRequired: true,
          updatedAt: "2026-04-14T10:05:00.000Z",
        },
      ]),
    ).toEqual([]);
  });

  it("dedupes repeated discovered services that resolve to the same route", () => {
    const projectRoutes = [
      {
        baseUrl: "http://192.168.1.40:8796",
        authToken: "desktop-lan-token-value",
        connectionType: "lan" as const,
        hostMode: "desktop" as const,
        updatedAt: "2026-04-14T10:00:00.000Z",
        source: "project" as const,
      },
    ] satisfies ProjectSpeechRoute[];

    const routes = deriveDiscoveredDesktopLanSpeechRoutes(projectRoutes, [
      {
        serviceName: "Instafy Taylor",
        serviceType: "_instafy-speech._tcp.",
        host: "instafy-macbook.local",
        port: 8796,
        baseUrl: "http://instafy-macbook.local:8796",
        tokenHint: describeDesktopLanTokenHint("desktop-lan-token-value"),
        hostMode: "desktop",
        authRequired: true,
        updatedAt: "2026-04-14T10:05:00.000Z",
      },
      {
        serviceName: "Instafy Taylor duplicate",
        serviceType: "_instafy-speech._tcp.",
        host: "instafy-macbook.local",
        port: 8796,
        baseUrl: "http://instafy-macbook.local:8796",
        tokenHint: describeDesktopLanTokenHint("desktop-lan-token-value"),
        hostMode: "desktop",
        authRequired: true,
        updatedAt: "2026-04-14T10:05:30.000Z",
      },
    ]);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.baseUrl).toBe("http://instafy-macbook.local:8796");
  });

  it("falls back to a simulator loopback candidate when discovery is still scanning", () => {
    const projectRoutes = [
      {
        baseUrl: "http://192.0.2.10:50031",
        authToken: "desktop-lan-token-value",
        connectionType: "lan" as const,
        hostMode: "desktop" as const,
        updatedAt: "2026-04-14T10:00:00.000Z",
        source: "project" as const,
      },
    ] satisfies ProjectSpeechRoute[];

    expect(
      deriveDiscoveredDesktopLanSpeechRoutes(projectRoutes, [], {
        clientReachability: "loopback",
        updatedAt: "2026-04-14T10:05:00.000Z",
      }),
    ).toEqual([
      {
        baseUrl: "http://127.0.0.1:50031",
        authToken: "desktop-lan-token-value",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T10:05:00.000Z",
        source: "desktop_lan_discovery",
      },
    ]);
  });

  it("uses an explicit simulator fallback host override when provided", () => {
    const projectRoutes = [
      {
        baseUrl: "http://192.0.2.10:50031",
        authToken: "desktop-lan-token-value",
        connectionType: "lan" as const,
        hostMode: "desktop" as const,
        updatedAt: "2026-04-14T10:00:00.000Z",
        source: "project" as const,
      },
    ] satisfies ProjectSpeechRoute[];

    expect(
      deriveDiscoveredDesktopLanSpeechRoutes(
        projectRoutes,
        [],
        {
          clientReachability: "loopback",
          updatedAt: "2026-04-14T10:05:00.000Z",
        },
        "192.168.1.40",
      ),
    ).toEqual([
      {
        baseUrl: "http://192.168.1.40:50031",
        authToken: "desktop-lan-token-value",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T10:05:00.000Z",
        source: "desktop_lan_discovery",
      },
    ]);
  });

  it("uses an explicit fallback host override even when native discovery is unavailable", () => {
    const projectRoutes = [
      {
        baseUrl: "http://192.0.2.10:50031",
        authToken: "desktop-lan-token-value",
        connectionType: "lan" as const,
        hostMode: "desktop" as const,
        updatedAt: "2026-04-14T10:00:00.000Z",
        source: "project" as const,
      },
    ] satisfies ProjectSpeechRoute[];

    expect(
      deriveDiscoveredDesktopLanSpeechRoutes(projectRoutes, [], null, "127.0.0.1"),
    ).toEqual([
      {
        baseUrl: "http://127.0.0.1:50031",
        authToken: "desktop-lan-token-value",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T10:00:00.000Z",
        source: "desktop_lan_discovery",
      },
    ]);
  });

  it("uses a direct ui-test fallback route when only host and auth token overrides are available", () => {
    expect(
      deriveDiscoveredDesktopLanSpeechRoutes(
        [],
        [],
        {
          clientReachability: "lan",
          updatedAt: "2026-04-15T18:50:00.000Z",
        },
        "192.168.178.71:63017",
        "desktop-lan-token-value",
      ),
    ).toEqual([
      {
        baseUrl: "http://192.168.178.71:63017",
        authToken: "desktop-lan-token-value",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-15T18:50:00.000Z",
        source: "desktop_lan_discovery",
      },
    ]);
  });

  it("keeps the explicit ui-test fallback route when discovery finds a non-matching desktop host", () => {
    const projectRoutes = [
      {
        baseUrl: "http://192.0.2.10:64326",
        authToken: "desktop-lan-token-value",
        connectionType: "lan" as const,
        hostMode: "desktop" as const,
        updatedAt: "2026-04-15T18:54:35.909Z",
        source: "project" as const,
      },
    ] satisfies ProjectSpeechRoute[];

    expect(
      deriveDiscoveredDesktopLanSpeechRoutes(
        projectRoutes,
        [
          {
            serviceName: "Wrong token desktop host",
            serviceType: "_instafy-speech._tcp.",
            host: "192.168.178.71",
            port: 51186,
            baseUrl: "http://192.168.178.71:51186",
            tokenHint: "PTQM…rO_F",
            hostMode: "desktop",
            authRequired: true,
            updatedAt: "2026-04-15T18:56:35.073Z",
          },
        ],
        {
          clientReachability: "lan",
          updatedAt: "2026-04-15T18:56:35.073Z",
        },
        "192.168.178.71:64326",
        "desktop-lan-token-value",
      ),
    ).toEqual([
      {
        baseUrl: "http://192.168.178.71:64326",
        authToken: "desktop-lan-token-value",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-15T18:56:35.073Z",
        source: "desktop_lan_discovery",
      },
    ]);
  });
});
