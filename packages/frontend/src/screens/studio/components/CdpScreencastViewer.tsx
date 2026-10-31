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
/**
 * The browser allows each viewer two picture streams at a time, and counts
 * one this view closed until it has finished setting it up. A picture asked
 * for within this long of the view closing its last one (it moved to another
 * tab, or its address was renewed) may be refused only for that.
 */
const CDP_PICTURE_REPLACED_WINDOW_MS = 2_000;
/** How long such a refused picture waits before it is asked for once more. */
export const CDP_PICTURE_RETRY_DELAY_MS = 1_000;

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

function sameViewport(left: CdpScreencastViewport, right: CdpScreencastViewport): boolean {
  return left.width === right.width && left.height === right.height && left.dpr === right.dpr;
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
  const requestInputResizeRef = useRef<((force: boolean) => void) | null>(null);
  const inputSocketStartedWithAuthorityRef = useRef(false);
  const lastObservedInputAuthorityKeyRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onConnected, onDisconnected, onTransportError });
  /** When the view last closed a picture socket of its own (CDP_PICTURE_REPLACED_WINDOW_MS). */
  const pictureClosedAtRef = useRef<number | null>(null);
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
    let retryTimer: number | null = null;
    const currentViewport = initialViewport(canvas);
    setRemoteBrowserSurfaceContentSize(
      canvas,
      currentViewport.width,
      currentViewport.height,
    );
    let latestFrameId = 0;
    let paintedFrameId = 0;
    let socket: WebSocket | null = null;
    // This picture replaces one the view closed just now: the browser may
    // refuse it while it still counts that one, so a refusal is asked again
    // once before it counts as failed (and the view moves to another viewer).
    const replacedAtMs = pictureClosedAtRef.current;
    let retriesLeft = replacedAtMs !== null && Date.now() - replacedAtMs < CDP_PICTURE_REPLACED_WINDOW_MS ? 1 : 0;

    const open = () => {
      if (disposed) {
        return;
      }

      const nextSocket = new WebSocket(withInitialViewport(wsUrl, currentViewport));
      socket = nextSocket;
      // Whether the browser said anything on this socket; and whether it was
      // given up for a new ask, so nothing it does later counts.
      let heard = false;
      let superseded = false;
      // Ended before the browser said anything: asked for again once, a
      // moment later, while a retry is left. True when it was (or already had
      // been), so the end is not reported.
      const askAgain = (): boolean => {
        if (superseded) {
          return true;
        }
        if (heard || connected || retriesLeft <= 0) {
          return false;
        }
        retriesLeft -= 1;
        superseded = true;
        nextSocket.close();
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          open();
        }, CDP_PICTURE_RETRY_DELAY_MS);
        return true;
      };

      const send = (message: Record<string, unknown>) => {
        if (websocketOpen(nextSocket)) {
          nextSocket.send(JSON.stringify(message));
        }
      };

      nextSocket.addEventListener("message", (event) => {
        const message = parseCdpScreencastServerMessage(event.data);
        if (!message || disposed || superseded) {
          return;
        }
        heard = true;
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
        if (!disposed && !askAgain()) {
          callbacksRef.current.onTransportError(
            "Shared Browser renderer connection failed.",
            true,
          );
        }
      });
      nextSocket.addEventListener("close", (event) => {
        if (!disposed && !askAgain()) {
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
    };

    // React StrictMode intentionally mounts, disposes, and remounts effects in
    // development. Defer the network side effect by one microtask so the
    // disposed probe cannot overlap the replacement CDP screencast session.
    // This also collapses same-commit URL/generation replacements without
    // delaying ordinary renderer startup by a visible frame.
    queueMicrotask(() => {
      if (disposed) {
        return;
      }
      // One deadline for the first frame, whichever ask brings it.
      firstFrameTimer = window.setTimeout(() => {
        firstFrameTimer = null;
        if (!disposed && !connected) {
          retriesLeft = 0;
          if (retryTimer !== null) {
            window.clearTimeout(retryTimer);
            retryTimer = null;
          }
          callbacksRef.current.onTransportError(
            "Shared Browser renderer did not produce its first frame.",
            true,
          );
          socket?.close(1011, "first frame timeout");
        }
      }, CDP_FIRST_FRAME_TIMEOUT_MS);
      open();
    });

    return () => {
      disposed = true;
      if (firstFrameTimer !== null) {
        window.clearTimeout(firstFrameTimer);
      }
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      // The browser counts this picture until it has set it up: the next one
      // may be refused for that alone.
      if (socket) {
        pictureClosedAtRef.current = Date.now();
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
    // The size the browser took for this view: its answer to a resize, or
    // the size it opened with for a view that could already drive. A size it
    // never took (sent while control was changing hands, or opened with
    // before this view could drive) is sent again whenever the view is on
    // screen with its input, so the page never stays a desktop's size on a
    // phone, or a phone's on a desktop.
    let confirmedViewport: CdpScreencastViewport | null = null;
    let authorityResizePending = false;
    let resizeTimer: number | null = null;
    const startedWithAuthority = inputEnabledRef.current;
    inputSocketStartedWithAuthorityRef.current = startedWithAuthority;
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
    requestInputResizeRef.current = (force) => {
      const next = ready ? measuredViewport(canvas) : null;
      const taken = next !== null && confirmedViewport !== null && sameViewport(next, confirmedViewport);
      sendResize(force || (ready && !taken));
    };
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
        if (message.type === "viewport") confirmedViewport = message;
        if (message.type === "ready") {
          ready = true;
          setReadyInputConnectionKey(inputConnectionKey);
          window.clearTimeout(readyTimer);
          if (authorityResizePending) {
            sendResize(true);
          } else if (inputEnabledRef.current && startedWithAuthority) {
            // The origin awaits its initial device-metrics override before it
            // emits ready for the live driver. Seed the dedupe tuple from that
            // authoritative viewport instead of immediately overriding it a
            // second time from the client.
            lastSentViewport = currentViewport;
            confirmedViewport = currentViewport;
          } else if (inputEnabledRef.current) {
            // This view could not drive yet when it connected, so the origin
            // echoes the size it asked for without setting it.
            sendResize(true);
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
    // A new driver sets the page's size again. The same driver coming back
    // (the view on screen again, or its input back) sends the size this view
    // has now unless the browser already took that size: a resize while it
    // could not drive never reached the page, which kept a phone's width on
    // a desktop, and a desktop's on a phone.
    const authorityChanged =
      Boolean(normalizedAuthorityKey) &&
      normalizedAuthorityKey !== previousAuthorityKey &&
      !(previousAuthorityKey === null && inputSocketStartedWithAuthorityRef.current);
    const frame = window.requestAnimationFrame(() => requestInputResizeRef.current?.(authorityChanged));
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
