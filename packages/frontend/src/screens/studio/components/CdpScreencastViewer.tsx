import { useEffect, useRef, useState } from "react";
import {
  normalizeCdpScreencastViewport,
  parseCdpScreencastServerMessage,
  type CdpScreencastFrame,
  type CdpScreencastViewport,
} from "./cdpScreencastProtocol";
import {
  attachRemoteBrowserInput,
  type RemoteBrowserInputMessage,
} from "./remoteBrowserInput";
import { setRemoteBrowserSurfaceContentSize } from "./remoteBrowserSurfaceGeometry";

export type CdpScreencastDisconnect = {
  connected: boolean;
  reason: string;
};

export type CdpScreencastViewerProps = {
  wsUrl: string;
  inputWsUrl?: string | null;
  inputAvailable?: boolean;
  inputAuthorityKey?: string | null;
  connectionGeneration: number;
  active: boolean;
  inputEnabled: boolean;
  onConnected: () => void;
  onDisconnected: (detail: CdpScreencastDisconnect) => void;
  onTransportError: (message: string, fatal: boolean) => void;
};

const CDP_FIRST_FRAME_TIMEOUT_MS = 10_000;
const CDP_INPUT_READY_TIMEOUT_MS = 10_000;

function websocketOpen(socket: WebSocket | null): socket is WebSocket {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function measuredViewport(element: HTMLElement): CdpScreencastViewport | null {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return null;
  }
  return normalizeCdpScreencastViewport({
    width: rect.width,
    height: rect.height,
    dpr: window.devicePixelRatio || 1,
  });
}

function initialViewport(element: HTMLElement): CdpScreencastViewport {
  return (
    measuredViewport(element) ??
    normalizeCdpScreencastViewport({
      width: 1280,
      height: 720,
      dpr: window.devicePixelRatio || 1,
    })
  );
}

function withInitialViewport(wsUrl: string, viewport: CdpScreencastViewport): string {
  const url = new URL(wsUrl);
  url.searchParams.set("width", String(viewport.width));
  url.searchParams.set("height", String(viewport.height));
  url.searchParams.set("dpr", String(viewport.dpr));
  return url.toString();
}

function base64JpegBlob(data: string): Blob {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "image/jpeg" });
}

async function decodeFrame(frame: CdpScreencastFrame): Promise<ImageBitmap> {
  return window.createImageBitmap(base64JpegBlob(frame.data));
}

function paintFrame(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
  if (canvas.width !== bitmap.width) {
    canvas.width = bitmap.width;
  }
  if (canvas.height !== bitmap.height) {
    canvas.height = bitmap.height;
  }
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Canvas rendering is unavailable.");
  }
  context.imageSmoothingEnabled = false;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // The renderer socket echoes the connecting viewer's requested box, but a
  // spectator does not own Chromium's canonical viewport. The decoded pixels
  // are therefore the only authoritative presentation aspect ratio.
  setRemoteBrowserSurfaceContentSize(canvas, bitmap.width, bitmap.height);
}

/**
 * A viewport-only CDP renderer. Frames are acknowledged after decode; an
 * eligible newest frame is painted before its acknowledgement, creating a
 * one-frame backpressure loop all the way to Chromium without stale repaints.
 */
