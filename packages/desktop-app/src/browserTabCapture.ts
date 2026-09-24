import { BrowserTabVideo, parseTabVideoRequest, type TabVideoSource } from "./browserTabVideo";
import { BrowserTabExplore, type ExplorePage, type ExploreViewport } from "./browserTabExplore";
import { randomUUID } from "node:crypto";
import type { NativeImage } from "electron";
import { parseBrowserTabInput, type BrowserTabInput } from "./browserTabInput";

type Source = { videoSource?: TabVideoSource; createExplore?: (viewport: ExploreViewport) => ExplorePage; ownerId: string; projectId: string; canControl?: boolean; dispatchInput?: (input: BrowserTabInput, current: () => boolean) => Promise<void>; contents: {
  isDestroyed(): boolean;
  getURL(): string;
  capturePage(): Promise<NativeImage>;
} };

/** A selected local tab, never a desktop/display picker or runtime grant. */
export class BrowserTabCapture {
  private readonly explore = new BrowserTabExplore();
  private selection: { id: string; source: Source } | null = null;
  private pending = false;
  private video: BrowserTabVideo | undefined;
  private controlId: string | null = null;
  private controlTimer: ReturnType<typeof setTimeout> | undefined;
  private inputQueue: Promise<void> = Promise.resolve();
  private queued = 0;
  constructor(private readonly source: () => Source | null, private readonly onControlChange: () => void = () => {}) {}
  get controlActive() { return this.controlId !== null; }
  revokeControl() {
    clearTimeout(this.controlTimer);
    if (this.controlId === null) return;
    this.controlId = null;
    this.onControlChange();
  }
  setControl(ownerId: string, captureId: string, grantId: string | null) {
    const selected = this.selection;
    if (!selected || selected.id !== captureId || !this.valid(selected, ownerId)) throw new Error("Tab sharing ended.");
    if (grantId === null) { this.revokeControl(); return; }
    if (!/^[0-9a-f-]{36}$/i.test(grantId) || !this.source()?.canControl || !selected.source.dispatchInput) throw new Error("Pause agent control before granting tab control.");
    if (this.controlId && this.controlId !== grantId) throw new Error("Take back control before granting it again.");
    this.controlId = grantId;
    this.renewControl(ownerId,captureId,grantId);
    this.onControlChange();
  }
  renewControl(ownerId: string, captureId: string, grantId: string): boolean {
    const selected=this.selection;
    if (!selected || selected.id!==captureId || this.controlId!==grantId || !this.valid(selected,ownerId) || !this.source()?.canControl) return false;
    clearTimeout(this.controlTimer);
    this.controlTimer=setTimeout(()=>this.revokeControl(),4000);
    this.controlTimer.unref?.();
    return true;
  }
  async input(ownerId: string, captureId: string, grantId: string, raw: unknown): Promise<void> {
    const input=parseBrowserTabInput(raw), selected=this.selection;
    const current=()=>Boolean(selected && selected.id===captureId && this.controlId===grantId && this.valid(selected,ownerId) && this.source()?.canControl);
    if (!current() || !selected?.source.dispatchInput) throw new Error("Tab control ended.");
    if (this.queued>=32) throw new Error("Tab input is busy.");
    this.queued++;
    const operation=this.inputQueue.then(async()=>{
      if (!current()) throw new Error("Tab control ended.");
      await selected.source.dispatchInput!(input,current);
    });
    this.inputQueue=operation.catch(()=>{});
    try { await operation; } finally { this.queued--; }
  }
  private exploreSelection(ownerId: string, captureId: string) {
    const selected = this.selection;
    if (!selected || selected.id !== captureId || !this.valid(selected, ownerId)) throw new Error("Tab sharing ended.");
    return selected;
  }
  openExplore(ownerId: string, captureId: string, viewport: unknown) {
    const selected = this.exploreSelection(ownerId, captureId);
    if (!selected.source.createExplore) throw new Error("Explore is unavailable.");
    return { viewId: this.explore.open(selected.source.createExplore, () => this.valid(selected, ownerId), viewport) };
  }
  operateExplore(ownerId: string, captureId: string, viewId: string, operation: "renew" | "frame" | "input" | "resize" | "navigate" | "close", value?: unknown) {
    this.exploreSelection(ownerId, captureId);
    if (operation === "renew") return this.explore.renew(viewId);
    if (operation === "frame") return this.explore.frame(viewId);
    if (operation === "input") return this.explore.input(viewId, value);
    if (operation === "resize") return this.explore.resize(viewId, value);
    if (operation === "navigate") return this.explore.navigate(viewId, value);
    return this.explore.close(viewId);
  }
  async videoOperation(ownerId: string, captureId: string, operation: "open" | "answer" | "sync" | "viewport" | "close" | "stats", value: unknown) {
    const selected=this.exploreSelection(ownerId,captureId);
    if (operation === "open") {
      const request=parseTabVideoRequest(value);
      const source=request.viewId ? this.explore.videoSource(request.viewId) : selected.source.videoSource;
      if (!source) throw new Error("Tab video unavailable.");
      this.video ??= new BrowserTabVideo();
      return this.video.open(request,{contents:source.contents,current:()=>this.valid(selected,ownerId) && source.current(),media:requester=>source.media(requester)});
    }
    if (operation === "sync") {this.video?.sync(value);return;}
    const message=value as {id:string;sdp:string;viewport:Parameters<BrowserTabVideo["viewport"]>[1]};
    if (!message || typeof message.id!=="string") throw new Error("Invalid video operation.");
    if (operation === "answer") return this.video?.answer(message.id,message.sdp);
    if (operation === "viewport") return this.video?.viewport(message.id,message.viewport);
    if (operation === "stats") return this.video?.stats(message.id);
    this.video?.close(message.id);
  }
  allowsVideoCapture(...args: Parameters<BrowserTabVideo["allowsCapturePermission"]>) {
    return this.video?.allowsCapturePermission(...args) ?? false;
  }
  get active() { return this.selection !== null; }

