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

  it("enables routine approval only with the negotiated capability", () => {
    expect(mapRuntimeBrowserSessionCapabilitiesPayload({ ...capabilitiesPayload, approvalModes: ["ask", "routine"] })?.approvalModes).toEqual(["ask", "routine"]);
    for (const approvalModes of [undefined, null, "routine", ["routine"], ["ask", "unknown"], ["ask", "routine", "unknown"]]) {
      expect(mapRuntimeBrowserSessionCapabilitiesPayload({ ...capabilitiesPayload, approvalModes })?.approvalModes).toBeUndefined();
    }
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
  function humanInputRequest(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      handoffId: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000002",
      initiatorUserId: "00000000-0000-4000-8000-000000000003",
      browserPageId: "page-1",
      origin: "https://example.test",
      createdAtMs: 1000,
      expiresAtMs: 601000,
      fields: [{ label: "Highlighted field 1" }],
      ...overrides,
    };
  }

  it("maps valid actions with the cursor and drops malformed/unknown entries", () => {
    const result = mapRuntimeBrowserSessionActionsPayload({
      cursor: 512,
      actions: [
        { seq: 1, ts: 10, type: "navigate", label: "Go to x", url: "https://x.test" },
        {
          seq: 2,
          ts: 20,
          pageId: "target_A-1",
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
        pageId: null,
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
        pageId: "target_A-1",
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

  it("does not normalize malformed page IDs into another target identity", () => {
    const pageIds = [undefined, null, false, "", " target_A-1 ", "target/A-1", "target_A-1\n", "x".repeat(257)];
    const result = mapRuntimeBrowserSessionActionsPayload({
      actions: pageIds.map((pageId, seq) => ({ seq, type: "click", pageId })),
      cursor: 100,
    });
    expect(result.actions).toHaveLength(pageIds.length);
    expect(result.actions.every((action) => action.pageId === null)).toBe(true);
  });

  it("preserves only a valid page-bound human-input request", () => {
    const request = humanInputRequest();
    const result = mapRuntimeBrowserSessionActionsPayload({
      actions: [
        { seq: 1, type: "human_input", pageId: "page-1", humanInputRequest: request },
        { seq: 2, type: "click", pageId: "page-1", humanInputRequest: request },
        { seq: 3, type: "human_input", pageId: "page-2", humanInputRequest: request },
        { seq: 4, type: "human_input", humanInputRequest: request },
        { seq: 5, type: "human_input", pageId: "page-1" },
      ],
      cursor: 500,
    });
    expect(result.actions.map((action) => action.seq)).toEqual([1, 2]);
    expect(result.actions[0].humanInputRequest).toEqual(request);
    expect(result.actions[1].humanInputRequest).toBeUndefined();
  });

  it.each([
    { version: 2 },
    { handoffId: "not-a-uuid" },
    { handoffId: "00000000-0000-4000-8000-000000000001\n" },
    { runId: "00000000-0000-4000-8000-00000000000A" },
    { initiatorUserId: "" },
    { browserPageId: " page-1" },
    { origin: "https://example.test/path" },
    { origin: "https://user:password@example.test" },
    { origin: "file:///tmp/example" },
    { origin: "https://example.test/" },
    { createdAtMs: 0 },
    { createdAtMs: 1.5 },
    { expiresAtMs: 1000 },
    { expiresAtMs: 601001 },
    { expiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { fields: [] },
    { fields: Array.from({ length: 9 }, () => ({ label: "Highlighted field" })) },
    { fields: [{ label: "" }] },
    { fields: [{ label: "ü".repeat(41) }] },
    { fields: [{ label: "\n" }] },
    { fields: [{ label: "Highlighted field 1", value: "must not be forwarded" }] },
    { instructions: "must not be forwarded" },
  ])("drops malformed human-input guidance: %j", (overrides) => {
    const result = mapRuntimeBrowserSessionActionsPayload({
      actions: [{ seq: 1, type: "human_input", pageId: "page-1", humanInputRequest: humanInputRequest(overrides) }],
      cursor: 100,
    });
    expect(result.actions).toEqual([]);
    expect(result.cursor).toBe(100);
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