export function CdpScreencastViewer({
  wsUrl,
  inputWsUrl = null,
  inputAvailable = false,
  inputAuthorityKey = null,
  connectionGeneration,
  active,
  inputEnabled,
  onConnected,
  onDisconnected,
  onTransportError,
}: CdpScreencastViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  const inputEnabledRef = useRef(inputEnabled);
  const requestInputResizeRef = useRef<(() => void) | null>(null);
  const inputSocketStartedWithAuthorityRef = useRef(false);
  const lastObservedInputAuthorityKeyRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onConnected, onDisconnected, onTransportError });
  const inputConnectionKey = inputAvailable && inputWsUrl
    ? `${connectionGeneration}\n${inputWsUrl}`
    : null;
  const [readyInputConnectionKey, setReadyInputConnectionKey] = useState<string | null>(null);
  const inputReady = inputConnectionKey !== null && readyInputConnectionKey === inputConnectionKey;
  activeRef.current = active;
  inputEnabledRef.current = inputEnabled;
  callbacksRef.current = { onConnected, onDisconnected, onTransportError };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !wsUrl) {
      return;
    }

    let disposed = false;
    let connected = false;
    let readyReceived = false;
    let firstFrameTimer: number | null = null;
    const currentViewport = initialViewport(canvas);
    setRemoteBrowserSurfaceContentSize(
      canvas,
      currentViewport.width,
      currentViewport.height,
    );
    let latestFrameId = 0;
    let paintedFrameId = 0;
    let socket: WebSocket | null = null;

    // React StrictMode intentionally mounts, disposes, and remounts effects in
    // development. Defer the network side effect by one microtask so the
    // disposed probe cannot overlap the replacement CDP screencast session.
    // This also collapses same-commit URL/generation replacements without
    // delaying ordinary renderer startup by a visible frame.
    queueMicrotask(() => {
      if (disposed) {
        return;
      }

      const nextSocket = new WebSocket(withInitialViewport(wsUrl, currentViewport));
      socket = nextSocket;

      firstFrameTimer = window.setTimeout(() => {
        firstFrameTimer = null;
        if (!disposed && !connected) {
          callbacksRef.current.onTransportError(
            "Shared Browser renderer did not produce its first frame.",
            true,
          );
          nextSocket.close(1011, "first frame timeout");
        }
      }, CDP_FIRST_FRAME_TIMEOUT_MS);

      const send = (message: Record<string, unknown>) => {
        if (websocketOpen(nextSocket)) {
          nextSocket.send(JSON.stringify(message));
        }
      };

      nextSocket.addEventListener("message", (event) => {
        const message = parseCdpScreencastServerMessage(event.data);
        if (!message || disposed) {
          return;
        }
        if (message.type === "ready" || message.type === "viewport") {
          if (message.type === "ready") {
            readyReceived = true;
          }
          return;
        }
        if (message.type === "error") {
          callbacksRef.current.onTransportError(message.message, message.fatal);
          if (message.fatal) {
            nextSocket.close(1011, "renderer error");
          }
          return;
        }

        const frameId = message.frameId;
        latestFrameId = Math.max(latestFrameId, frameId);
        void decodeFrame(message)
          .then((bitmap) => {
            let painted = false;
            try {
              // Decodes may resolve out of order after the origin's frame ACK
              // timeout, or after this effect has been replaced during a
              // reconnect. Never let an older decode regress a newer canvas.
              if (!disposed && frameId > paintedFrameId) {
                paintFrame(canvas, bitmap);
                paintedFrameId = frameId;
                painted = true;
              }
            } finally {
              bitmap.close();
            }
            if (!disposed) {
              // Release origin-side backpressure before reporting Ready. On a
              // higher-latency controller/tunnel path, navigation can otherwise
              // race ahead of this first acknowledgement.
              send({ type: "ack", frameId: message.frameId });
              if (painted && readyReceived && !connected) {
                connected = true;
                if (firstFrameTimer !== null) {
                  window.clearTimeout(firstFrameTimer);
                  firstFrameTimer = null;
                }
                callbacksRef.current.onConnected();
              }
            }
          })
          .catch((cause) => {
            if (!disposed) {
              if (frameId === latestFrameId) {
                callbacksRef.current.onTransportError(
                  cause instanceof Error ? cause.message : "Unable to render browser frame.",
                  false,
                );
              }
              // A corrupt frame must still release the producer. The origin
              // retains the latest replacement frame until this acknowledgement.
              send({ type: "ack", frameId: message.frameId });
            }
          });
      });
      nextSocket.addEventListener("error", () => {
        if (!disposed) {
          callbacksRef.current.onTransportError(
            "Shared Browser renderer connection failed.",
            true,
          );
        }
      });
      nextSocket.addEventListener("close", (event) => {
        if (!disposed) {
          if (firstFrameTimer !== null) {
            window.clearTimeout(firstFrameTimer);
            firstFrameTimer = null;
          }
          callbacksRef.current.onDisconnected({
            connected,
            reason: event.reason || `WebSocket closed (${event.code})`,
          });
        }
      });
    });

    return () => {
      disposed = true;
      if (firstFrameTimer !== null) {
        window.clearTimeout(firstFrameTimer);
      }
      socket?.close(1000, "viewer disposed");
    };
  }, [connectionGeneration, wsUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !inputAvailable || !inputWsUrl) {
      return;
    }

    let disposed = false;
    let ready = false;
    let currentViewport = initialViewport(canvas);
    let lastSentViewport = inputEnabledRef.current ? currentViewport : null;
    let authorityResizePending = false;
    let resizeTimer: number | null = null;
    inputSocketStartedWithAuthorityRef.current = inputEnabledRef.current;
    const socket = new WebSocket(withInitialViewport(inputWsUrl, currentViewport));
    const readyTimer = window.setTimeout(() => {
      if (!disposed && !ready) {
        callbacksRef.current.onTransportError(
          "Shared Browser input did not become ready.",
          true,
        );
      }
    }, CDP_INPUT_READY_TIMEOUT_MS);
    const send = (message: RemoteBrowserInputMessage | Record<string, unknown>) => {
      if (websocketOpen(socket)) {
        socket.send(JSON.stringify(message));
        return true;
      }
      return false;
    };
    const input = attachRemoteBrowserInput(canvas, {
      enabled: () => activeRef.current && inputEnabledRef.current && ready,
      getViewport: () => currentViewport,
      send,
    });
    const sendResize = (force = false) => {
      const next = measuredViewport(canvas);
      if (next) {
        currentViewport = next;
      }
      if (
        !ready ||
        !activeRef.current ||
        !inputEnabledRef.current ||
        !websocketOpen(socket)
      ) {
        authorityResizePending ||= force;
        return;
      }
      const unchanged =
        lastSentViewport?.width === currentViewport.width &&
        lastSentViewport.height === currentViewport.height &&
        lastSentViewport.dpr === currentViewport.dpr;
      if (!force && unchanged) {
        return;
      }
      if (!send({
        type: "resize",
        width: currentViewport.width,
        height: currentViewport.height,
        dpr: currentViewport.dpr,
      })) {
        authorityResizePending ||= force;
        return;
      }
      lastSentViewport = currentViewport;
      authorityResizePending = false;
    };
    requestInputResizeRef.current = () => sendResize(true);
    const scheduleResize = () => {
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        sendResize();
      }, 120);
    };
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(scheduleResize) : null;
    resizeObserver?.observe(canvas);
    window.addEventListener("resize", scheduleResize);

    socket.addEventListener("message", (event) => {
      const message = parseCdpScreencastServerMessage(event.data);
      if (!message || disposed) {
        return;
      }
      if (message.type === "ready" || message.type === "viewport") {
        currentViewport = message;
        if (message.type === "ready") {
          ready = true;
          setReadyInputConnectionKey(inputConnectionKey);
          window.clearTimeout(readyTimer);
          if (authorityResizePending) {
            sendResize(true);
          } else if (inputEnabledRef.current) {
            // The origin awaits its initial device-metrics override before it
            // emits ready for the live driver. Seed the dedupe tuple from that
            // authoritative viewport instead of immediately overriding it a
            // second time from the client.
            lastSentViewport = currentViewport;
          }
        }
      } else if (message.type === "error") {
        callbacksRef.current.onTransportError(message.message, message.fatal);
      }
    });
    socket.addEventListener("error", () => {
      if (!disposed) {
        setReadyInputConnectionKey((current) => current === inputConnectionKey ? null : current);
        callbacksRef.current.onTransportError("Shared Browser input connection failed.", true);
      }
    });
    socket.addEventListener("close", (event) => {
      if (!disposed) {
        setReadyInputConnectionKey((current) => current === inputConnectionKey ? null : current);
        callbacksRef.current.onTransportError(
          event.reason || `Shared Browser input closed (${event.code}).`,
          true,
        );
      }
    });

    return () => {
      disposed = true;
      setReadyInputConnectionKey((current) => current === inputConnectionKey ? null : current);
      requestInputResizeRef.current = null;
      window.clearTimeout(readyTimer);
      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleResize);
      input.dispose();
      socket.close(1000, "input target changed");
    };
  }, [connectionGeneration, inputAvailable, inputConnectionKey, inputWsUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!inputEnabled && document.activeElement === canvas) {
      canvas?.blur();
    }
    const normalizedAuthorityKey = inputAuthorityKey?.trim() || null;
    const previousAuthorityKey = lastObservedInputAuthorityKeyRef.current;
    if (normalizedAuthorityKey) {
      lastObservedInputAuthorityKeyRef.current = normalizedAuthorityKey;
    }
    if (!active || !inputAvailable || !inputEnabled) {
      return;
    }
    if (
      !normalizedAuthorityKey ||
      normalizedAuthorityKey === previousAuthorityKey ||
      (previousAuthorityKey === null && inputSocketStartedWithAuthorityRef.current)
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => requestInputResizeRef.current?.());
    return () => window.cancelAnimationFrame(frame);
  }, [active, inputAuthorityKey, inputAvailable, inputEnabled]);

  return (
    <canvas
      aria-label="Shared Browser remote page"
      className="block h-full w-full touch-none bg-transparent object-contain outline-none"
      data-active={active ? "true" : "false"}
      data-input-available={inputAvailable ? "true" : "false"}
      data-input-enabled={inputEnabled ? "true" : "false"}
      data-input-ready={inputReady ? "true" : "false"}
      data-testid="shared-browser-cdp-screencast"
      ref={canvasRef}
      tabIndex={active && inputEnabled ? 0 : -1}
    />
  );
}
