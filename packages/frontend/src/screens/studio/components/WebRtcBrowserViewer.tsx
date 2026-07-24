import { useCallback, useEffect, useRef } from "react";
import {
  normalizeCdpScreencastViewport,
  parseCdpScreencastServerMessage,
  type CdpScreencastViewport,
} from "./cdpScreencastProtocol";
import {
  attachRemoteBrowserInput,
  type RemoteBrowserInputMessage,
} from "./remoteBrowserInput";
import { setRemoteBrowserSurfaceContentSize } from "./remoteBrowserSurfaceGeometry";
import { mapRuntimeBrowserSessionCapabilitiesPayload } from "../../../services/runtimeController/browserSession";

const ICE_GATHER_TIMEOUT_MS = 10_000;
// Non-trickle negotiation may spend up to ten seconds gathering in the client
// and another ten in the runtime. Keep the overall watchdog above that bounded
// path so a valid TURN negotiation is not mistaken for a transport failure.
const WEBRTC_CONNECT_TIMEOUT_MS = 30_000;
const WEBRTC_DISCONNECT_GRACE_MS = 5_000;
const WEBRTC_FRAME_STALL_TIMEOUT_MS = 20_000;
const WEBRTC_INPUT_READY_TIMEOUT_MS = 10_000;
const WEBRTC_FROZEN_FRAME_MAX_WIDTH = 1280;

export type WebRtcBrowserDisconnect = {
  connected: boolean;
  reason: string;
};

export type WebRtcBrowserViewerProps = {
  offerUrl: string;
  inputWsUrl: string | null;
  inputAvailable: boolean;
  accessToken: string;
  connectionGeneration: number;
  iceServers: RTCIceServer[];
  relayOnly: boolean;
  renderScale: number;
  active: boolean;
  inputEnabled: boolean;
  onConnected: () => void;
  onDisconnected: (detail: WebRtcBrowserDisconnect) => void;
  onTransportError: (message: string, fatal: boolean) => void;
};

export function normalizeWebRtcAnswer(payload: unknown): RTCSessionDescriptionInit | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.type !== "answer" || typeof record.sdp !== "string") {
    return null;
  }
  const sdp = record.sdp.trim();
  if (!sdp || sdp.length > 256 * 1024) {
    return null;
  }
  // Chromium requires the final SDP attribute to be line-terminated. Pion's
  // gathered answer is valid as emitted; trimming it without restoring CRLF
  // makes a trailing `a=end-of-candidates` look like an invalid SDP line.
  return { type: "answer", sdp: `${sdp}\r\n` };
}

export function webRtcViewportFromVideo(params: {
  videoWidth: number;
  videoHeight: number;
  renderScale: number;
}): CdpScreencastViewport {
  const renderScale =
    Number.isFinite(params.renderScale) && params.renderScale >= 1
      ? Math.min(params.renderScale, 3)
      : 1;
  return normalizeCdpScreencastViewport({
    width: params.videoWidth > 0 ? params.videoWidth / renderScale : 1280,
    height: params.videoHeight > 0 ? params.videoHeight / renderScale : 720,
    dpr: renderScale,
  });
}

export function webRtcPeerConfiguration(
  iceServers: RTCIceServer[],
  relayOnly: boolean,
): RTCConfiguration {
  return {
    iceServers,
    iceTransportPolicy: relayOnly ? "relay" : "all",
  };
}

export function webRtcBrowserViewerIsReady(params: {
  videoReady: boolean;
  inputAvailable: boolean;
  inputReady: boolean;
}): boolean {
  return params.videoReady && (!params.inputAvailable || params.inputReady);
}

