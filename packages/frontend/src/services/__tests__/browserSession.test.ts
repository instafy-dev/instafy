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
  fetchSharedBrowserHost,
  focusRuntimeBrowserSessionPage,
  isBrowserSessionUnavailableError,
  keepRuntimeBrowserSessionPage,
  isSharedBrowserHostRefusedError,
  mapSharedBrowserHostPayload,
  readBrowserErrorCode,
  SharedBrowserHostNotFoundError,
  SharedBrowserHostRefusedError,
  SharedBrowserHostTokenError,
  startSharedBrowserHost,
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
  it("keeps the badge of Octo's tabs and whether a person kept one", () => {
    const pages = mapRuntimeBrowserSessionPagesPayload({
      pages: [
        { id: "page-1", url: "https://example.com/", host: "example.com", label: "Example" },
        { id: "tab-1", url: "https://docs.example/", host: "docs.example", label: "Docs", openedBy: "agent" },
        { id: "tab-2", url: "https://maps.example/", host: "maps.example", label: "Map", openedBy: "agent", kept: true },
        // "kept" means nothing on a tab that is not Octo's.
        { id: "page-2", url: "https://other.example/", host: "other.example", label: "Other", kept: true },
      ],
    });
    expect(pages.map((page) => [page.id, page.openedBy === "agent", page.kept ?? false])).toEqual([
      ["page-1", false, false],
      ["tab-1", true, false],
      ["tab-2", true, true],
      ["page-2", false, false],
    ]);
  });

  it("keeps the number each of Octo's tabs keeps while it is open", () => {
    const pages = mapRuntimeBrowserSessionPagesPayload({
      pages: [
        { id: "tab-1", url: "https://docs.example/", host: "docs.example", label: "Docs", openedBy: "agent", agentTabNumber: 2 },
        // A number means nothing on a tab that is not Octo's, or out of bounds.
        { id: "page-1", url: "https://example.com/", host: "example.com", label: "Example", agentTabNumber: 1 },
        { id: "tab-2", url: "https://maps.example/", host: "maps.example", label: "Map", openedBy: "agent", agentTabNumber: 0 },
        { id: "tab-3", url: "https://maps.example/", host: "maps.example", label: "Map", openedBy: "agent", agentTabNumber: "3" },
        { id: "tab-4", url: "https://maps.example/", host: "maps.example", label: "Map", openedBy: "agent", agentTabNumber: 1.5 },
        { id: "tab-5", url: "https://maps.example/", host: "maps.example", label: "Map", openedBy: "agent", agentTabNumber: 1000 },
      ],
    });
    expect(pages.map((page) => [page.id, page.agentTabNumber ?? null])).toEqual([
      ["tab-1", 2],
      ["page-1", null],
      ["tab-2", null],
      ["tab-3", null],
      ["tab-4", null],
      ["tab-5", null],
    ]);
  });

  it("keeps which of Octo's tabs an earlier run left open", () => {
    const pages = mapRuntimeBrowserSessionPagesPayload({
      pages: [
        { id: "tab-1", url: "https://docs.example/", host: "docs.example", label: "Docs", openedBy: "agent", leftover: true },
        { id: "tab-2", url: "https://docs.example/", host: "docs.example", label: "Docs", openedBy: "agent", agentTabNumber: 1 },
        // "leftover" means nothing on a tab that is not Octo's, or unless it is true.
        { id: "page-1", url: "https://example.com/", host: "example.com", label: "Example", leftover: true },
        { id: "tab-3", url: "https://docs.example/", host: "docs.example", label: "Docs", openedBy: "agent", leftover: "yes" },
      ],
    });
    expect(pages.map((page) => [page.id, page.leftover ?? false])).toEqual([
      ["tab-1", true],
      ["tab-2", false],
      ["page-1", false],
      ["tab-3", false],
    ]);
  });

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

  it("keeps who opened a tab only when the browser says agent or person", () => {
    const base = { url: "https://example.com/", host: "example.com", label: "Example", title: null, isActive: false };
    const pages = mapRuntimeBrowserSessionPagesPayload({
      pages: [
        { ...base, id: "agent-tab", openedBy: "agent" },
        { ...base, id: "person-tab", openedBy: "person" },
        { ...base, id: "unknown-tab", openedBy: "Octo" },
        { ...base, id: "legacy-tab" },
      ],
    });
    expect(pages.map((page) => [page.id, page.openedBy])).toEqual([
      ["agent-tab", "agent"],
      ["person-tab", "person"],
      ["unknown-tab", undefined],
      ["legacy-tab", undefined],
    ]);
    expect("openedBy" in pages[3]!).toBe(false);
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

  it("keeps one of Octo's tabs with browser control, and says when it is no longer Octo's", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ kept: true, pageId: "tab/1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      keepRuntimeBrowserSessionPage({
        projectId: "project-1",
        browserSessionId: "browser-surface-1",
        pageId: " tab/1 ",
      }),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://origin.example.test/browser/pages/tab%2F1/keep",
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["browser.control"],
        browserSessionId: "browser-surface-1",
      }),
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    await expect(
      keepRuntimeBrowserSessionPage({
        projectId: "project-1",
        browserSessionId: "browser-surface-1",
        pageId: "tab-1",
      }),
    ).rejects.toThrow("no longer one of Octo's tabs");
    await expect(
      keepRuntimeBrowserSessionPage({ projectId: "project-1", browserSessionId: "browser-surface-1", pageId: " " }),
    ).resolves.toBe(false);
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

