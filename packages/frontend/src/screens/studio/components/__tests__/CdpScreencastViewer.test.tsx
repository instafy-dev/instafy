// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CdpScreencastViewer } from "../CdpScreencastViewer";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  listeners = new Map<string, Set<(event: Event & { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
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

  emit(type: string, event: Event & { data?: unknown } = new Event(type)) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe() {}
  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function bitmap(width = 2, height = 1): ImageBitmap {
  return {
    width,
    height,
    close: vi.fn(),
  } as unknown as ImageBitmap;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function emitFrame(socket: FakeWebSocket, frameId: number) {
  socket.emit(
    "message",
    Object.assign(new Event("message"), {
      data: JSON.stringify({
        type: "frame",
        frameId,
        data: "YQ==",
        metadata: {},
      }),
    }),
  );
}

function socketsMatching(path: string): FakeWebSocket[] {
  return FakeWebSocket.instances.filter((socket) => socket.url.includes(path));
}

describe("CdpScreencastViewer", () => {
  let host: HTMLDivElement;
  let root: Root;
  const drawImage = vi.fn();
  let canvasRect: DOMRect;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeWebSocket.instances = [];
    FakeResizeObserver.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 1280, height: 720, close: vi.fn() }),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      imageSmoothingEnabled: true,
    } as unknown as CanvasRenderingContext2D);
    canvasRect = {
      left: 0,
      top: 0,
      width: 640,
      height: 360,
    } as DOMRect;
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
      () => canvasRect,
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    drawImage.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("acks a frame only after it has been decoded and painted", async () => {
    const messagesAtConnect: unknown[] = [];
    const onConnected = vi.fn(() => {
      messagesAtConnect.push(
        ...(FakeWebSocket.instances[0]?.sent.map((value) => JSON.parse(value)) ?? []),
      );
    });
    await act(async () => {
      root.render(
        <CdpScreencastViewer
          wsUrl="wss://runtime.test/browser/screencast?token=secret"
          connectionGeneration={0}
          active
          inputEnabled
          onConnected={onConnected}
          onDisconnected={vi.fn()}
          onTransportError={vi.fn()}
        />,
      );
    });

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).not.toContain("token=secret&token");
    await act(async () => {
      socket.emit(
        "message",
        Object.assign(new Event("message"), {
          data: JSON.stringify({
            type: "ready",
            pageId: "PAGE",
            width: 640,
            height: 360,
            dpr: 2,
            deviceWidth: 1280,
            deviceHeight: 720,
          }),
        }),
      );
      socket.emit(
        "message",
        Object.assign(new Event("message"), {
          data: JSON.stringify({
            type: "frame",
            frameId: 9,
            data: "YQ==",
            metadata: {},
          }),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onConnected).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledOnce();
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: "ack",
      frameId: 9,
    });
    expect(socket.sent.map((value) => JSON.parse(value))).not.toContainEqual(
      expect.objectContaining({ type: "resize" }),
    );
    expect(messagesAtConnect).toContainEqual({ type: "ack", frameId: 9 });
    const canvas = host.querySelector<HTMLCanvasElement>(
      '[data-testid="shared-browser-cdp-screencast"]',
    );
    expect(canvas?.classList.contains("object-contain")).toBe(true);
    expect(canvas?.dataset.remoteContentWidth).toBe("1280");
    expect(canvas?.dataset.remoteContentHeight).toBe("720");
  });

  it("does not open a disposable StrictMode renderer connection", async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <CdpScreencastViewer
            wsUrl="wss://runtime.test/browser/screencast"
            connectionGeneration={0}
            active
            inputEnabled={false}
            onConnected={vi.fn()}
            onDisconnected={vi.fn()}
            onTransportError={vi.fn()}
          />
        </StrictMode>,
      );
      await Promise.resolve();
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.OPEN);
  });

  it("uses decoded pixels instead of spectator-local viewport metadata", async () => {
    await act(async () => {
      root.render(
        <CdpScreencastViewer
          wsUrl="wss://runtime.test/browser/screencast"
          connectionGeneration={0}
          active
          inputEnabled={false}
          onConnected={vi.fn()}
          onDisconnected={vi.fn()}
          onTransportError={vi.fn()}
        />,
      );
    });
    const canvas = host.querySelector<HTMLCanvasElement>(
      '[data-testid="shared-browser-cdp-screencast"]',
    )!;

    await act(async () => {
      FakeWebSocket.instances[0]?.emit(
        "message",
        Object.assign(new Event("message"), {
          data: JSON.stringify({
            type: "viewport",
            pageId: "PAGE",
            width: 390,
            height: 844,
            dpr: 1,
            deviceWidth: 390,
            deviceHeight: 844,
          }),
        }),
      );
      emitFrame(FakeWebSocket.instances[0], 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(canvas.getBoundingClientRect()).toMatchObject({ width: 640, height: 360 });
    expect(canvas.dataset.remoteContentWidth).toBe("1280");
    expect(canvas.dataset.remoteContentHeight).toBe("720");
  });

  it("does not let a late older decode overwrite a newer painted frame", async () => {
    const firstDecode = deferred<ImageBitmap>();
    const secondDecode = deferred<ImageBitmap>();
    const firstBitmap = bitmap(2, 1);
    const secondBitmap = bitmap(3, 2);
    vi.mocked(window.createImageBitmap)
      .mockImplementationOnce(() => firstDecode.promise)
      .mockImplementationOnce(() => secondDecode.promise);

    await act(async () => {
      root.render(
        <CdpScreencastViewer
          wsUrl="wss://runtime.test/browser/screencast"
          connectionGeneration={0}
          active
          inputEnabled
          onConnected={vi.fn()}
          onDisconnected={vi.fn()}
          onTransportError={vi.fn()}
        />,
      );
    });
    const socket = FakeWebSocket.instances[0];

    await act(async () => {
      emitFrame(socket, 1);
      emitFrame(socket, 2);
      secondDecode.resolve(secondBitmap);
      await secondDecode.promise;
    });
    expect(drawImage).toHaveBeenCalledOnce();
    expect(drawImage.mock.calls[0]?.[0]).toBe(secondBitmap);
    const canvas = host.querySelector<HTMLCanvasElement>(
      '[data-testid="shared-browser-cdp-screencast"]',
    )!;
    expect(canvas.dataset.remoteContentWidth).toBe("3");
    expect(canvas.dataset.remoteContentHeight).toBe("2");

    await act(async () => {
      firstDecode.resolve(firstBitmap);
      await firstDecode.promise;
    });
    expect(drawImage).toHaveBeenCalledOnce();
    expect(canvas.dataset.remoteContentWidth).toBe("3");
    expect(canvas.dataset.remoteContentHeight).toBe("2");
    expect(firstBitmap.close).toHaveBeenCalledOnce();
    expect(secondBitmap.close).toHaveBeenCalledOnce();
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual(
      expect.arrayContaining([
        { type: "ack", frameId: 1 },
        { type: "ack", frameId: 2 },
      ]),
    );
  });

  it("does not let a disposed connection paint over its replacement", async () => {
    const oldDecode = deferred<ImageBitmap>();
    const newDecode = deferred<ImageBitmap>();
    const oldBitmap = bitmap(2, 1);
    const newBitmap = bitmap(4, 3);
    vi.mocked(window.createImageBitmap)
      .mockImplementationOnce(() => oldDecode.promise)
      .mockImplementationOnce(() => newDecode.promise);
    const renderViewer = (wsUrl: string) => (
      <CdpScreencastViewer
        wsUrl={wsUrl}
        connectionGeneration={0}
        active
        inputEnabled
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onTransportError={vi.fn()}
      />
    );

    await act(async () => root.render(renderViewer("wss://runtime.test/old")));
    emitFrame(FakeWebSocket.instances[0], 1);

    await act(async () => root.render(renderViewer("wss://runtime.test/new")));
    const newSocket = FakeWebSocket.instances[1];
    await act(async () => {
      emitFrame(newSocket, 2);
      newDecode.resolve(newBitmap);
      await newDecode.promise;
    });
    expect(drawImage).toHaveBeenCalledOnce();
    expect(drawImage.mock.calls[0]?.[0]).toBe(newBitmap);

    await act(async () => {
      oldDecode.resolve(oldBitmap);
      await oldDecode.promise;
    });
    expect(drawImage).toHaveBeenCalledOnce();
    expect(oldBitmap.close).toHaveBeenCalledOnce();
    expect(newBitmap.close).toHaveBeenCalledOnce();
  });

  it("reopens identical renderer and input URLs when the connection generation changes", async () => {
    const renderViewer = (connectionGeneration: number) => (
      <CdpScreencastViewer
        wsUrl="wss://runtime.test/browser/screencast?token=same-grant"
        inputWsUrl="wss://runtime.test/browser/input?token=same-grant"
        inputAvailable
        connectionGeneration={connectionGeneration}
        active
        inputEnabled
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onTransportError={vi.fn()}
      />
    );

    await act(async () => root.render(renderViewer(0)));
    expect(FakeWebSocket.instances).toHaveLength(2);
    const [firstRenderer] = socketsMatching("/browser/screencast");
    const [firstInput] = socketsMatching("/browser/input");

    await act(async () => root.render(renderViewer(0)));
    expect(FakeWebSocket.instances).toHaveLength(2);

    await act(async () => root.render(renderViewer(1)));
    expect(FakeWebSocket.instances).toHaveLength(4);
    const [, secondRenderer] = socketsMatching("/browser/screencast");
    const [, secondInput] = socketsMatching("/browser/input");
    expect(firstRenderer?.readyState).toBe(3);
    expect(firstInput?.readyState).toBe(3);
    expect(secondRenderer?.url).toBe(firstRenderer?.url);
    expect(secondInput?.url).toBe(firstInput?.url);
  });

  it("fails closed when the socket never produces a ready message or frame", async () => {
    vi.useFakeTimers();
    const onTransportError = vi.fn();
    await act(async () => {
      root.render(
        <CdpScreencastViewer
          wsUrl="wss://runtime.test/browser/screencast"
          connectionGeneration={0}
          active
          inputEnabled
          onConnected={vi.fn()}
          onDisconnected={vi.fn()}
          onTransportError={onTransportError}
        />,
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(onTransportError).toHaveBeenCalledWith(
      "Shared Browser renderer did not produce its first frame.",
      true,
    );
    expect(FakeWebSocket.instances[0]?.readyState).toBe(3);
  });

  it("dedupes observer resizes and ignores a hidden mounted surface", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <CdpScreencastViewer
          wsUrl="wss://runtime.test/browser/screencast"
          connectionGeneration={0}
          inputWsUrl="wss://runtime.test/browser/input"
          inputAvailable
          inputAuthorityKey="human:owner"
          active
          inputEnabled
          onConnected={vi.fn()}
          onDisconnected={vi.fn()}
          onTransportError={vi.fn()}
        />,
      );
    });
    const [inputSocket] = socketsMatching("/browser/input");
    inputSocket.emit(
      "message",
      Object.assign(new Event("message"), {
        data: JSON.stringify({
          type: "ready",
          pageId: "PAGE",
          width: 640,
          height: 360,
          dpr: 1,
          deviceWidth: 640,
          deviceHeight: 360,
        }),
      }),
    );

    canvasRect = { ...canvasRect, width: 800 } as DOMRect;
    FakeResizeObserver.instances[0]?.trigger();
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(
      inputSocket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "resize"),
    ).toEqual([{ type: "resize", width: 800, height: 360, dpr: 1 }]);

    FakeResizeObserver.instances[0]?.trigger();
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(
      inputSocket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "resize"),
    ).toHaveLength(1);

    canvasRect = { ...canvasRect, width: 0, height: 0 } as DOMRect;

    FakeResizeObserver.instances[0]?.trigger();
    await act(async () => {
      vi.advanceTimersByTime(120);
    });

    expect(
      inputSocket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "resize"),
    ).toHaveLength(1);
  });

  it("keeps frames active while locking and restoring human transport input", async () => {
    const renderViewer = (inputEnabled: boolean) => (
      <CdpScreencastViewer
        wsUrl="wss://runtime.test/browser/screencast"
        connectionGeneration={0}
        inputWsUrl="wss://runtime.test/browser/input"
        inputAvailable
        active
        inputEnabled={inputEnabled}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onTransportError={vi.fn()}
      />
    );
    await act(async () => root.render(renderViewer(true)));
    const [inputSocket] = socketsMatching("/browser/input");
    await act(async () => {
      inputSocket.emit("open");
      inputSocket.emit(
        "message",
        Object.assign(new Event("message"), {
          data: JSON.stringify({
            type: "ready",
            pageId: "PAGE",
            width: 640,
            height: 360,
            dpr: 1,
            deviceWidth: 640,
            deviceHeight: 360,
          }),
        }),
      );
    });
    const canvas = host.querySelector<HTMLCanvasElement>(
      '[data-testid="shared-browser-cdp-screencast"]',
    )!;

    canvas.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "a", code: "KeyA" }),
    );
    expect(inputSocket.sent.map((value) => JSON.parse(value))).toContainEqual(
      expect.objectContaining({ type: "key", key: "a" }),
    );

    const sentBeforeLock = inputSocket.sent.length;
    await act(async () => root.render(renderViewer(false)));
    expect(canvas.dataset.active).toBe("true");
    expect(canvas.dataset.inputEnabled).toBe("false");
    expect(canvas.tabIndex).toBe(-1);
    canvas.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "b", code: "KeyB" }),
    );
    expect(inputSocket.sent).toHaveLength(sentBeforeLock);

    await act(async () => root.render(renderViewer(true)));
    canvas.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "c", code: "KeyC" }),
    );
    expect(inputSocket.sent.map((value) => JSON.parse(value))).toContainEqual(
      expect.objectContaining({ type: "key", key: "c" }),
    );
    expect(canvas.tabIndex).toBe(0);
  });

  it("does not duplicate the viewport override when an authoritative input socket opens", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <CdpScreencastViewer
          wsUrl="wss://runtime.test/browser/screencast"
          connectionGeneration={0}
          inputWsUrl="wss://runtime.test/browser/input"
          inputAvailable
          inputAuthorityKey="human:owner"
          active
          inputEnabled
          onConnected={vi.fn()}
          onDisconnected={vi.fn()}
          onTransportError={vi.fn()}
        />,
      );
    });
    const [inputSocket] = socketsMatching("/browser/input");
    await act(async () => {
      inputSocket.emit("open");
      inputSocket.emit(
        "message",
        Object.assign(new Event("message"), {
          data: JSON.stringify({
            type: "ready",
            pageId: "PAGE",
            width: 640,
            height: 360,
            dpr: 1,
            deviceWidth: 640,
            deviceHeight: 360,
          }),
        }),
      );
      FakeResizeObserver.instances[0]?.trigger();
      vi.advanceTimersByTime(120);
    });

    expect(
      inputSocket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "resize"),
    ).toEqual([]);
  });

  it("resizes once for a real control-owner change but not a same-owner reconnect", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const renderViewer = (inputEnabled: boolean, inputAuthorityKey: string | null) => (
      <CdpScreencastViewer
        wsUrl="wss://runtime.test/browser/screencast"
        connectionGeneration={0}
        inputWsUrl="wss://runtime.test/browser/input"
        inputAvailable
        inputAuthorityKey={inputAuthorityKey}
        active
        inputEnabled={inputEnabled}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onTransportError={vi.fn()}
      />
    );
    await act(async () => root.render(renderViewer(false, "human:owner")));
    const [inputSocket] = socketsMatching("/browser/input");
    await act(async () => {
      inputSocket.emit(
        "message",
        Object.assign(new Event("message"), {
          data: JSON.stringify({
            type: "ready",
            pageId: "PAGE",
            width: 640,
            height: 360,
            dpr: 1,
            deviceWidth: 640,
            deviceHeight: 360,
          }),
        }),
      );
    });

    await act(async () => root.render(renderViewer(true, "human:member")));
    expect(
      inputSocket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "resize"),
    ).toHaveLength(1);

    await act(async () => root.render(renderViewer(false, null)));
    await act(async () => root.render(renderViewer(true, "human:member")));
    expect(
      inputSocket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "resize"),
    ).toHaveLength(1);

    await act(async () => root.render(renderViewer(false, "human:owner")));
    await act(async () => root.render(renderViewer(true, "human:member")));
    expect(
      inputSocket.sent.map((value) => JSON.parse(value)).filter((value) => value.type === "resize"),
    ).toHaveLength(2);
  });
});
