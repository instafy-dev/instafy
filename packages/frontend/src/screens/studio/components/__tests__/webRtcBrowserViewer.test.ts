// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  fetchFreshWebRtcPeerConfiguration,
  normalizeWebRtcAnswer,
  WebRtcBrowserViewer,
  webRtcBrowserViewerIsReady,
  webRtcCapabilitiesUrl,
  webRtcPeerConfiguration,
  webRtcViewportFromVideo,
} from "../WebRtcBrowserViewer";

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  closed = false;

  constructor(readonly configuration?: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  addEventListener() {}

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

class FakeInputWebSocket {
  static readonly OPEN = 1;
  static instances: FakeInputWebSocket[] = [];

  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: Event & { data?: unknown }) => void>>();
  readyState = FakeInputWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeInputWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event & { data?: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 3;
  }

  emitMessage(payload: Record<string, unknown>) {
    const event = Object.assign(new Event("message"), {
      data: JSON.stringify(payload),
    });
    for (const listener of this.listeners.get("message") ?? []) {
      listener(event);
    }
  }

  emit(type: string) {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("WebRTC Shared Browser protocol", () => {
  it("accepts only bounded SDP answers", () => {
    expect(normalizeWebRtcAnswer({ type: "answer", sdp: " v=0\r\n " })).toEqual({
      type: "answer",
      sdp: "v=0\r\n",
    });
    expect(normalizeWebRtcAnswer({ type: "offer", sdp: "v=0" })).toBeNull();
    expect(normalizeWebRtcAnswer({ type: "answer", sdp: "" })).toBeNull();
    expect(normalizeWebRtcAnswer({ type: "answer", sdp: "x".repeat(300_000) })).toBeNull();
  });

  it("maps the encoded framebuffer back to logical browser CSS pixels", () => {
    expect(
      webRtcViewportFromVideo({
        videoWidth: 2560,
        videoHeight: 1440,
        renderScale: 2,
      }),
    ).toEqual({
      width: 1280,
      height: 720,
      dpr: 2,
      deviceWidth: 2560,
      deviceHeight: 1440,
    });
  });

  it("forces relay-only ICE when managed TURN is required", () => {
    const iceServers = [{ urls: ["turns:turn.example.test:5349"] }];
    expect(webRtcPeerConfiguration(iceServers, true)).toEqual({
      iceServers,
      iceTransportPolicy: "relay",
    });
    expect(webRtcPeerConfiguration(iceServers, false).iceTransportPolicy).toBe("all");
  });

  it("considers view-only video ready without opening an input socket", () => {
    expect(
      webRtcBrowserViewerIsReady({
        videoReady: true,
        inputAvailable: false,
        inputReady: false,
      }),
    ).toBe(true);
    expect(
      webRtcBrowserViewerIsReady({
        videoReady: true,
        inputAvailable: true,
        inputReady: false,
      }),
    ).toBe(false);
    expect(
      webRtcBrowserViewerIsReady({
        videoReady: true,
        inputAvailable: true,
        inputReady: true,
      }),
    ).toBe(true);
  });

  it("derives the fresh capabilities endpoint from direct and proxied offer URLs", () => {
    expect(
      webRtcCapabilitiesUrl("https://runtime.test/browser/webrtc/offer?ignored=true"),
    ).toBe("https://runtime.test/browser/capabilities");
    expect(
      webRtcCapabilitiesUrl(
        "https://controller.test/origin/origin-id/browser/webrtc/offer",
      ),
    ).toBe("https://controller.test/origin/origin-id/browser/capabilities");
    expect(() => webRtcCapabilitiesUrl("https://runtime.test/browser/pages")).toThrow(
      "Shared Browser WebRTC offer URL is invalid.",
    );
  });

  it("refreshes managed TURN credentials immediately before negotiation", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          version: 2,
          viewerKinds: ["webrtc", "rfb"],
          preferredViewer: "webrtc",
          viewportOnly: true,
          rfb: { renderScale: 2, maxFramebufferPixels: 8_294_400 },
          webrtc: {
            relayOnly: true,
            iceServers: [
              {
                urls: ["turns:turn.example.test:443?transport=tcp"],
                username: "fresh-user",
                credential: "fresh-credential",
              },
            ],
          },
          controls: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      fetchFreshWebRtcPeerConfiguration({
        offerUrl: "https://controller.test/origin/id/browser/webrtc/offer",
        accessToken: "browser-token",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({
      iceServers: [
        {
          urls: ["turns:turn.example.test:443?transport=tcp"],
          username: "fresh-user",
          credential: "fresh-credential",
        },
      ],
      iceTransportPolicy: "relay",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://controller.test/origin/id/browser/capabilities",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({ authorization: "Bearer browser-token" }),
      }),
    );
  });

  it("fails closed when a refresh no longer advertises WebRTC", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          version: 2,
          viewerKinds: ["rfb"],
          preferredViewer: "rfb",
          viewportOnly: false,
          rfb: { renderScale: 2, maxFramebufferPixels: 8_294_400 },
          webrtc: null,
          controls: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      fetchFreshWebRtcPeerConfiguration({
        offerUrl: "https://runtime.test/browser/webrtc/offer",
        accessToken: "browser-token",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow("Shared Browser WebRTC is no longer available for this project.");
  });
});

describe("WebRTC Shared Browser grant rotation", () => {
  const stableIceServers: RTCIceServer[] = [];
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: Mock;
  let drawImage: Mock;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakePeerConnection.instances = [];
    FakeInputWebSocket.instances = [];
    fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    drawImage = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("WebSocket", FakeInputWebSocket);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function renderViewer(
    accessToken: string,
    overrides: Partial<ComponentProps<typeof WebRtcBrowserViewer>> = {},
  ) {
    root.render(
      createElement(WebRtcBrowserViewer, {
        offerUrl: "https://runtime.test/browser/webrtc/offer",
        inputWsUrl: null,
        inputAvailable: false,
        accessToken,
        connectionGeneration: 0,
        iceServers: stableIceServers,
        relayOnly: false,
        renderScale: 1,
        active: true,
        inputEnabled: false,
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
        onTransportError: vi.fn(),
        ...overrides,
      }),
    );
  }

  it("renegotiates the video peer with the rotated browser grant", async () => {
    await act(async () => renderViewer("first-browser-grant"));
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://runtime.test/browser/capabilities",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer first-browser-grant",
        }),
      }),
    );

    await act(async () => renderViewer("rotated-browser-grant"));
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[0]?.closed).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://runtime.test/browser/capabilities",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer rotated-browser-grant",
        }),
      }),
    );
  });

  it("reopens identical peer and input endpoints when the connection generation changes", async () => {
    const sharedConnection = {
      inputAvailable: true,
      inputWsUrl: "wss://runtime.test/browser/input?token=same-grant",
    } as const;
    await act(async () =>
      renderViewer("same-browser-grant", {
        ...sharedConnection,
        connectionGeneration: 0,
      }),
    );
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(FakeInputWebSocket.instances).toHaveLength(1);
    const firstPeer = FakePeerConnection.instances[0];
    const firstInput = FakeInputWebSocket.instances[0];

    await act(async () =>
      renderViewer("same-browser-grant", {
        ...sharedConnection,
        connectionGeneration: 0,
      }),
    );
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(FakeInputWebSocket.instances).toHaveLength(1);

    await act(async () =>
      renderViewer("same-browser-grant", {
        ...sharedConnection,
        connectionGeneration: 1,
      }),
    );
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakeInputWebSocket.instances).toHaveLength(2);
    expect(firstPeer?.closed).toBe(true);
    expect(firstInput?.readyState).toBe(3);
    expect(FakeInputWebSocket.instances[1]?.url).toBe(firstInput?.url);
  });

  it("keeps the last decoded frame visible until the rotated peer renders", async () => {
    await act(async () => renderViewer("first-browser-grant"));
    const video = container.querySelector<HTMLVideoElement>(
      '[data-testid="shared-browser-webrtc"]',
    );
    const frozenFrame = container.querySelector<HTMLCanvasElement>(
      '[data-testid="shared-browser-webrtc-frozen-frame"]',
    );
    expect(video).not.toBeNull();
    expect(frozenFrame).not.toBeNull();
    expect(video!.classList.contains("object-contain")).toBe(true);
    expect(frozenFrame!.classList.contains("object-contain")).toBe(true);
    Object.defineProperties(video!, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });

    act(() => video!.dispatchEvent(new Event("loadeddata")));
    expect(frozenFrame!.hidden).toBe(true);
    expect(video!.dataset.remoteContentWidth).toBe("1920");
    expect(video!.dataset.remoteContentHeight).toBe("1080");

    await act(async () => renderViewer("rotated-browser-grant"));
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    expect(frozenFrame!.hidden).toBe(false);
    expect(frozenFrame!.dataset.remoteContentWidth).toBe("1280");
    expect(frozenFrame!.dataset.remoteContentHeight).toBe("720");

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(frozenFrame!.hidden).toBe(false);

    act(() => video!.dispatchEvent(new Event("loadeddata")));
    expect(frozenFrame!.hidden).toBe(true);

    Object.defineProperties(video!, {
      videoWidth: { configurable: true, value: 1080 },
      videoHeight: { configurable: true, value: 1920 },
    });
    act(() => video!.dispatchEvent(new Event("resize")));
    expect(video!.dataset.remoteContentWidth).toBe("1080");
    expect(video!.dataset.remoteContentHeight).toBe("1920");
  });

  it("keeps spectator input metadata separate from decoded video geometry", async () => {
    await act(async () =>
      renderViewer("viewer-browser-grant", {
        inputAvailable: true,
        inputEnabled: false,
        inputWsUrl: "wss://runtime.test/browser/input",
      }),
    );
    const video = container.querySelector<HTMLVideoElement>(
      '[data-testid="shared-browser-webrtc"]',
    )!;
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    act(() => video.dispatchEvent(new Event("loadedmetadata")));
    expect(video.dataset.remoteContentWidth).toBe("1920");
    expect(video.dataset.remoteContentHeight).toBe("1080");

    const socket = FakeInputWebSocket.instances[0]!;
    expect(socket).toBeDefined();
    act(() =>
      socket.emitMessage({
        type: "ready",
        pageId: "PAGE",
        width: 390,
        height: 844,
        dpr: 1,
        deviceWidth: 390,
        deviceHeight: 844,
      }),
    );

    expect(socket.sent).toEqual([]);
    expect(video.dataset.remoteContentWidth).toBe("1920");
    expect(video.dataset.remoteContentHeight).toBe("1080");
  });

  it("ignores transient zero-sized video resizes during peer rotation", async () => {
    await act(async () =>
      renderViewer("driver-browser-grant", {
        inputAvailable: true,
        inputEnabled: true,
        inputWsUrl: "wss://runtime.test/browser/input",
      }),
    );
    const video = container.querySelector<HTMLVideoElement>(
      '[data-testid="shared-browser-webrtc"]',
    )!;
    const socket = FakeInputWebSocket.instances[0]!;
    act(() => socket.emit("open"));
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "resize", width: 1280, height: 720, dpr: 1 },
    ]);

    act(() => video.dispatchEvent(new Event("resize")));
    expect(socket.sent).toHaveLength(1);

    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    act(() => video.dispatchEvent(new Event("resize")));
    expect(socket.sent.map((value) => JSON.parse(value))).toHaveLength(2);
    expect(JSON.parse(socket.sent[1]!)).toEqual({
      type: "resize",
      width: 1920,
      height: 1080,
      dpr: 1,
    });

    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 0 },
      videoHeight: { configurable: true, value: 0 },
    });
    act(() => video.dispatchEvent(new Event("resize")));
    expect(socket.sent).toHaveLength(2);
  });

  it("forces the local viewport when a previous driver regains control", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const inputProps = {
      inputAvailable: true,
      inputWsUrl: "wss://runtime.test/browser/input",
    } as const;
    await act(async () =>
      renderViewer("driver-browser-grant", {
        ...inputProps,
        inputEnabled: true,
      }),
    );
    const socket = FakeInputWebSocket.instances[0]!;
    act(() => socket.emit("open"));
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "resize", width: 1280, height: 720, dpr: 1 },
    ]);

    await act(async () =>
      renderViewer("driver-browser-grant", {
        ...inputProps,
        inputEnabled: false,
      }),
    );
    await act(async () =>
      renderViewer("driver-browser-grant", {
        ...inputProps,
        inputEnabled: true,
      }),
    );

    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "resize", width: 1280, height: 720, dpr: 1 },
      { type: "resize", width: 1280, height: 720, dpr: 1 },
    ]);
  });
});
