import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestOriginAccessTokenMock } = vi.hoisted(() => ({
  requestOriginAccessTokenMock: vi.fn(),
}));

vi.mock("../runtimeController/origins", () => ({
  requestOriginAccessToken: requestOriginAccessTokenMock,
}));

import {
  browserSessionStatusIndicatesUnavailable,
  BrowserSessionCapabilitiesIncompatibleError,
  BrowserSessionUnavailableError,
  commandRuntimeBrowserSessionPage,
  fetchRuntimeBrowserSessionActions,
  fetchRuntimeBrowserSessionCapabilities,
  fetchRuntimeBrowserSessionPages,
  focusRuntimeBrowserSessionPage,
  isBrowserSessionUnavailableError,
  mapRuntimeBrowserSessionActionsPayload,
  mapRuntimeBrowserSessionCapabilitiesPayload,
  mapRuntimeBrowserSessionPagesPayload,
} from "../runtimeController/browserSession";

beforeEach(() => {
  requestOriginAccessTokenMock.mockReset();
  requestOriginAccessTokenMock.mockImplementation(
    async ({ scopes }: { scopes: string[] }) => ({
      originId: "origin-1",
      endpoint: "https://origin.example.test/",
      mode: "hosted",
      token: "origin-token",
      expiresIn: 60,
      scopes,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapRuntimeBrowserSessionPagesPayload", () => {
  it("maps valid runtime browser pages and drops malformed entries", () => {
    expect(
      mapRuntimeBrowserSessionPagesPayload({
        pages: [
          {
            id: "page-1",
            url: "https://www.bbc.com/",
            host: "bbc.com",
            label: "BBC Home",
            title: "BBC Home",
            isActive: true,
            canGoBack: true,
            canGoForward: false,
          },
          {
            id: "",
            url: "https://en.wikipedia.org/wiki/Pear",
            label: "Pear",
          },
        ],
      }),
    ).toEqual([
      {
        id: "page-1",
        url: "https://www.bbc.com/",
        host: "bbc.com",
        label: "BBC Home",
        title: "BBC Home",
        isActive: true,
        canGoBack: true,
        canGoForward: false,
      },
    ]);
  });

  it("returns an empty list for invalid payloads", () => {
    expect(mapRuntimeBrowserSessionPagesPayload(null)).toEqual([]);
    expect(mapRuntimeBrowserSessionPagesPayload({})).toEqual([]);
  });

  it("treats stale browser-session statuses as unavailable", () => {
    expect(browserSessionStatusIndicatesUnavailable(404)).toBe(true);
    expect(browserSessionStatusIndicatesUnavailable(503)).toBe(true);
    expect(browserSessionStatusIndicatesUnavailable(502)).toBe(true);
    expect(browserSessionStatusIndicatesUnavailable(500)).toBe(false);
  });

  it("detects browser session unavailable errors", () => {
    expect(
      isBrowserSessionUnavailableError(
        new BrowserSessionUnavailableError(503, "browser pages unavailable"),
      ),
    ).toBe(true);
    expect(isBrowserSessionUnavailableError(new Error("nope"))).toBe(false);
  });
});

describe("runtime browser session capabilities", () => {
  const capabilitiesPayload = {
    version: 2,
    viewerKinds: ["rfb", "future-viewer"],
    preferredViewer: "rfb",
    viewportOnly: true,
    rfb: {
      renderScale: 2,
      maxFramebufferPixels: 8_294_400,
    },
    controls: {
      navigate: true,
      history: true,
      reload: true,
      focusPage: true,
    },
  };

  it("maps supported viewer kinds and rejects incompatible payloads", () => {
    expect(mapRuntimeBrowserSessionCapabilitiesPayload(capabilitiesPayload)).toEqual({
      version: 2,
      viewerKinds: ["rfb"],
      preferredViewer: "rfb",
      viewportOnly: true,
      rfb: capabilitiesPayload.rfb,
      webrtc: null,
      controls: capabilitiesPayload.controls,
    });
    expect(
      mapRuntimeBrowserSessionCapabilitiesPayload({
        ...capabilitiesPayload,
        preferredViewer: "future-viewer",
      }),
    ).toEqual({
      version: 2,
      viewerKinds: ["rfb"],
      preferredViewer: "rfb",
      viewportOnly: true,
      rfb: capabilitiesPayload.rfb,
      webrtc: null,
      controls: capabilitiesPayload.controls,
    });
    expect(
      mapRuntimeBrowserSessionCapabilitiesPayload({
        ...capabilitiesPayload,
        rfb: { renderScale: 3, maxFramebufferPixels: 8_294_400 },
      }),
    ).toBeNull();
    expect(mapRuntimeBrowserSessionCapabilitiesPayload({ version: 1 })).toBeNull();
  });

  it("maps bounded WebRTC ICE configuration and requires its contract when advertised", () => {
    expect(
      mapRuntimeBrowserSessionCapabilitiesPayload({
        ...capabilitiesPayload,
        viewerKinds: ["webrtc", "rfb"],
        preferredViewer: "webrtc",
        webrtc: {
          relayOnly: true,
          iceServers: [
            {
              urls: [" turns:turn.example.test:5349 ", "https://invalid.example.test"],
              username: " user ",
              credential: " secret ",
            },
          ],
        },
      }),
    ).toMatchObject({
      viewerKinds: ["webrtc", "rfb"],
      preferredViewer: "webrtc",
      webrtc: {
        relayOnly: true,
        iceServers: [
          {
            urls: ["turns:turn.example.test:5349"],
            username: "user",
            credential: "secret",
          },
        ],
      },
    });

    expect(
      mapRuntimeBrowserSessionCapabilitiesPayload({
        ...capabilitiesPayload,
        viewerKinds: ["webrtc", "rfb"],
        preferredViewer: "webrtc",
      }),
    ).toBeNull();
  });

  it("fetches capabilities with a browser-view origin token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(capabilitiesPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchRuntimeBrowserSessionCapabilities({
        projectId: "project-1",
        browserSessionId: "browser-surface-1",
        preferRuntimeId: "runtime-1",
      }),
    ).resolves.toMatchObject({ preferredViewer: "rfb", viewportOnly: true });

    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        preferRuntime: "runtime-1",
        scopes: ["browser.view"],
        browserSessionId: "browser-surface-1",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://origin.example.test/browser/capabilities",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer origin-token" }),
      }),
    );
  });

  it("distinguishes an incompatible capability document from a legacy missing route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ version: 2, viewerKinds: ["webrtc"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      fetchRuntimeBrowserSessionCapabilities({
        projectId: "project-1",
        browserSessionId: "browser-surface-1",
      }),
    ).rejects.toBeInstanceOf(BrowserSessionCapabilitiesIncompatibleError);
  });
});

