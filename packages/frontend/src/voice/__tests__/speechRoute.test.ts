import { describe, expect, it } from "vitest";
import {
  buildSpeechRouteHealthUrl,
  createEnvSpeechRoute,
  createSpeechRoute,
  describeSpeechRouteTransport,
  isSameSpeechRoute,
  selectReachableSpeechRoute,
  selectPreferredSpeechRoute,
} from "../speechRoute";

describe("speechRoute", () => {
  it("normalizes shared route values", () => {
    expect(
      createSpeechRoute({
        baseUrl: " https://speech.example.com/provider/ ",
        authToken: " shared-token ",
        connectionType: " TUNNEL ",
        hostMode: "desktop",
        updatedAt: "2026-04-14T08:00:00.000Z",
        source: "project",
      }),
    ).toEqual({
      baseUrl: "https://speech.example.com/provider",
      authToken: "shared-token",
      connectionType: "tunnel",
      hostMode: "desktop",
      updatedAt: "2026-04-14T08:00:00.000Z",
      source: "project",
    });
  });

  it("classifies desktop lan and desktop tunnel routes distinctly", () => {
    expect(
      describeSpeechRouteTransport(
        createSpeechRoute({
          baseUrl: "http://192.168.1.20:8796",
          connectionType: "lan",
          hostMode: "desktop",
          source: "desktop_lan_discovery",
        })!,
      ),
    ).toBe("desktop_lan");

    expect(
      describeSpeechRouteTransport(
        createSpeechRoute({
          baseUrl: "https://speech.example.com/provider",
          connectionType: "tunnel",
          hostMode: "desktop",
          source: "project",
        })!,
      ),
    ).toBe("desktop_tunnel");
  });

  it("prefers a future desktop lan route over project and env candidates", () => {
    const selected = selectPreferredSpeechRoute([
      createEnvSpeechRoute({
        VITE_INSTAFY_SPEECH_BASE_URL: "https://env.example.com/provider",
        VITE_INSTAFY_SPEECH_TOKEN: "env-token",
      }),
      createSpeechRoute({
        baseUrl: "https://server.example.com/provider",
        connectionType: "direct",
        hostMode: "server",
        updatedAt: "2026-04-14T08:00:00.000Z",
        source: "project",
      }),
      createSpeechRoute({
        baseUrl: "http://192.168.1.20:8796",
        connectionType: "lan",
        hostMode: "desktop",
        updatedAt: "2026-04-14T08:05:00.000Z",
        source: "desktop_lan_discovery",
      }),
    ]);

    expect(selected).toEqual({
      baseUrl: "http://192.168.1.20:8796",
      authToken: null,
      connectionType: "lan",
      hostMode: "desktop",
      updatedAt: "2026-04-14T08:05:00.000Z",
      source: "desktop_lan_discovery",
    });
  });

  it("matches a saved desktop tunnel route by normalized base url and transport metadata", () => {
    const route = createSpeechRoute({
      baseUrl: " https://speech.example.com/provider/ ",
      connectionType: "tunnel",
      hostMode: "desktop",
      source: "project",
    });

    expect(
      isSameSpeechRoute(route, {
        baseUrl: "https://speech.example.com/provider",
        connectionType: "tunnel",
        hostMode: "desktop",
      }),
    ).toBe(true);
  });

  it("probes candidate health and falls back from desktop lan to desktop tunnel when LAN is unreachable", async () => {
    const fetchMock = async (input: URL | RequestInfo) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "http://192.168.1.20:8796/health") {
        throw new Error("network unreachable");
      }
      if (url === "https://speech.example.com/provider/health") {
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const selected = await selectReachableSpeechRoute(
      [
        createSpeechRoute({
          baseUrl: "http://192.168.1.20:8796",
          connectionType: "lan",
          hostMode: "desktop",
          source: "desktop_lan_discovery",
        }),
        createSpeechRoute({
          baseUrl: "https://speech.example.com/provider",
          connectionType: "tunnel",
          hostMode: "desktop",
          source: "project",
        }),
      ],
      {
        fetchImpl: fetchMock as typeof fetch,
      },
    );

    expect(selected?.baseUrl).toBe("https://speech.example.com/provider");
    expect(buildSpeechRouteHealthUrl(selected)).toBe("https://speech.example.com/provider/health");
  });

  it("can require a reachable route instead of falling back to the highest-priority candidate", async () => {
    const fetchMock = async () => {
      throw new Error("network unreachable");
    };

    const selected = await selectReachableSpeechRoute(
      [
        createSpeechRoute({
          baseUrl: "http://192.168.1.20:8796",
          connectionType: "lan",
          hostMode: "desktop",
          source: "desktop_lan_discovery",
        }),
      ],
      {
        fetchImpl: fetchMock as typeof fetch,
        fallbackToPreferred: false,
      },
    );

    expect(selected).toBeNull();
  });

  it("can use a custom probe implementation ahead of fetch health checks", async () => {
    const fetchMock = async () => {
      throw new Error("fetch should not run when a custom probe decides reachability");
    };

    const selected = await selectReachableSpeechRoute(
      [
        createSpeechRoute({
          baseUrl: "http://192.168.1.20:8796",
          connectionType: "lan",
          hostMode: "desktop",
          source: "desktop_lan_discovery",
        }),
      ],
      {
        fetchImpl: fetchMock as typeof fetch,
        probeImpl: async (route) => route.baseUrl === "http://192.168.1.20:8796",
        fallbackToPreferred: false,
      },
    );

    expect(selected?.baseUrl).toBe("http://192.168.1.20:8796");
  });
});
