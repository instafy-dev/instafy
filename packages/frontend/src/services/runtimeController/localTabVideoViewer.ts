import { gatherLocalVideoIce, readLocalVideoState } from "./localTabVideo";
import type { LocalExploreViewport } from "./localTabExplore";
import { generateUUID } from "../../utils/uuid";

export function localTabVideoViewer(
  socket: WebSocket,
  onStream: (stream: MediaStream | null) => void,
) {
  type Peer = {
    id: string;
    viewId: string | null;
    pc?: RTCPeerConnection;
    stream?: MediaStream;
    seen: boolean;
    playing: boolean;
  };
  let peer: Peer | undefined,
    disposed = false,
    available = false,
    viewId: string | null = null;
  let viewport: LocalExploreViewport = { width: 390, height: 500, dpr: 1 };
  let deadline: number | undefined, retry: number | undefined, disconnected: number | undefined;
  const send = (value: unknown) => {
    if (!disposed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  function clear(notify = true) {
    const old = peer;
    peer = undefined;
    window.clearTimeout(deadline);
    window.clearTimeout(disconnected);
    old?.pc?.close();
    old?.stream?.getTracks().forEach((t) => t.stop());
    onStream(null);
    if (old && notify) send({ type: "videoClose", id: old.id });
  }
  function start() {
    window.clearTimeout(retry);
    retry = undefined;
    if (disposed || !available || peer) return;
    peer = { id: generateUUID(), viewId, seen: false, playing: false };
    send({ type: "videoRequest", id: peer.id, viewport });
    deadline = window.setTimeout(failed, 25_000);
  }
  function failed() {
    clear();
    if (!disposed) retry = window.setTimeout(start, 30_000);
  }
  function receive(message: unknown) {
    const state = readLocalVideoState(message);
    if (!state || disposed) return;
    available = state.available;
    if (!available) {
      clear(false);
      return;
    }
    if (!peer) {
      if (retry === undefined) start();
      return;
    }
    const current = peer;
    const remote = state.peers.find((p) => p.id === current.id && p.viewId === current.viewId);
    if (!remote) {
      if (current.seen) failed();
      return;
    }
    current.seen = true;
    if (!remote.offer || current.pc) return;
    const pc = new RTCPeerConnection(remote.configuration);
    current.pc = pc;
    pc.ontrack = (event) => {
      if (peer !== current || disposed) return;
      current.stream = new MediaStream([event.track]);
      event.track.onended = () => {
        if (peer === current) failed();
      };
      onStream(current.stream);
    };
    pc.onconnectionstatechange = () => {
      if (peer !== current || disposed) return;
      window.clearTimeout(disconnected);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") failed();
      else if (pc.connectionState === "disconnected")
        disconnected = window.setTimeout(failed, 5000);
    };
    void (async () => {
      try {
        await pc.setRemoteDescription({ type: "offer", sdp: remote.offer! });
        await pc.setLocalDescription(await pc.createAnswer());
        await gatherLocalVideoIce(pc);
        if (peer === current && !disposed)
          send({ type: "videoAnswer", id: current.id, sdp: pc.localDescription!.sdp });
      } catch {
        if (peer === current) failed();
      }
    })();
  }
  return {
    receive,
    get playing() {
      return Boolean(peer?.playing);
    },
    decoded(stream: MediaStream) {
      if (disposed || peer?.stream !== stream) return false;
      if (peer.playing) return true;
      peer.playing = true;
      window.clearTimeout(deadline);
      send({ type: "videoPlaying", id: peer.id });
      return true;
    },
    setView(next: string | null) {
      if (next === viewId) return;
      viewId = next;
      window.clearTimeout(retry);
      retry = undefined;
      clear();
      start();
    },
    setViewport(next: LocalExploreViewport) {
      viewport = next;
      if (peer) send({ type: "videoViewport", id: peer.id, viewport });
    },
    async stats() {
      return peer?.pc
        ? [...(await peer.pc.getStats()).values()].filter((v) =>
            ["inbound-rtp", "codec", "candidate-pair"].includes(v.type),
          )
        : [];
    },
    dispose() {
      disposed = true;
      window.clearTimeout(retry);
      clear(false);
    },
  };
}