describe("runtime browser session page controls", () => {
  it("requests placeholder pages only when explicitly enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ pages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchRuntimeBrowserSessionPages({
      projectId: "project-1",
      browserSessionId: "browser-surface-1",
      includePlaceholder: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://origin.example.test/browser/pages?includePlaceholder=true",
      expect.any(Object),
    );
    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["browser.view"],
        browserSessionId: "browser-surface-1",
      }),
    );
  });

  it("sends page commands with browser control and a refresh-safe payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      commandRuntimeBrowserSessionPage({
        projectId: "project-1",
        browserSessionId: "browser-surface-1",
        pageId: "page/one",
        action: "navigate",
        url: " https://example.com/path ",
      }),
    ).resolves.toBe(true);

    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["browser.control"],
        browserSessionId: "browser-surface-1",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://origin.example.test/browser/pages/page%2Fone/command",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "navigate", url: "https://example.com/path" }),
      }),
    );
  });

  it("uses browser control for page focus", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      focusRuntimeBrowserSessionPage({
        projectId: "project-1",
        browserSessionId: "browser-surface-1",
        pageId: "page-1",
      }),
    ).resolves.toBe(true);

    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["browser.control"],
        browserSessionId: "browser-surface-1",
      }),
    );
  });

  it("uses browser view to read the browser action stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ actions: [], cursor: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      fetchRuntimeBrowserSessionActions({
        projectId: "project-1",
        browserSessionId: "browser-surface-1",
      }),
    ).resolves.toEqual({ actions: [], cursor: 0 });

    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["browser.view"],
        browserSessionId: "browser-surface-1",
      }),
    );
  });
});

describe("mapRuntimeBrowserSessionActionsPayload", () => {
  it("maps valid actions with the cursor and drops malformed/unknown entries", () => {
    const result = mapRuntimeBrowserSessionActionsPayload({
      cursor: 512,
      actions: [
        { seq: 1, ts: 10, type: "navigate", label: "Go to x", url: "https://x.test" },
        {
          seq: 2,
          ts: 20,
          type: "click",
          label: 'Click "Apply"',
          x: 40,
          y: 12,
          viewportW: 1280,
          viewportH: 640,
        },
        { seq: 3, type: "teleport", label: "not a real type" }, // dropped: unknown type
        { type: "click", label: "no seq" }, // dropped: no numeric seq
        "garbage", // dropped: not an object
      ],
    });

    expect(result.cursor).toBe(512);
    expect(result.actions).toEqual([
      {
        seq: 1,
        ts: 10,
        type: "navigate",
        label: "Go to x",
        url: "https://x.test",
        x: null,
        y: null,
        viewportW: null,
        viewportH: null,
      },
      {
        seq: 2,
        ts: 20,
        type: "click",
        label: 'Click "Apply"',
        url: null,
        x: 40,
        y: 12,
        viewportW: 1280,
        viewportH: 640,
      },
    ]);
  });

  it("defaults cursor and actions for empty or malformed payloads", () => {
    expect(mapRuntimeBrowserSessionActionsPayload(null)).toEqual({ actions: [], cursor: 0 });
    expect(mapRuntimeBrowserSessionActionsPayload({})).toEqual({ actions: [], cursor: 0 });
    expect(mapRuntimeBrowserSessionActionsPayload({ cursor: -5, actions: "x" })).toEqual({
      actions: [],
      cursor: 0,
    });
  });
});
