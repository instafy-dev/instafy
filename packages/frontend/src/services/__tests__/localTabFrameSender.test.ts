// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { localTabFrameSender, type LocalTabSocket } from "../runtimeController/localTabFrameSender";

afterEach(() => vi.useRealTimers());
function fixture(version: 1 | null = 1) {
  const socket = Object.assign(new EventTarget(), {
    readyState: WebSocket.OPEN, frameFlowVersion: version ?? undefined,
    send: vi.fn(), close: vi.fn(),
  });
  return { socket, frames: localTabFrameSender(socket as unknown as LocalTabSocket),
    ack: () => socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"frameAck"}' })) };
}
const frame = (n: number) => new Uint8Array([255, 216, n, 255, 217]);

it("a slow receiver gets the latest waiting image without starving other views", () => {
  const f = fixture();
  f.frames.offer("follow", frame(0));
  for (let i = 1; i < 100; i++) {
    f.frames.offer("phone", frame(i));
    f.frames.offer("desktop", frame(i));
    f.frames.offer("follow", frame(i));
  }
  expect(f.socket.send.mock.calls.map(([bytes]) => bytes[2])).toEqual([0]);
  f.ack();
  f.frames.offer("phone", frame(100));
  f.ack(); f.ack(); f.ack();
  expect(f.socket.send.mock.calls.map(([bytes]) => bytes[2])).toEqual([0, 99, 99, 99, 100]);
  f.frames.dispose();
});

it("revoking a view drops its unsent pixels and disposal fences late acknowledgements", () => {
  const f = fixture();
  f.frames.offer("follow", frame(0));
  f.frames.offer("removed", frame(1));
  f.frames.offer("kept", frame(2));
  f.frames.remove("removed"); f.ack();
  expect(f.socket.send.mock.calls.map(([bytes]) => bytes[2])).toEqual([0, 2]);
  f.frames.offer("kept", frame(3)); f.frames.dispose(); f.ack();
  f.frames.offer("kept", frame(4));
  expect(f.socket.send).toHaveBeenCalledTimes(2);
});

it("ends a stalled connection and clears its timeout on acknowledgement or disposal", async () => {
  vi.useFakeTimers(); const f = fixture();
  f.frames.offer("follow", frame(0));
  await vi.advanceTimersByTimeAsync(4900); f.ack();
  await vi.advanceTimersByTimeAsync(5000); expect(f.socket.close).not.toHaveBeenCalled();
  f.frames.offer("follow", frame(1));
  await vi.advanceTimersByTimeAsync(5000); expect(f.socket.close).toHaveBeenCalledTimes(1);
  f.frames.dispose(); await vi.advanceTimersByTimeAsync(5000);
  expect(f.socket.close).toHaveBeenCalledTimes(1);
});

it("keeps legacy controllers working when flow control was not negotiated", () => {
  const f = fixture(null);
  f.frames.offer("follow", frame(0)); f.frames.offer("follow", frame(1));
  expect(f.socket.send).toHaveBeenCalledTimes(2);
  f.frames.dispose();
});
