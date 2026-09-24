// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { localTabVideoPublisher } from "../runtimeController/localTabVideoPublisher";
import { localTabVideoViewer } from "../runtimeController/localTabVideoViewer";
import { readLocalVideoState, type LocalVideoPeer } from "../runtimeController/localTabVideo";
const id = "11111111-1111-4111-8111-111111111111",
  view = "22222222-2222-4222-8222-222222222222";
const sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
const peer: LocalVideoPeer = {
  id,
  connectionId: id,
  viewId: null,
  viewport: { width: 390, height: 650, dpr: 2 },
  configuration: { iceServers: [], iceTransportPolicy: "all" },
  offer: null,
  answer: null,
  playing: false,
};
const state = (peers: LocalVideoPeer[], needsFollowFrames = true) => ({
  type: "videoState",
  available: true,
  needsFollowFrames,
  peers,
});
const socket = () => ({ readyState: WebSocket.OPEN, send: vi.fn() });
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("a revoked negotiation cannot publish a late native offer or reopen through a lease", async () => {
  let complete!: (sdp: string) => void;
  const bridge = {
    notify: vi.fn(),
    browserTabVideo: vi.fn((options) =>
      options.operation === "open"
        ? new Promise((r) => {
            complete = r;
          })
        : Promise.resolve(),
    ),
  };
  const ws = socket(),
    video = localTabVideoPublisher(bridge, "owner", "capture", ws as unknown as WebSocket);
  video.receive(state([peer]));
  video.receive(state([]));
  complete(sdp);
  await flush();
  expect(ws.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "videoOffer")).toBe(false);
  video.receive({ type: "videoLease", peers: [peer] });
  await flush();
  expect(bridge.browserTabVideo.mock.calls.filter(([o]) => o.operation === "open")).toHaveLength(1);
  video.dispose();
});
it("JPEG fallback stays enabled until the matching video is playing and returns after failure", async () => {
  const bridge = { notify: vi.fn(), browserTabVideo: vi.fn().mockResolvedValue(sdp) };
  const ws = socket(),
    video = localTabVideoPublisher(bridge, "owner", "capture", ws as unknown as WebSocket);
  expect(video.needsFrames(null)).toBe(true);
  video.receive(state([peer]));
  expect(video.needsFrames(null)).toBe(true);
  video.receive(state([{ ...peer, playing: true }], false));
  expect(video.needsFrames(null)).toBe(false);
  expect(video.needsFrames(view)).toBe(true);
  video.receive(state([{ ...peer, viewId: view, playing: true }], true));
  expect(video.needsFrames(null)).toBe(true);
  expect(video.needsFrames(view)).toBe(false);
  video.receive(state([]));
  expect(video.needsFrames(view)).toBe(true);
  video.dispose();
  await flush();
});
it("native negotiation failures end only that video peer and preserve the JPEG socket", async () => {
  const bridge = {
    notify: vi.fn(),
    browserTabVideo: vi.fn((o) =>
      o.operation === "open" ? Promise.reject(new Error("Capture failed")) : Promise.resolve(),
    ),
  };
  const ws = socket(),
    video = localTabVideoPublisher(bridge, "owner", "capture", ws as unknown as WebSocket);
  video.receive(state([peer]));
  await flush();
  expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "videoClose", id }));
  video.receive(state([{ ...peer, playing: true }], false));
  await flush();
  expect(bridge.browserTabVideo.mock.calls.filter(([o]) => o.operation === "open")).toHaveLength(1);
  expect(video.needsFrames(null)).toBe(true);
  video.receive(state([]));
  expect(video.needsFrames(null)).toBe(true);
  video.dispose();
});
it("malformed or oversized signaling cannot reach a native peer", () => {
  expect(readLocalVideoState(state([{ ...peer, offer: "x".repeat(32769) }]))).toBeNull();
  expect(readLocalVideoState(state([{ ...peer, viewId: "not-a-view" }]))).toBeNull();
  expect(readLocalVideoState(state([peer]))).not.toBeNull();
});
class PeerConnection {
  static instances: PeerConnection[] = [];
  signalingState = "stable";
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() {
    PeerConnection.instances.push(this);
  }
  setRemoteDescription = vi.fn(async () => {});
  createAnswer = vi.fn(async () => ({ type: "answer", sdp }));
  setLocalDescription = vi.fn(async (value: RTCSessionDescriptionInit) => {
    this.localDescription = value;
  });
  close = vi.fn(() => {
    this.signalingState = "closed";
  });
}
function receiver() {
  PeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", PeerConnection);
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(private tracks: MediaStreamTrack[]) {}
      getTracks() {
        return this.tracks;
      }
    },
  );
  const ws = socket(),
    streams = vi.fn();
  const video = localTabVideoViewer(ws as unknown as WebSocket, streams);
  video.receive(state([]));
  const requested = JSON.parse(ws.send.mock.calls[0][0]).id as string;
  return { ws, streams, video, requested };
}
it("local-network viewers can negotiate without secure-context randomUUID", () => {
  vi.useFakeTimers();
  vi.stubGlobal("crypto", {});
  const f = receiver();
  expect(f.requested).toMatch(/^[0-9a-f-]{36}$/i);
  f.video.dispose();
});
it("video decode enables streaming, viewport updates preserve the peer, and changing view clears its pixels", async () => {
  vi.useFakeTimers();
  const f = receiver();
  f.video.receive(state([{ ...peer, id: f.requested, offer: sdp }]));
  await flush();
  const pc = PeerConnection.instances[0],
    track = { stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
  pc.ontrack!({ track });
  const stream = f.streams.mock.calls.at(-1)![0] as MediaStream;
  expect(f.video.playing).toBe(false);
  f.video.decoded(stream);
  expect(f.video.playing).toBe(true);
  expect(f.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "videoPlaying", id: f.requested }));
  await vi.advanceTimersByTimeAsync(600000);
  expect(
    f.ws.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === "videoRequest"),
  ).toHaveLength(1);
  f.video.setViewport({ width: 650, height: 390, dpr: 2 });
  expect(PeerConnection.instances).toHaveLength(1);
  f.video.setView(view);
  expect(pc.close).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(f.streams).toHaveBeenLastCalledWith(null);
  expect(f.video.playing).toBe(false);
  expect(f.video.decoded(stream)).toBe(false);
  expect(f.video.playing).toBe(false);
  f.video.dispose();
  await vi.advanceTimersByTimeAsync(240000);
  expect(PeerConnection.instances).toHaveLength(1);
});
it("failed video retries without ending the sharing socket; disposal fences late signaling", async () => {
  vi.useFakeTimers();
  const f = receiver();
  f.video.receive(state([{ ...peer, id: f.requested, offer: sdp }]));
  await flush();
  const pc = PeerConnection.instances[0];
  pc.connectionState = "failed";
  pc.onconnectionstatechange!();
  expect(f.video.playing).toBe(false);
  expect(f.streams).toHaveBeenLastCalledWith(null);
  await vi.advanceTimersByTimeAsync(30000);
  expect(
    f.ws.send.mock.calls.filter(([raw]) => JSON.parse(raw).type === "videoRequest"),
  ).toHaveLength(2);
  f.video.dispose();
  f.video.receive(state([{ ...peer, offer: sdp }]));
  await flush();
  expect(PeerConnection.instances).toHaveLength(1);
});
