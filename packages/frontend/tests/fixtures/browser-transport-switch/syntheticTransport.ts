/** Synthetic pixel transport/native bridge. This does not launch Electron or a remote browser. */
import { useEffect, useState } from "react";
type Bounds = { x: number; y: number; width: number; height: number; visible: boolean; occluded?: boolean; ownerId?: string };
type BridgeEvent = Bounds & { at: number };

function paintPage(canvas: HTMLCanvasElement, label: string) {
  const context = canvas.getContext("2d")!;
  const { width, height } = canvas;
  context.fillStyle = "#f1f5f9";
  context.fillRect(0, 0, width, height);
  context.fillStyle = label === "Workspace" ? "#174e67" : "#5c407c";
  context.fillRect(0, 0, width, 132);
  context.fillStyle = "#fff";
  context.font = "bold 26px system-ui";
  context.fillText(`${label} browser`, 24, 57);
  context.font = "16px system-ui";
  context.fillText("Project notes · Synthetic review page", 24, 94);
  const columns = width < 650 ? 1 : 3;
  const cardWidth = (width - 32 - (columns - 1) * 16) / columns;
  for (let index = 0; index < 3; index += 1) {
    const x = 16 + (index % columns) * (cardWidth + 16);
    const y = 156 + Math.floor(index / columns) * 180;
    context.fillStyle = "#fff";
    context.fillRect(x, y, cardWidth, 160);
    context.fillStyle = ["#c7e9ed", "#e6dbf7", "#f7e4bd"][index]!;
    context.fillRect(x + 14, y + 14, 64, 64);
    context.fillStyle = "#293b4b";
    context.font = "bold 18px system-ui";
    context.fillText(["Research", "Design", "Next steps"][index]!, x + 92, y + 42);
    context.fillStyle = "#9ba9b4";
    for (let line = 0; line < 3; line += 1) context.fillRect(x + 14, y + 95 + line * 18, cardWidth - 35 - line * 35, 6);
  }
  canvas.dataset.painted = "true";
}

class SyntheticRFB extends EventTarget {
  // The production resize adapter expects these noVNC capabilities on HiDPI
  // displays. Pixel dimensions stay fixed because this is an inert transport.
  static messages = { setDesktopSize: () => {} };
  canvas = document.createElement("canvas");
  get _canvas() { return this.canvas; }
  _screenSize = () => ({ w: this.canvas.clientWidth, h: this.canvas.clientHeight });
  _FBU = { encoding: 0 };
  disconnected = false;
  url: string;
  flushPromise: Promise<void> | null = null;
  _display = { flush: () => {
    this.flushPromise ??= new Promise<void>(resolve => window.setTimeout(() => {
      if (!this.disconnected) paintPage(this.canvas, "Workspace");
      resolve();
    }, 40));
    return this.flushPromise;
  } };
  constructor(container: HTMLDivElement, url: string) {
    super();
    this.url = url;
    this.canvas.width = Math.max(1, container.clientWidth);
    this.canvas.height = Math.max(1, container.clientHeight);
    this.canvas.style.cssText = "width:100%;height:100%;object-fit:contain;background:black";
    this.canvas.dataset.testid = "synthetic-rfb-canvas";
    this.canvas.getContext("2d")!.fillRect(0, 0, this.canvas.width, this.canvas.height);
    container.append(this.canvas);
    review.connections.push(this);
    window.setTimeout(() => {
      if (!this.disconnected) {
        this.canvas.dataset.connected = "true";
        this.dispatchEvent(new Event("connect"));
      }
    }, 10);
    if (!new URLSearchParams(location.search).has("manual")) window.setTimeout(() => this.paint(), 700);
  }
  _handleRect() { return true; }
  _framebufferUpdate() { this._handleRect(); void this._display.flush(); return true; }
  paint() { if (!this.disconnected) this._framebufferUpdate(); }
  disconnect() { this.disconnected = true; this.canvas.remove(); }
}

const nativePage = document.createElement("canvas");
nativePage.width = 1000;
nativePage.height = 660;
paintPage(nativePage, "This device");
nativePage.dataset.testid = "synthetic-native-page";
nativePage.style.cssText = "display:none;position:fixed;z-index:20;pointer-events:none;object-fit:contain;background:#f1f5f9";
document.body.append(nativePage);

export const review = {
  RFB: SyntheticRFB,
  hooks: { useEffect, useState },
  rosterState: "idle",
  cdpMounts: 0,
  connections: [] as SyntheticRFB[],
  bounds: [] as BridgeEvent[],
  holdBridgeReplies: false,
  pendingBridgeReplies: [] as Array<() => void>,
  releaseBridgeReplies: () => { review.holdBridgeReplies = false; review.pendingBridgeReplies.splice(0).forEach(resolve => resolve()); },
  mode: "shared",
  paint: () => review.connections.at(-1)?.paint(),
};

declare global { interface Window { __browserSwitchReview: typeof review } }
window.__browserSwitchReview = review;
let nativeOccluded = false;
window.instafyDesktop = {
  personalBrowserSetBounds: async (bounds: Bounds) => {
    const capturePreview = Boolean(bounds.visible && bounds.occluded && !nativeOccluded);
    nativeOccluded = Boolean(bounds.visible && bounds.occluded);
    review.bounds.push({ ...bounds, at: performance.now() });
    if (bounds.width > 1 && bounds.height > 1 && (nativePage.width !== bounds.width || nativePage.height !== bounds.height)) {
      nativePage.width = bounds.width;
      nativePage.height = bounds.height;
      paintPage(nativePage, "This device");
    }
    Object.assign(nativePage.style, {
      display: bounds.visible && !bounds.occluded ? "block" : "none",
      left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
    });
    // The native host captures only when entering occlusion. Later geometry
    // reports do not produce a replacement preview for the same open menu.
    const previewDataUrl = capturePreview ? nativePage.toDataURL() : undefined;
    await new Promise<void>(resolve => {
      if (review.holdBridgeReplies) review.pendingBridgeReplies.push(resolve);
      else window.setTimeout(resolve, 80);
    });
    return { success: true, ownerId: "review-owner", url: "https://notes.example.test", state: "ready", previewDataUrl };
  },
} as typeof window.instafyDesktop;
