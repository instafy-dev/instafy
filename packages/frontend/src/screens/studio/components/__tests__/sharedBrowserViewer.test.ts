import { describe, expect, it } from "vitest";

import {
  resolveSharedBrowserFallbackViewerKind,
  resolveSharedBrowserViewerKind,
  resolveSharedBrowserViewerForParticipant,
  SHARED_BROWSER_GRANT_MAX_REFRESH_INTERVAL_MS,
  sharedBrowserGrantRefreshDelayMs,
  webRtcInputTargetsActivePage,
} from "../sharedBrowserViewer";

describe("resolveSharedBrowserViewerKind", () => {
  it("uses the advertised supported viewer", () => {
    expect(
      resolveSharedBrowserViewerKind({
        version: 2,
        viewerKinds: ["rfb"],
        preferredViewer: "rfb",
        viewportOnly: true,
        rfb: { renderScale: 1, maxFramebufferPixels: 8_294_400 },
        webrtc: null,
        controls: {
          navigate: true,
          history: true,
          reload: true,
          focusPage: true,
        },
      }),
    ).toBe("rfb");
  });

  it("uses WebRTC when the runtime advertises it as preferred", () => {
    expect(
      resolveSharedBrowserViewerKind({
        version: 2,
        viewerKinds: ["webrtc", "rfb"],
        preferredViewer: "webrtc",
        viewportOnly: true,
        rfb: { renderScale: 1, maxFramebufferPixels: 8_294_400 },
        webrtc: { iceServers: [], relayOnly: false },
        controls: {
          navigate: true,
          history: true,
          reload: true,
          focusPage: true,
        },
      }),
    ).toBe("webrtc");
  });

  it("uses the legacy RFB path when capabilities are unavailable", () => {
    expect(resolveSharedBrowserViewerKind(null)).toBe("rfb");
  });

  it("uses CDP screencast when the runtime advertises it as preferred", () => {
    expect(
      resolveSharedBrowserViewerKind({
        version: 2,
        viewerKinds: ["cdp-screencast", "rfb"],
        preferredViewer: "cdp-screencast",
        viewportOnly: true,
        rfb: { renderScale: 2, maxFramebufferPixels: 8_294_400 },
        webrtc: null,
        controls: {
          navigate: true,
          history: true,
          reload: true,
          focusPage: true,
        },
      }),
    ).toBe("cdp-screencast");
  });

  it("uses the viewport-adaptive CDP renderer on narrow layouts", () => {
    expect(
      resolveSharedBrowserViewerKind(
        {
          version: 2,
          viewerKinds: ["webrtc", "cdp-screencast", "rfb"],
          preferredViewer: "webrtc",
          viewportOnly: true,
          rfb: { renderScale: 2, maxFramebufferPixels: 8_294_400 },
          webrtc: { iceServers: [], relayOnly: false },
          controls: {
            navigate: true,
            history: true,
            reload: true,
            focusPage: true,
          },
        },
        false,
        true,
      ),
    ).toBe("cdp-screencast");
  });

  it("does not invent a viewer when an explicit capability set is empty", () => {
    expect(
      resolveSharedBrowserViewerKind({
        version: 2,
        viewerKinds: [],
        preferredViewer: "rfb",
        viewportOnly: true,
        rfb: null,
        webrtc: null,
        controls: {
          navigate: true,
          history: true,
          reload: true,
          focusPage: true,
        },
      }),
    ).toBeNull();
  });

  it("does not treat an incompatible capability document as a legacy runtime", () => {
    expect(resolveSharedBrowserViewerKind(null, true)).toBeNull();
  });

  it("falls back deterministically without restarting the runtime", () => {
    expect(
      resolveSharedBrowserFallbackViewerKind("webrtc", [
        "webrtc",
        "cdp-screencast",
        "rfb",
      ]),
    ).toBe("cdp-screencast");
    expect(
      resolveSharedBrowserFallbackViewerKind("cdp-screencast", [
        "webrtc",
        "cdp-screencast",
        "rfb",
      ]),
    ).toBe("rfb");
    expect(resolveSharedBrowserFallbackViewerKind("rfb", ["rfb"])).toBeNull();
  });

  it("keeps RFB exclusive to the current controller and gives spectators safe pixels", () => {
    expect(
      resolveSharedBrowserViewerForParticipant({
        requested: "rfb",
        available: ["rfb", "cdp-screencast"],
        humanOwnsControl: false,
      }),
    ).toBe("cdp-screencast");
    expect(
      resolveSharedBrowserViewerForParticipant({
        requested: "rfb",
        available: ["rfb", "webrtc"],
        humanOwnsControl: false,
      }),
    ).toBe("webrtc");
    expect(
      resolveSharedBrowserViewerForParticipant({
        requested: "rfb",
        available: ["rfb"],
        humanOwnsControl: false,
      }),
    ).toBeNull();
    expect(
      resolveSharedBrowserViewerForParticipant({
        requested: "rfb",
        available: ["rfb", "cdp-screencast"],
        humanOwnsControl: true,
      }),
    ).toBe("rfb");
  });

  it("disables WebRTC input while preserved video retargets to another page", () => {
    expect(webRtcInputTargetsActivePage("page-a", "page-a")).toBe(true);
    expect(webRtcInputTargetsActivePage("page-a", "page-b")).toBe(false);
    expect(webRtcInputTargetsActivePage(null, "page-b")).toBe(false);
  });

  it("rotates long-lived grants before the WebRTC peer lifetime ceiling", () => {
    const now = 1_000_000;
    expect(sharedBrowserGrantRefreshDelayMs(now + 60 * 60 * 1_000, now)).toBe(
      SHARED_BROWSER_GRANT_MAX_REFRESH_INTERVAL_MS,
    );
    expect(sharedBrowserGrantRefreshDelayMs(now + 5 * 60 * 1_000, now)).toBe(
      4.5 * 60 * 1_000,
    );
    expect(sharedBrowserGrantRefreshDelayMs(now - 1, now)).toBe(1_000);
  });
});
