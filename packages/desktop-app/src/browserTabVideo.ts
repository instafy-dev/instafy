import { BrowserWindow, session, type WebContents } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  installBrowserTabVideoWorker,
  type VideoPeerOptions,
  type VideoViewport,
} from "./browserTabVideoWorker";

export type TabVideoSource = {
  contents: WebContents;
  current(): boolean;
  media(requester: WebContents): Promise<{ sourceId: string; width: number; height: number }>;
};
type Peer = {
  viewId: string | null;
  source: TabVideoSource;
  expires: number;
  viewport: VideoViewport;
  opened: boolean;
};
export type TabVideoRequest = {
  id: string;
  viewId: string | null;
  viewport: VideoViewport;
  configuration: RTCConfiguration;
  maxFramerate?: 30 | 60;
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function parseTabVideoRequest(raw: unknown): TabVideoRequest {
  const p = raw as TabVideoRequest;
  if (
    !p ||
    !uuid(p.id) ||
    !(p.viewId === null || uuid(p.viewId)) ||
    !p.viewport ||
    !Number.isInteger(p.viewport.width) ||
    p.viewport.width < 240 ||
    p.viewport.width > 1920 ||
    !Number.isInteger(p.viewport.height) ||
    p.viewport.height < 160 ||
    p.viewport.height > 1440 ||
    !Number.isFinite(p.viewport.dpr) ||
    p.viewport.dpr < 1 ||
    p.viewport.dpr > 3 ||
    !p.configuration ||
    !["all", "relay"].includes(p.configuration.iceTransportPolicy || "") ||
    !Array.isArray(p.configuration.iceServers) ||
    p.configuration.iceServers.length > 4 ||
    (p.maxFramerate !== undefined && p.maxFramerate !== 30 && p.maxFramerate !== 60)
  )
    throw new Error("Invalid tab video request.");
  for (const server of p.configuration.iceServers) {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    if (
      !Array.isArray(urls) ||
      !urls.length ||
      urls.length > 4 ||
      urls.some(
        (url) =>
          typeof url !== "string" ||
          url.length > 2048 ||
          !/^turns?:[^\s/@]+(?::\d+)?(?:\?transport=(?:udp|tcp))?$/.test(url),
      ) ||
      (server.username !== undefined &&
        (typeof server.username !== "string" || server.username.length > 256)) ||
      (server.credential !== undefined &&
        (typeof server.credential !== "string" || server.credential.length > 4096))
    )
      throw new Error("Invalid tab video relay.");
  }
  return {
    id: p.id,
    viewId: p.viewId,
    viewport: p.viewport,
    configuration: {
      iceServers: p.configuration.iceServers.map((s) => ({
        urls: s.urls,
        username: s.username,
        credential: s.credential,
      })),
      iceTransportPolicy: p.configuration.iceTransportPolicy,
    },
    maxFramerate: p.maxFramerate ?? 30,
  };
}

/** Main owns the worker and leases: a disconnected Studio cannot keep streaming. */
export class BrowserTabVideo {
  private window: BrowserWindow | undefined;
  private ready: Promise<void> | undefined;
  private peers = new Map<string, Peer>();
  private resizing = new Set<string>();
  private timer = setInterval(() => {
    for (const [id, p] of this.peers)
      if (p.expires <= Date.now() || !p.source.current()) this.close(id);
  }, 250);
  private disposed = false;
  constructor() {
    this.timer.unref();
  }
  allowsCapturePermission(
    contents: WebContents,
    permission: string,
    details: { securityOrigin?: string; mediaTypes?: string[]; isMainFrame?: boolean },
  ) {
    // Electron checks tab-capture permission on the captured tab's session,
    // while reporting the requesting worker's origin. The opaque source ID
    // is already restricted to that exact worker by getMediaSourceId(worker).
    // Empty mediaTypes identifies tab capture, never a camera or microphone.
    return (
      !this.disposed &&
      Boolean(this.window && !this.window.isDestroyed()) &&
      permission === "media" &&
      details.securityOrigin === "file:///" &&
      details.isMainFrame === true &&
      Array.isArray(details.mediaTypes) &&
      details.mediaTypes.length === 0 &&
      [...this.peers.values()].some((p) => p.source.contents === contents && p.source.current())
    );
  }
  private async worker() {
    if (this.disposed) throw new Error("Video ended.");
    if (!this.window) {
      const ownSession = session.fromPartition(`instafy-tab-video-${randomUUID()}`);
      const win = new BrowserWindow({
        show: false,
        focusable: false,
        webPreferences: {
          session: ownSession,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          devTools: false,
        },
      });
      this.window = win;
      ownSession.setPermissionCheckHandler(
        (contents, permission) => contents === win.webContents && permission === "media",
      );
      ownSession.setPermissionRequestHandler((contents, permission, callback) =>
        callback(contents === win.webContents && permission === "media"),
      );
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.webContents.on("will-attach-webview", (event) => event.preventDefault());
      win.webContents.on("render-process-gone", () => {
        if (this.window === win) this.reset();
      });
      this.ready = win
        .loadFile(path.join(__dirname, "../assets/browser-tab-video.html"))
        .then(() =>
          win.webContents.executeJavaScript(
            `globalThis.instafyTabVideoWorker=(${installBrowserTabVideoWorker.toString()})();void 0`,
          ),
        )
        .then(() => {})
        .catch((error) => {
          if (this.window === win) this.reset();
          throw error;
        });
    }
    const win = this.window;
    await this.ready;
    if (this.disposed || this.window !== win || win.isDestroyed()) throw new Error("Video ended.");
    return win.webContents;
  }
  private async call(
    method: "open" | "answer" | "viewport" | "resize" | "close" | "stats",
    ...args: unknown[]
  ) {
    const contents = await this.worker();
    // DOMException loses its message at Electron's serialization boundary.
    const result = await contents.executeJavaScript(
      `Promise.resolve().then(()=>globalThis.instafyTabVideoWorker.${method}(...${JSON.stringify(args)})).then(value=>({ok:true,value}),error=>({ok:false,error:String(error?.message || "Tab video unavailable.")}))`,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  async open(request: TabVideoRequest, source: TabVideoSource): Promise<string> {
    if (this.disposed || this.peers.size >= 8 || this.peers.has(request.id) || !source.current())
      throw new Error("Video unavailable.");
    const peer: Peer = {
      viewId: request.viewId,
      source,
      expires: Date.now() + 4000,
      viewport: request.viewport,
      opened: false,
    };
    this.peers.set(request.id, peer);
    try {
      const contents = await this.worker();
      const media = await source.media(contents);
      if (this.peers.get(request.id) !== peer || !source.current()) throw new Error("Video ended.");
      const options: VideoPeerOptions = {
        ...request,
        ...media,
        source: request.viewId ?? "follow",
        maxFramerate: request.maxFramerate ?? 30,
      };
      const sdp: unknown = await this.call("open", options);
      if (this.peers.get(request.id) !== peer || !source.current()) throw new Error("Video ended.");
      if (typeof sdp !== "string" || sdp.length > 32768)
        throw new Error("Video negotiation is too large.");
      // A viewport update may arrive while capture/ICE is still opening.
      await this.call("viewport", request.id, peer.viewport);
      peer.opened = true;
      return sdp;
    } catch (error) {
      this.close(request.id);
      throw error;
    }
  }
  async answer(id: string, sdp: string) {
    const peer = this.peers.get(id);
    if (
      !peer ||
      !peer.source.current() ||
      typeof sdp !== "string" ||
      sdp.length > 32768 ||
      !sdp.startsWith("v=0")
    )
      throw new Error("Video ended.");
    await this.call("answer", id, sdp);
  }
  sync(raw: unknown) {
    if (!Array.isArray(raw) || raw.length > 8) throw new Error("Invalid video leases.");
    for (const [id, peer] of this.peers) {
      if (
        !raw.some((p) => p && p.id === id && p.viewId === peer.viewId) ||
        !peer.source.current()
      ) {
        this.close(id);
        continue;
      }
      peer.expires = Date.now() + 4000;
      if (!peer.opened) continue;
      const key = peer.viewId ?? "follow";
      if (!this.resizing.has(key)) {
        this.resizing.add(key);
        void this.worker()
          .then((contents) => peer.source.media(contents))
          .then((media) => {
            if (this.peers.get(id) === peer && peer.source.current())
              return this.call("resize", { source: key, ...media });
          })
          .catch(() => {
            for (const [failedId, p] of this.peers)
              if ((p.viewId ?? "follow") === key) this.close(failedId);
          })
          .finally(() => this.resizing.delete(key));
      }
    }
  }
  async viewport(id: string, viewport: VideoViewport) {
    const peer = this.peers.get(id);
    if (peer && peer.source.current()) {
      parseTabVideoRequest({
        id,
        viewId: peer.viewId,
        viewport,
        configuration: { iceServers: [], iceTransportPolicy: "all" },
      });
      peer.viewport = viewport;
      await this.call("viewport", id, viewport);
    }
  }
  close(id: string) {
    if (!this.peers.delete(id)) return;
    if (!this.peers.size) {
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
      this.window = undefined;
      this.ready = undefined;
    } else if (this.window && !this.window.isDestroyed())
      void this.call("close", id).catch(() => {});
  }
  stats(id: string) {
    return this.peers.has(id) ? this.call("stats", id) : Promise.resolve(null);
  }
  private reset() {
    this.peers.clear();
    const win = this.window;
    this.window = undefined;
    this.ready = undefined;
    if (win && !win.isDestroyed()) win.destroy();
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.reset();
  }
}