export function webRtcCapabilitiesUrl(offerUrl: string): string {
  const url = new URL(offerUrl);
  const offerPathSuffix = "/browser/webrtc/offer";
  if (!url.pathname.endsWith(offerPathSuffix)) {
    throw new Error("Shared Browser WebRTC offer URL is invalid.");
  }
  url.pathname = `${url.pathname.slice(0, -offerPathSuffix.length)}/browser/capabilities`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function fetchFreshWebRtcPeerConfiguration(params: {
  offerUrl: string;
  accessToken: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RTCConfiguration> {
  const response = await (params.fetchImpl ?? fetch)(webRtcCapabilitiesUrl(params.offerUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${params.accessToken}`,
      accept: "application/json",
    },
    cache: "no-store",
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`WebRTC capabilities refresh failed (${response.status}).`);
  }
  const capabilities = mapRuntimeBrowserSessionCapabilitiesPayload(
    (await response.json()) as unknown,
  );
  if (!capabilities?.viewerKinds.includes("webrtc") || !capabilities.webrtc) {
    throw new Error("Shared Browser WebRTC is no longer available for this project.");
  }
  return webRtcPeerConfiguration(
    capabilities.webrtc.iceServers,
    capabilities.webrtc.relayOnly,
  );
}

function withInitialViewport(urlValue: string, viewport: CdpScreencastViewport): string {
  const url = new URL(urlValue);
  url.searchParams.set("width", String(viewport.width));
  url.searchParams.set("height", String(viewport.height));
  url.searchParams.set("dpr", String(viewport.dpr));
  return url.toString();
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("WebRTC ICE gathering timed out."));
    }, ICE_GATHER_TIMEOUT_MS);
    const handleChange = () => {
      if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", handleChange);
    };
    peer.addEventListener("icegatheringstatechange", handleChange);
  });
}

function websocketOpen(socket: WebSocket | null): socket is WebSocket {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function hideFrozenVideoFrame(canvas: HTMLCanvasElement | null): void {
  if (canvas) {
    canvas.hidden = true;
  }
}

/**
 * Keep the last decoded frame visible while a short-lived browser grant is
 * replaced. The input socket rotates independently and remains unavailable
 * until its fresh, ownership-checked `ready` message arrives.
 */
export function captureFrozenWebRtcFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): boolean {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth < 1 || sourceHeight < 1) {
    return false;
  }
  const width = Math.min(sourceWidth, WEBRTC_FROZEN_FRAME_MAX_WIDTH);
  const height = Math.max(1, Math.round((width / sourceWidth) * sourceHeight));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    return false;
  }
  canvas.width = width;
  canvas.height = height;
  setRemoteBrowserSurfaceContentSize(canvas, width, height);
  try {
    context.drawImage(video, 0, 0, width, height);
  } catch {
    return false;
  }
  canvas.hidden = false;
  return true;
}

/**
 * Receives the runtime's VP8 screen track over WebRTC while keeping all input
 * on the same bounded CDP protocol used by the screencast renderer.
 */
export function WebRtcBrowserViewer({
  offerUrl,
  inputWsUrl,
  inputAvailable,
  accessToken,
  connectionGeneration,
  iceServers,
  relayOnly,
  renderScale,
  active,
  inputEnabled,
  onConnected,
  onDisconnected,
  onTransportError,
}: WebRtcBrowserViewerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frozenFrameRef = useRef<HTMLCanvasElement | null>(null);
  const callbacksRef = useRef({ onConnected, onDisconnected, onTransportError });
  const inputWsUrlRef = useRef(inputWsUrl);
  const inputAvailableRef = useRef(inputAvailable);
  const videoReadyRef = useRef(false);
  const inputReadyRef = useRef(false);
  const connectedNotifiedRef = useRef(false);
  const activeRef = useRef(active);
  const inputEnabledRef = useRef(inputEnabled);
  const requestInputResizeRef = useRef<(() => void) | null>(null);
  const activeChangedAtRef = useRef(performance.now());
  callbacksRef.current = { onConnected, onDisconnected, onTransportError };
  inputWsUrlRef.current = inputWsUrl;
  inputAvailableRef.current = inputAvailable;
  inputEnabledRef.current = inputEnabled;
  if (activeRef.current !== active) {
    activeRef.current = active;
    activeChangedAtRef.current = performance.now();
  }
  const notifyConnectedIfReady = useCallback(() => {
    if (
      webRtcBrowserViewerIsReady({
        videoReady: videoReadyRef.current,
        inputAvailable: inputAvailableRef.current,
        inputReady: inputReadyRef.current,
      }) &&
      !connectedNotifiedRef.current
    ) {
      connectedNotifiedRef.current = true;
      callbacksRef.current.onConnected();
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    const frozenFrame = frozenFrameRef.current;
    if (!video || !offerUrl) {
      return;
    }

    let disposed = false;
    let connected = false;
    let disconnectNotified = false;
    let disconnectTimer: number | null = null;
    let videoFrameCallbackId: number | null = null;
    let lastVideoFrameAt = performance.now();
    let lastDecodedVideoFrames = 0;
    let videoStallReported = false;
    const abort = new AbortController();
    const peer = new RTCPeerConnection(webRtcPeerConfiguration(iceServers, relayOnly));

    const markVideoReady = () => {
      if (!connected && !disposed) {
        connected = true;
        videoReadyRef.current = true;
        setRemoteBrowserSurfaceContentSize(video, video.videoWidth, video.videoHeight);
        hideFrozenVideoFrame(frozenFrame);
        notifyConnectedIfReady();
      }
    };
    const observeVideoFrame: VideoFrameRequestCallback = (now) => {
      if (disposed) {
        return;
      }
      lastVideoFrameAt = now;
      videoStallReported = false;
      markVideoReady();
      videoFrameCallbackId = video.requestVideoFrameCallback(observeVideoFrame);
    };
    const notifyDisconnected = (reason: string) => {
      if (!disconnectNotified && !disposed) {
        disconnectNotified = true;
        callbacksRef.current.onDisconnected({ connected, reason });
      }
    };
    const fail = (message: string) => {
      if (!disposed) {
        callbacksRef.current.onTransportError(message, true);
      }
    };

    const supportsVideoFrameCallback =
      typeof video.requestVideoFrameCallback === "function";
    const handleVideoGeometry = () => {
      setRemoteBrowserSurfaceContentSize(video, video.videoWidth, video.videoHeight);
    };
    video.addEventListener("loadedmetadata", handleVideoGeometry);
    video.addEventListener("resize", handleVideoGeometry);
    if (!supportsVideoFrameCallback) {
      video.addEventListener("loadeddata", markVideoReady);
    }

    peer.addEventListener("track", (event) => {
      const [stream] = event.streams;
      video.srcObject = stream ?? new MediaStream([event.track]);
      if (supportsVideoFrameCallback && videoFrameCallbackId === null) {
        videoFrameCallbackId = video.requestVideoFrameCallback(observeVideoFrame);
      }
      void video.play().catch(() => {
        fail("Shared Browser video could not start.");
      });
    });
    peer.addEventListener("connectionstatechange", () => {
      if (disconnectTimer !== null) {
        window.clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
      if (peer.connectionState === "connected") {
        return;
      }
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        notifyDisconnected(`WebRTC connection ${peer.connectionState}`);
        return;
      }
      if (peer.connectionState === "disconnected") {
        disconnectTimer = window.setTimeout(() => {
          disconnectTimer = null;
          if (!disposed && peer.connectionState === "disconnected") {
            notifyDisconnected("WebRTC connection remained disconnected");
          }
        }, WEBRTC_DISCONNECT_GRACE_MS);
      }
    });

    const connectTimeout = window.setTimeout(() => {
      if (!connectedNotifiedRef.current) {
        fail("Shared Browser WebRTC connection timed out.");
      }
    }, WEBRTC_CONNECT_TIMEOUT_MS);
    const handleVisibilityChange = () => {
      activeChangedAtRef.current = performance.now();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const frameWatchdog = window.setInterval(() => {
      const quality = video.getVideoPlaybackQuality?.();
      if (quality && quality.totalVideoFrames > lastDecodedVideoFrames) {
        lastDecodedVideoFrames = quality.totalVideoFrames;
        lastVideoFrameAt = performance.now();
        videoStallReported = false;
      }
      if (
        supportsVideoFrameCallback &&
        activeRef.current &&
        document.visibilityState === "visible" &&
        video.getClientRects().length > 0 &&
        connected &&
        !videoStallReported &&
        performance.now() - Math.max(lastVideoFrameAt, activeChangedAtRef.current) >
          WEBRTC_FRAME_STALL_TIMEOUT_MS
      ) {
        videoStallReported = true;
        fail("Shared Browser video stopped producing frames.");
      }
    }, 2_000);

    void (async () => {
      try {
        // Controller-managed TURN credentials are intentionally short-lived.
        // Refresh them for every negotiation instead of reusing the capability
        // snapshot that originally selected this viewer.
        const freshPeerConfiguration = await fetchFreshWebRtcPeerConfiguration({
          offerUrl,
          accessToken,
          signal: abort.signal,
        });
        if (disposed) {
          return;
        }
        peer.setConfiguration(freshPeerConfiguration);
        peer.addTransceiver("video", { direction: "recvonly" });
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGathering(peer);
        if (!peer.localDescription || disposed) {
          return;
        }

        const response = await fetch(offerUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(peer.localDescription),
          signal: abort.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(
            `WebRTC offer failed (${response.status})${detail ? `: ${detail}` : ""}`,
          );
        }
        const answer = normalizeWebRtcAnswer((await response.json()) as unknown);
        if (!answer) {
          throw new Error("WebRTC sender returned an invalid answer.");
        }
        await peer.setRemoteDescription(answer);
      } catch (cause) {
        if (!disposed && !abort.signal.aborted) {
          fail(cause instanceof Error ? cause.message : "Unable to start WebRTC browser video.");
        }
      }
    })();

    return () => {
      disposed = true;
      if (videoReadyRef.current && frozenFrame) {
        captureFrozenWebRtcFrame(video, frozenFrame);
      }
      videoReadyRef.current = false;
      connectedNotifiedRef.current = false;
      window.clearTimeout(connectTimeout);
      window.clearInterval(frameWatchdog);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (disconnectTimer !== null) {
        window.clearTimeout(disconnectTimer);
      }
      abort.abort();
      peer.close();
      if (videoFrameCallbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(videoFrameCallbackId);
      }
      video.removeEventListener("loadeddata", markVideoReady);
      video.removeEventListener("loadedmetadata", handleVideoGeometry);
      video.removeEventListener("resize", handleVideoGeometry);
      video.pause();
      video.srcObject = null;
    };
  }, [
    accessToken,
    connectionGeneration,
    iceServers,
    notifyConnectedIfReady,
    offerUrl,
    relayOnly,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !inputAvailable) {
      inputReadyRef.current = false;
      notifyConnectedIfReady();
      return;
    }
    if (!inputWsUrl) {
      return;
    }

    let disposed = false;
    const boundInputWsUrl = inputWsUrl;
    inputReadyRef.current = false;
    let inputReadyTimer: number | null = window.setTimeout(() => {
      inputReadyTimer = null;
      if (!disposed && !inputReadyRef.current) {
        callbacksRef.current.onTransportError(
          "Shared Browser input did not become ready.",
          true,
        );
      }
    }, WEBRTC_INPUT_READY_TIMEOUT_MS);
    let currentViewport = webRtcViewportFromVideo({
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      renderScale,
    });
    let lastSentViewport: CdpScreencastViewport | null = null;
    const inputSocket = new WebSocket(withInitialViewport(inputWsUrl, currentViewport));
    const sendInput = (message: RemoteBrowserInputMessage | Record<string, unknown>) => {
      if (websocketOpen(inputSocket)) {
        inputSocket.send(JSON.stringify(message));
        return true;
      }
      return false;
    };
    const input = attachRemoteBrowserInput(video, {
      enabled: () =>
        activeRef.current &&
        inputEnabledRef.current &&
        inputReadyRef.current &&
        inputWsUrlRef.current === boundInputWsUrl,
      getViewport: () => currentViewport,
      send: sendInput,
    });
    const sendResize = (force = false) => {
      if (disposed || !activeRef.current || !inputEnabledRef.current) {
        return;
      }
      if (
        !force &&
        lastSentViewport?.width === currentViewport.width &&
        lastSentViewport.height === currentViewport.height &&
        lastSentViewport.dpr === currentViewport.dpr
      ) {
        return;
      }
      if (!sendInput({
        type: "resize",
        width: currentViewport.width,
        height: currentViewport.height,
        dpr: currentViewport.dpr,
      })) {
        return;
      }
      lastSentViewport = currentViewport;
    };
    requestInputResizeRef.current = () => sendResize(true);
    const handleLoadedMetadata = () => {
      // Peer/grant rotation clears srcObject and can transiently reset the
      // intrinsic video size to 0×0. Do not turn that teardown signal into a
      // real 1280×720 Chromium resize through the fallback normalizer.
      if (video.videoWidth < 1 || video.videoHeight < 1) {
        return;
      }
      currentViewport = webRtcViewportFromVideo({
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        renderScale,
      });
      sendResize();
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("resize", handleLoadedMetadata);
    inputSocket.addEventListener("open", () => {
      sendResize();
    });
    inputSocket.addEventListener("message", (event) => {
      const message = parseCdpScreencastServerMessage(event.data);
      if (!message || disposed) {
        return;
      }
      if (message.type === "ready" || message.type === "viewport") {
        currentViewport = message;
        if (message.type === "ready") {
          inputReadyRef.current = true;
          if (inputReadyTimer !== null) {
            window.clearTimeout(inputReadyTimer);
            inputReadyTimer = null;
          }
          notifyConnectedIfReady();
        }
      } else if (message.type === "error") {
        callbacksRef.current.onTransportError(message.message, message.fatal);
      }
    });
    inputSocket.addEventListener("error", () => {
      if (!disposed) {
        callbacksRef.current.onTransportError(
          "Shared Browser input connection failed.",
          true,
        );
      }
    });
    inputSocket.addEventListener("close", (event) => {
      if (!disposed) {
        callbacksRef.current.onTransportError(
          event.reason || `Shared Browser input closed (${event.code}).`,
          true,
        );
      }
    });

    return () => {
      disposed = true;
      requestInputResizeRef.current = null;
      inputReadyRef.current = false;
      if (inputReadyTimer !== null) {
        window.clearTimeout(inputReadyTimer);
      }
      input.dispose();
      inputSocket.close(1000, "input target changed");
      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("resize", handleLoadedMetadata);
    };
  }, [
    connectionGeneration,
    inputAvailable,
    inputWsUrl,
    notifyConnectedIfReady,
    renderScale,
  ]);

  useEffect(() => {
    if ((!inputAvailable || !inputEnabled) && document.activeElement === videoRef.current) {
      videoRef.current?.blur();
    }
    if (!active || !inputAvailable || !inputEnabled) {
      return;
    }
    const frame = window.requestAnimationFrame(() => requestInputResizeRef.current?.());
    return () => window.cancelAnimationFrame(frame);
  }, [active, inputAvailable, inputEnabled]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-transparent">
      <video
        aria-label="Shared Browser remote page"
        autoPlay
        className="block h-full w-full touch-none bg-transparent object-contain outline-none"
        data-active={active ? "true" : "false"}
        data-input-available={inputAvailable ? "true" : "false"}
        data-input-enabled={inputEnabled ? "true" : "false"}
        data-testid="shared-browser-webrtc"
        muted
        playsInline
        ref={videoRef}
        tabIndex={active && inputAvailable && inputEnabled ? 0 : -1}
      />
      <canvas
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[1] h-full w-full bg-transparent object-contain"
        data-testid="shared-browser-webrtc-frozen-frame"
        hidden
        ref={frozenFrameRef}
      />
    </div>
  );
}
