/// <reference lib="dom" />

export type VideoViewport = { width: number; height: number; dpr: number };
export type VideoPeerOptions = {
  id: string;
  source: string;
  sourceId: string;
  width: number;
  height: number;
  viewport: VideoViewport;
  configuration: RTCConfiguration;
  maxFramerate: 30 | 60;
};

// Self-contained: installed only by main in an isolated, bundled document.
// No website, Studio renderer, token, cookie or arbitrary script enters it.
export function installBrowserTabVideoWorker() {
  type Peer = {
    pc: RTCPeerConnection;
    source: string;
    sender?: RTCRtpSender;
    viewport: VideoViewport;
    maxFramerate: number;
    pending: Promise<void>;
  };
  type Source = { stream: MediaStream; width: number; height: number };
  const peers = new Map<string, Peer>();
  const sources = new Map<string, Promise<Source>>();
  // setParameters uses a transaction ID. Serialize it with track replacement
  // so viewport updates and compositor resizes cannot invalidate each other.
  function change(peer: Peer, apply: () => Promise<void>) {
    const next = peer.pending.then(() => {
      if (peer.pc.signalingState !== "closed") return apply();
    });
    peer.pending = next.catch(() => {});
    return next;
  }
  async function capture(
    options: Pick<VideoPeerOptions, "sourceId" | "width" | "height">,
  ): Promise<Source> {
    const width = Math.max(2, Math.floor(options.width / 2) * 2);
    const height = Math.max(2, Math.floor(options.height / 2) * 2);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: options.sourceId,
          minWidth: width,
          maxWidth: width,
          minHeight: height,
          maxHeight: height,
          maxFrameRate: 60,
        },
      } as unknown as MediaTrackConstraints,
    });
    stream.getVideoTracks()[0].contentHint = "detail";
    return { stream, width: options.width, height: options.height };
  }
  function release(source: string) {
    if ([...peers.values()].some((p) => p.source === source)) return;
    const pending = sources.get(source);
    sources.delete(source);
    void pending?.then((s) => s.stream.getTracks().forEach((t) => t.stop())).catch(() => {});
  }
  function close(id: string) {
    const peer = peers.get(id);
    if (!peer) return;
    peers.delete(id);
    peer.pc.close();
    release(peer.source);
  }
  async function parameters(peer: Peer, source: Source) {
    if (!peer.sender || peer.pc.signalingState === "closed") return;
    const settings = source.stream.getVideoTracks()[0].getSettings();
    let scale = Math.max(
      1,
      (settings.width || source.width) / (peer.viewport.width * peer.viewport.dpr),
      (settings.height || source.height) / (peer.viewport.height * peer.viewport.dpr),
    );
    // Chromium rounds scaled dimensions. Odd inputs can silently switch
    // hardware H.264 to software; a few fewer pixels keep both dimensions even.
    const w = settings.width || source.width,
      h = settings.height || source.height;
    const target = Math.floor(w / scale / 2) * 2;
    for (let width = target; width >= Math.max(2, target - 16); width -= 2) {
      const candidate = w / width;
      if (Math.round(h / candidate) % 2 === 0) {
        scale = candidate;
        break;
      }
    }
    const p = peer.sender.getParameters();
    if (!p.encodings.length) return;
    p.encodings[0].scaleResolutionDownBy = scale;
    p.encodings[0].active = true;
    p.encodings[0].maxFramerate = peer.maxFramerate;
    p.encodings[0].maxBitrate = peer.maxFramerate === 60 ? 8_000_000 : 4_000_000;
    p.degradationPreference = "maintain-resolution";
    await peer.sender.setParameters(p);
  }
  async function gather(pc: RTCPeerConnection) {
    if (pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Video connection timed out.")), 8000);
      const changed = () => {
        if (pc.signalingState === "closed") finish(new Error("Video ended."));
        else if (pc.iceGatheringState === "complete") finish();
      };
      function finish(error?: Error) {
        clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", changed);
        pc.removeEventListener("signalingstatechange", changed);
        if (error) reject(error);
        else resolve();
      }
      pc.addEventListener("icegatheringstatechange", changed);
      pc.addEventListener("signalingstatechange", changed);
      changed();
    });
  }
  async function open(options: VideoPeerOptions) {
    if (peers.has(options.id) || peers.size >= 8) throw new Error("Video is busy.");
    const peer: Peer = {
      pc: new RTCPeerConnection(options.configuration),
      source: options.source,
      viewport: options.viewport,
      maxFramerate: options.maxFramerate,
      pending: Promise.resolve(),
    };
    peers.set(options.id, peer);
    try {
      let pending = sources.get(options.source);
      if (!pending) {
        pending = capture(options);
        sources.set(options.source, pending);
      }
      const source = await pending;
      if (peers.get(options.id) !== peer) throw new Error("Video ended.");
      peer.sender = peer.pc.addTrack(source.stream.getVideoTracks()[0], source.stream);
      const codecs = RTCRtpSender.getCapabilities("video")?.codecs;
      // H.264 is hardware accelerated on several supported devices. Negotiate
      // other browser-supported codecs when it is unavailable; measure actual
      // acceleration through getStats rather than assuming it from the name.
      if (codecs)
        peer.pc
          .getTransceivers()[0]
          .setCodecPreferences(
            [...codecs].sort(
              (a, b) =>
                Number(b.mimeType.toLowerCase() === "video/h264") -
                Number(a.mimeType.toLowerCase() === "video/h264"),
            ),
          );
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await change(peer, () => parameters(peer, source));
      await gather(peer.pc);
      if (peers.get(options.id) !== peer) throw new Error("Video ended.");
      return peer.pc.localDescription!.sdp;
    } catch (error) {
      close(options.id);
      throw error;
    }
  }
  async function answer(id: string, sdp: string) {
    const peer = peers.get(id);
    if (!peer || peer.pc.signalingState !== "have-local-offer") throw new Error("Video ended.");
    await peer.pc.setRemoteDescription({ type: "answer", sdp });
    const source = await sources.get(peer.source);
    if (source && peers.get(id) === peer) await change(peer, () => parameters(peer, source));
  }
  async function viewport(id: string, value: VideoViewport) {
    const peer = peers.get(id);
    if (!peer) return;
    peer.viewport = value;
    const source = await sources.get(peer.source);
    if (source && peers.get(id) === peer && peer.pc.currentRemoteDescription)
      await change(peer, () => parameters(peer, source));
  }
  async function resize(
    options: Pick<VideoPeerOptions, "source" | "sourceId" | "width" | "height">,
  ) {
    const previous = sources.get(options.source);
    if (!previous) return;
    const old = await previous;
    if (old.width === options.width && old.height === options.height) return;
    // Chromium's tab-capture maximum dimensions cannot reliably grow after
    // applyConstraints. Replace only the source track, retaining every peer.
    // Tracks for the same tab share Chromium's capture device. Keeping the
    // previous track alive makes a larger request inherit its old pixel limit.
    // Retain the RTP senders, but release that device before reacquiring it.
    old.stream.getTracks().forEach((t) => t.stop());
    const next = capture(options);
    sources.set(options.source, next);
    try {
      const source = await next;
      if (sources.get(options.source) !== next) {
        source.stream.getTracks().forEach((t) => t.stop());
        return;
      }
      for (const [id, peer] of peers) {
        if (peer.source !== options.source || !peer.sender) continue;
        try {
          await change(peer, async () => {
            // Do not encode a new size with the previous scale during rotation.
            const p = peer.sender!.getParameters();
            if (p.encodings.length) {
              p.encodings[0].active = false;
              await peer.sender!.setParameters(p);
            }
            await peer.sender!.replaceTrack(source.stream.getVideoTracks()[0]);
            await parameters(peer, source);
          });
        } catch {
          close(id);
        }
      }
      release(options.source);
    } catch (error) {
      for (const [id, peer] of peers) if (peer.source === options.source) close(id);
      throw error;
    } finally {
      old.stream.getTracks().forEach((t) => t.stop());
    }
  }
  async function stats(id: string) {
    const peer = peers.get(id);
    if (!peer) return null;
    const values: RTCStats[] = [];
    (await peer.pc.getStats()).forEach((s) => values.push(s));
    return values.filter((s) =>
      ["outbound-rtp", "remote-inbound-rtp", "codec", "candidate-pair"].includes(s.type),
    );
  }
  return { open, answer, viewport, resize, close, stats };
}
