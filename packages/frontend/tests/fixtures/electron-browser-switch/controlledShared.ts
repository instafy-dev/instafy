/** Controlled Shared pixels only. Personal uses the unmodified Electron preload and native host. */
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
  context.fillText("Controlled Shared pixel transport", 24, 94);
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

class ControlledSharedRFB extends EventTarget {
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
      if (!this.disconnected) {
        // Electron creates its default-sized window before the test resizes it.
        // Paint the current viewport, like a fresh server resize frame, rather
        // than freezing stale startup dimensions into the reconnect preview.
        this.canvas.width = Math.max(1, this.canvas.parentElement?.clientWidth ?? this.canvas.width);
        this.canvas.height = Math.max(1, this.canvas.parentElement?.clientHeight ?? this.canvas.height);
        paintPage(this.canvas, "Workspace");
      }
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
    nativeSwitch.connections.push(this);
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

export const nativeSwitch = {
  RFB: ControlledSharedRFB,
  connections: [] as ControlledSharedRFB[],
  paint: () => nativeSwitch.connections.at(-1)?.paint(),
};
declare global { interface Window { __nativeBrowserSwitchReview: typeof nativeSwitch } }
window.__nativeBrowserSwitchReview = nativeSwitch;