describe("Instafy's browser on the space's machine", () => {
  const hostBody = {
    version: 1,
    mode: "lazy",
    state: "starting",
    generation: "4b0f3d1e-8f5f-4c4e-9b8d-2f6a9b3c1d20",
    failure: null,
    startedByYou: true,
    othersPresent: false,
    controlledByOther: false,
    agentRunActive: false,
    agentRunStartedByYou: false,
  };
  const request = { projectId: "project-1", runtimeId: "runtime-1", browserSessionId: "browser-session-1" };

  it("reads only version 1 in lazy mode and maps an unknown state to unknown", () => {
    expect(mapSharedBrowserHostPayload(hostBody)).toEqual(hostBody);
    expect(mapSharedBrowserHostPayload({ ...hostBody, version: 2 })).toBeNull();
    expect(mapSharedBrowserHostPayload({ ...hostBody, mode: "eager" })).toBeNull();
    expect(mapSharedBrowserHostPayload({ ...hostBody, othersPresent: "no" })).toBeNull();
    expect(mapSharedBrowserHostPayload(null)).toBeNull();
    expect(mapSharedBrowserHostPayload([])).toBeNull();
    // A later state (for example a reset in progress) keeps older tabs polling.
    expect(mapSharedBrowserHostPayload({ ...hostBody, state: "clearing" })).toMatchObject({ state: "unknown" });
    expect(mapSharedBrowserHostPayload({ ...hostBody, state: "failed", failure: "chromium_failed" }))
      .toMatchObject({ state: "failed", failure: "chromium_failed" });
    expect(mapSharedBrowserHostPayload({ ...hostBody, generation: 42, failure: "not a token!" }))
      .toMatchObject({ generation: null, failure: null });
  });

  it("parses an origin error code, and nothing else", () => {
    expect(readBrowserErrorCode(JSON.stringify({ error: "x", code: "browser_host_not_ready" }))).toBe("browser_host_not_ready");
    expect(readBrowserErrorCode("upstream timed out")).toBeNull();
    expect(readBrowserErrorCode(JSON.stringify({ code: "Not A Code" }))).toBeNull();
    expect(readBrowserErrorCode(JSON.stringify({ code: 7 }))).toBeNull();
    expect(readBrowserErrorCode("")).toBeNull();
  });

  it("carries the code on an unavailable pages answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Instafy's browser is not running", code: "browser_host_not_ready" }),
      { status: 503, headers: { "retry-after": "1" } },
    )));
    const error = await fetchRuntimeBrowserSessionPages({ projectId: "project-1", browserSessionId: "browser-session-1" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BrowserSessionUnavailableError);
    expect(error).toMatchObject({ status: 503, code: "browser_host_not_ready" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    await expect(fetchRuntimeBrowserSessionPages({ projectId: "project-1", browserSessionId: "browser-session-1" }))
      .rejects.toMatchObject({ status: 502, code: null });
  });

  it("reads the host with a browser-view token, pinned to the machine, never from a cache", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(hostBody)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSharedBrowserHost(request)).resolves.toEqual(hostBody);
    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      protocol: "http",
      scopes: ["browser.view"],
      preferRuntime: "runtime-1",
      browserSessionId: "browser-session-1",
    }));
    expect(fetchMock).toHaveBeenCalledWith("https://origin.example.test/browser/host", expect.objectContaining({
      headers: { authorization: "Bearer origin-token", accept: "application/json" },
      cache: "no-store",
    }));
  });

  it("maps host answers: 404 is no host, gateway errors are unavailable, others fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found", code: "not_found" }), { status: 404 })));
    await expect(fetchSharedBrowserHost(request)).resolves.toBeNull();
    for (const status of [502, 503, 504]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
      const error = await fetchSharedBrowserHost(request).catch((cause: unknown) => cause);
      expect(isBrowserSessionUnavailableError(error)).toBe(true);
      expect(error).toMatchObject({ status });
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    await expect(fetchSharedBrowserHost(request)).rejects.toThrow("browser host failed (403)");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...hostBody, version: 2 }))));
    await expect(fetchSharedBrowserHost(request)).rejects.toBeInstanceOf(BrowserSessionCapabilitiesIncompatibleError);
    requestOriginAccessTokenMock.mockResolvedValueOnce(null);
    await expect(fetchSharedBrowserHost(request)).rejects.toBeInstanceOf(SharedBrowserHostTokenError);
  });

  it("reads only the machine's own 404 as no host: any other 404 says nothing about the browser", async () => {
    // Dogfood, Oct 24: "not available on this space's machine" while the
    // browser kept running; the 404 came from somewhere in front of it.
    const answer = (body: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 404 })));
    answer(JSON.stringify({ error: "this machine has no browser host", code: "browser_host_absent" }));
    await expect(fetchSharedBrowserHost(request)).resolves.toBeNull();
    answer(JSON.stringify({ error: "this machine has no browser host", code: "not_found" }));
    await expect(startSharedBrowserHost(request)).resolves.toBeNull();
    for (const [body, code] of [
      [JSON.stringify({ message: "origin path not found" }), null],
      [JSON.stringify({ message: "origin not registered" }), null],
      [JSON.stringify({ message: "origin path not found", code: "not_found" }), "not_found"],
      ["<html>Not Found</html>", null],
      ["", null],
      [JSON.stringify({ message: "Instafy's browser is off for this space", code: "browser_host_policy_off" }), "browser_host_policy_off"],
    ] as const) {
      answer(body);
      const error = await fetchSharedBrowserHost(request).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SharedBrowserHostNotFoundError);
      expect(error).toMatchObject({ name: "SharedBrowserHostNotFoundError", status: 404, code });
      // Not a gateway error: callers tell it apart on purpose.
      expect(isBrowserSessionUnavailableError(error)).toBe(false);
    }
  });

  it("starts the host with a browser-control token and exactly the version body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(hostBody), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(startSharedBrowserHost(request)).resolves.toEqual(hostBody);
    expect(requestOriginAccessTokenMock).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["browser.control"], preferRuntime: "runtime-1" }));
    expect(fetchMock).toHaveBeenCalledWith("https://origin.example.test/browser/host/start", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ version: 1 }),
    }));
  });

  it.each(["browser_host_stopping", "browser_host_poisoned", "machine_stopping"])(
    "turns a refused start (%s) into a refusal with its code",
    async (code) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "refused", code }), { status: 409 })));
      const error = await startSharedBrowserHost(request).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SharedBrowserHostRefusedError);
      expect(isSharedBrowserHostRefusedError(error)).toBe(true);
      expect(error).toMatchObject({ code });
    },
  );
});
