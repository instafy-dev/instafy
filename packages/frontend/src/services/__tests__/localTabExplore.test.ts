// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  localExploreFrame,
  readLocalTabFrame,
  type LocalExploreState,
} from "../runtimeController/localTabExplore";
import { localTabExplorePublisher } from "../runtimeController/localTabExplorePublisher";
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const jpeg = new Uint8Array([255, 216, 255, 217]);
const request = {
  connectionId: "viewer",
  userId: "user",
  viewport: { width: 390, height: 650, dpr: 2 },
};
const state: LocalExploreState = {
  type: "exploreState",
  available: true,
  requested: false,
  view: null,
  views: [{ ...request, viewId: id }],
  requests: [],
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("private frames require the current exact view, while Follow accepts only canonical frames", () => {
  const bytes = localExploreFrame(id, jpeg);
  expect(readLocalTabFrame(bytes.buffer, id)).toEqual(jpeg);
  expect(readLocalTabFrame(bytes.buffer, other)).toBeNull();
  expect(readLocalTabFrame(bytes.buffer, null)).toBeNull();
  expect(readLocalTabFrame(jpeg.buffer, id)).toBeNull();
  expect(readLocalTabFrame(jpeg.buffer, null)).toEqual(jpeg);
});
function fixture() {
  const bridge = {
    notify: vi.fn(),
    browserTabExploreOpen: vi.fn().mockResolvedValue({ viewId: id }),
    browserTabExploreClose: vi.fn().mockResolvedValue(undefined),
    browserTabExploreRenew: vi.fn().mockResolvedValue(true),
    browserTabExploreFrame: vi
      .fn<(options: { viewId: string }) => Promise<Uint8Array>>()
      .mockResolvedValue(jpeg),
    browserTabExploreResize: vi.fn().mockResolvedValue(undefined),
    browserTabExploreInput: vi.fn().mockResolvedValue(undefined),
    browserTabExploreNavigate: vi.fn().mockResolvedValue(undefined),
  };
  const socket = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send: vi.fn(),
  };
  const publisher = localTabExplorePublisher(
    bridge,
    "owner",
    "capture",
    socket as unknown as WebSocket,
  );
  return { bridge, socket, publisher };
}
it("controller state alone cannot create native views; owner approval and matching ack precede input", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.publisher.state(state);
  expect(f.bridge.browserTabExploreOpen).not.toHaveBeenCalled();
  expect(f.socket.send).toHaveBeenCalledWith(
    JSON.stringify({ type: "exploreClose", viewId: id }),
  );
  await f.publisher.control.approve(request);
  expect(f.bridge.browserTabExploreOpen).toHaveBeenCalledWith({
    ownerId: "owner",
    captureId: "capture",
    viewport: request.viewport,
  });
  f.publisher.input({
    type: "exploreInput",
    viewId: id,
    input: { type: "text", text: "early" },
  });
  expect(f.bridge.browserTabExploreInput).not.toHaveBeenCalled();
  f.publisher.state(state);
  f.publisher.input({
    type: "exploreInput",
    viewId: id,
    input: { type: "text", text: "approved" },
  });
  expect(f.bridge.browserTabExploreInput).toHaveBeenCalledTimes(1);
  await f.publisher.control.close(id);
  f.publisher.input({
    type: "exploreInput",
    viewId: id,
    input: { type: "text", text: "late" },
  });
  expect(f.bridge.browserTabExploreInput).toHaveBeenCalledTimes(1);
  f.publisher.dispose();
});
it("revocation fences late native captures and expired leases never reopen a view", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (bytes: Uint8Array) => void;
  f.bridge.browserTabExploreFrame.mockImplementation(
    () =>
      new Promise<Uint8Array>((r) => {
        finish = r;
      }),
  );
  await f.publisher.control.approve(request);
  f.publisher.state(state);
  await vi.advanceTimersByTimeAsync(201);
  await f.publisher.control.close(id);
  finish(jpeg);
  await vi.advanceTimersByTimeAsync(1);
  expect(
    f.socket.send.mock.calls.every(([value]) => typeof value === "string"),
  ).toBe(true);
  f.publisher.state(state);
  expect(f.bridge.browserTabExploreOpen).toHaveBeenCalledTimes(1);
  f.publisher.dispose();
});
it("a stalled capture does not stall another view or accumulate captures for its own view", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (bytes: Uint8Array) => void;
  const stalled = new Promise<Uint8Array>((resolve) => {
    finish = resolve;
  });
  f.bridge.browserTabExploreFrame.mockImplementation(
    (options) => options.viewId === id ? stalled : Promise.resolve(jpeg),
  );
  await f.publisher.control.approve(request);
  f.bridge.browserTabExploreOpen.mockResolvedValue({ viewId: other });
  await f.publisher.control.approve({ ...request, connectionId: "second-viewer" });
  f.publisher.state({
    ...state,
    views: [
      state.views![0],
      { ...request, connectionId: "second-viewer", viewId: other },
    ],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    f.bridge.browserTabExploreFrame.mock.calls.filter(([options]) => options.viewId === id),
  ).toHaveLength(1);
  expect(
    f.bridge.browserTabExploreFrame.mock.calls.filter(([options]) => options.viewId === other),
  ).toHaveLength(5);
  const images = f.socket.send.mock.calls
    .map(([value]) => value)
    .filter(value => typeof value !== "string") as Uint8Array[];
  expect(images).toHaveLength(1);
  expect(
    images.every(frame => readLocalTabFrame(frame.buffer as ArrayBuffer, other)?.length === jpeg.length),
  ).toBe(true);
  f.publisher.dispose();
  finish(jpeg);
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    f.socket.send.mock.calls.filter(([value]) => typeof value !== "string"),
  ).toHaveLength(1);
  expect(f.bridge.browserTabExploreFrame).toHaveBeenCalledTimes(6);
});
it("does not capture while disconnected or backpressured, and rechecks congestion after capture", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.publisher.control.approve(request);
  f.publisher.state(state);
  f.socket.bufferedAmount = 1024 * 1024;
  await vi.advanceTimersByTimeAsync(400);
  expect(f.bridge.browserTabExploreFrame).not.toHaveBeenCalled();
  f.socket.bufferedAmount = 0;
  f.socket.readyState = WebSocket.CLOSED;
  await vi.advanceTimersByTimeAsync(400);
  expect(f.bridge.browserTabExploreFrame).not.toHaveBeenCalled();
  f.socket.readyState = WebSocket.OPEN;
  f.bridge.browserTabExploreFrame.mockImplementation(async () => {
    f.socket.bufferedAmount = 1024 * 1024;
    return jpeg;
  });
  await vi.advanceTimersByTimeAsync(400);
  expect(f.bridge.browserTabExploreFrame).toHaveBeenCalledTimes(1);
  expect(
    f.socket.send.mock.calls.every(([value]) => typeof value === "string"),
  ).toBe(true);
  f.publisher.dispose();
});
