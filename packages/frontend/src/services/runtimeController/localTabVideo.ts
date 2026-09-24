import type { LocalExploreViewport } from "./localTabExplore";
export type LocalVideoPeer = {
  id: string;
  connectionId: string;
  viewId: string | null;
  viewport: LocalExploreViewport;
  configuration: RTCConfiguration;
  offer: string | null;
  answer: string | null;
  playing: boolean;
};
export type LocalVideoState = {
  type: "videoState";
  available: boolean;
  needsFollowFrames: boolean;
  peers: LocalVideoPeer[];
};
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function readLocalVideoState(value: unknown): LocalVideoState | null {
  const v = value as LocalVideoState;
  if (
    !v ||
    v.type !== "videoState" ||
    typeof v.available !== "boolean" ||
    typeof v.needsFollowFrames !== "boolean" ||
    !Array.isArray(v.peers) ||
    v.peers.length > 8
  )
    return null;
  if (
    v.peers.some(
      (p) =>
        !p ||
        !uuid(p.id) ||
        !uuid(p.connectionId) ||
        !(p.viewId === null || uuid(p.viewId)) ||
        !p.viewport ||
        !Number.isFinite(p.viewport.width) ||
        !Number.isFinite(p.viewport.height) ||
        !Number.isFinite(p.viewport.dpr) ||
        !p.configuration ||
        !Array.isArray(p.configuration.iceServers) ||
        !["all", "relay"].includes(p.configuration.iceTransportPolicy || "") ||
        ![p.offer, p.answer].every(
          (s) => s === null || (typeof s === "string" && s.length <= 32768),
        ) ||
        typeof p.playing !== "boolean",
    )
  )
    return null;
  return v;
}
export async function gatherLocalVideoIce(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error("Video connection timed out.")), 8000);
    const changed = () => {
      if (pc.signalingState === "closed") finish(new Error("Video ended."));
      else if (pc.iceGatheringState === "complete") finish();
    };
    function finish(error?: Error) {
      window.clearTimeout(timer);
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
