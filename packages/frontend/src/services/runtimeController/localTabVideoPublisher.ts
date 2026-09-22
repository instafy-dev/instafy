import { readLocalVideoState, type LocalVideoPeer, type LocalVideoState } from "./localTabVideo";

export function localTabVideoPublisher(
  bridge: NonNullable<Window["instafyDesktop"]>,
  ownerId: string,
  captureId: string,
  socket: WebSocket,
) {
  let disposed = false;
  let snapshot: LocalVideoState | null = null;
  const peers = new Map<
    string,
    { viewId: string | null; answer?: string; viewport: string; current: LocalVideoPeer }
  >();
  const failed = new Set<string>();
  const invoke = (
    operation: Parameters<NonNullable<typeof bridge.browserTabVideo>>[0]["operation"],
    value: unknown,
  ) => bridge.browserTabVideo!({ ownerId, captureId, operation, value });
  const send = (value: unknown) => {
    if (!disposed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  function close(id: string, notify = false) {
    peers.delete(id);
    void invoke("close", { id }).catch(() => {});
    if (notify) {
      failed.add(id);
      send({ type: "videoClose", id });
    }
  }
  function receive(message: unknown) {
    if (disposed) return;
    const value = message as { type?: string; peers?: unknown };
    if (value?.type === "videoLease" && Array.isArray(value.peers)) {
      void invoke("sync", value.peers)
        .then(() => send({ type: "videoAlive" }))
        .catch(() => {});
      return;
    }
    const state = readLocalVideoState(message);
    if (!state) return;
    snapshot = state;
    for (const id of failed) if (!state.peers.some((p) => p.id === id)) failed.delete(id);
    for (const id of peers.keys()) if (!state.peers.some((p) => p.id === id)) close(id);
    for (const requested of state.peers) {
      if (failed.has(requested.id)) continue;
      let peer = peers.get(requested.id);
      if (!peer) {
        peer = {
          viewId: requested.viewId,
          viewport: JSON.stringify(requested.viewport),
          current: requested,
        };
        peers.set(requested.id, peer);
        const opening = peer;
        void invoke("open", {
          id: requested.id,
          viewId: requested.viewId,
          viewport: requested.viewport,
          configuration: requested.configuration,
        })
          .then((sdp) => {
            if (disposed || peers.get(requested.id) !== opening)
              return invoke("close", { id: requested.id });
            if (typeof sdp !== "string") throw new Error("Video unavailable.");
            send({ type: "videoOffer", id: requested.id, sdp });
          })
          .catch(() => {
            if (peers.get(requested.id) === opening) close(requested.id, true);
          });
      }
      peer.current = requested;
      if (requested.answer && !peer.answer) {
        peer.answer = requested.answer;
        const answering = peer;
        void invoke("answer", { id: requested.id, sdp: requested.answer })
          .then(() => {
            if (peers.get(requested.id) === answering)
              return invoke("viewport", { id: requested.id, viewport: answering.current.viewport });
          })
          .catch(() => {
            if (peers.get(requested.id) === answering) close(requested.id, true);
          });
      }
      const viewport = JSON.stringify(requested.viewport);
      if (peer.viewport !== viewport) {
        peer.viewport = viewport;
        void invoke("viewport", { id: requested.id, viewport: requested.viewport }).catch(() =>
          close(requested.id, true),
        );
      }
    }
    void invoke("sync", state.peers).catch(() => {});
  }
  return {
    receive,
    needsFrames(viewId: string | null) {
      if (!snapshot?.available) return true;
      if (snapshot.peers.some((p) => p.viewId === viewId && failed.has(p.id))) return true;
      return viewId === null
        ? snapshot.needsFollowFrames
        : !snapshot.peers.some((p) => p.viewId === viewId && p.playing);
    },
    dispose() {
      disposed = true;
      for (const id of peers.keys()) close(id);
    },
  };
}
