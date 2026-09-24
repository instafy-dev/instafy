import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installBrowserTabVideoWorker } from "../dist/browserTabVideoWorker.js";

const software = { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" };
const hardware = { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=640034;packetization-mode=1" };
const vp8 = { mimeType: "video/VP8", clockRate: 90000 };
const rtx = { mimeType: "video/rtx", clockRate: 90000 };
const codecs = [vp8, software, rtx, hardware];
const options = { id: "peer", source: "source", sourceId: "tab", width: 750, height: 1076, viewport: { width: 375, height: 538, dpr: 2 }, configuration: {}, maxFramerate: 30 };
function fixture(encodingInfo) {
  const preferences = [], queries = [], timers = new Set();
  const track = { getSettings: () => ({ width: 750, height: 1076 }), stop() {} };
  const sender = { getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} };
  const worker = vm.runInNewContext(`(${installBrowserTabVideoWorker.toString()})()`, {
    navigator: {
      mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) },
      ...(encodingInfo ? { mediaCapabilities: { encodingInfo: async q => { queries.push(q); return encodingInfo(q); } } } : {}),
    },
    RTCRtpSender: { getCapabilities: () => ({ codecs }) },
    RTCPeerConnection: class {
      signalingState = "stable";
      iceGatheringState = "complete";
      addTrack() { return sender; }
      getTransceivers() { return [{ setCodecPreferences: c => preferences.push(Array.from(c)) }]; }
      async createOffer() { return { type: "offer", sdp: "offer" }; }
      async setLocalDescription(value) { this.localDescription = value; }
      close() { this.signalingState = "closed"; }
    },
    setTimeout: fn => { timers.add(fn); return fn; },
    clearTimeout: fn => timers.delete(fn),
  });
  return { worker, preferences, queries, timeout: () => { for (const fn of timers) fn(); } };
}

test("video offers prefer efficient H264 profiles while retaining every fallback", async () => {
  const f = fixture(q => ({ supported: true, powerEfficient: q.video.contentType.includes("640034") }));
  await f.worker.open(options);
  assert.deepEqual(f.preferences[0], [hardware, software, vp8, rtx]);
  assert.equal(f.queries.length, 3);
  for (const q of f.queries) {
    assert.equal(q.type, "webrtc");
    assert.deepEqual(JSON.parse(JSON.stringify(q.video)), {
      contentType: q.video.contentType, width: 750, height: 1076, bitrate: 4_000_000, framerate: 30,
    });
  }
});

test("efficient alternative codecs precede software H264 without hardcoding a profile", async () => {
  const f = fixture(q => ({ supported: true, powerEfficient: q.video.contentType === "video/VP8" }));
  await f.worker.open(options);
  assert.deepEqual(f.preferences[0], [vp8, software, hardware, rtx]);
});

test("missing or rejected capability queries preserve H264 preference and codec fallbacks", async () => {
  for (const query of [undefined, () => { throw Error("unsupported query"); }, () => ({ supported: false, powerEfficient: true })]) {
    const f = fixture(query);
    await f.worker.open(options);
    assert.deepEqual(f.preferences[0], [software, hardware, vp8, rtx]);
  }
});

test("stalled capability discovery cannot block video negotiation", async () => {
  const f = fixture(() => new Promise(() => {}));
  const opening = f.worker.open(options);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  f.timeout();
  await opening;
  assert.deepEqual(f.preferences[0], [software, hardware, vp8, rtx]);
});

test("closing a peer during capability discovery cannot start a late offer", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(() => pending);
  const opening = f.worker.open(options);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  f.worker.close(options.id);
  release({ supported: true, powerEfficient: true });
  await assert.rejects(opening, /Video ended/);
  assert.equal(f.preferences.length, 0);
});