  start(ownerId: string): { captureId: string } {
    const source = this.source();
    if (!source || source.ownerId !== ownerId || !this.webPage(source)) throw new Error("Open a web page in your browser before sharing.");
    if (this.selection) throw new Error("This tab is already being shared.");
    this.selection = { id: randomUUID(), source };
    return { captureId: this.selection.id };
  }
  stop(captureId?: string) {
    if (!captureId || this.selection?.id === captureId) { this.revokeControl(); this.video?.dispose(); this.video=undefined; this.explore.closeAll(); this.selection = null; }
  }
  private webPage(source: Source) {
    return !source.contents.isDestroyed() && /^https?:\/\//i.test(source.contents.getURL());
  }
  private valid(selection: NonNullable<BrowserTabCapture["selection"]>, ownerId: string) {
    const current = this.source();
    return this.selection === selection && current?.ownerId === ownerId &&
      current.projectId === selection.source.projectId && current.contents === selection.source.contents && this.webPage(current);
  }
  async frame(ownerId: string, captureId: string): Promise<Uint8Array> {
    const selected = this.selection;
    if (!selected || selected.id !== captureId || !this.valid(selected, ownerId)) throw new Error("Tab sharing ended.");
    if (this.pending) throw new Error("A tab capture is already pending.");
    this.pending = true;
    try {
      let image = await selected.source.contents.capturePage();
      // Revoke even an in-flight capture on Stop, account/project change or close.
      if (!this.valid(selected, ownerId)) throw new Error("Tab sharing ended.");
      const { width, height } = image.getSize();
      if (!width || !height) throw new Error("The shared tab is not visible.");
      const scale = Math.min(1, 1600 / width, 1200 / height);
      if (scale < 1) image = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: "good" });
      const jpeg = image.toJPEG(80);
      if (jpeg.length > 1024 * 1024) throw new Error("The tab frame is too large.");
      return jpeg;
    } finally { this.pending = false; }
  }
}
