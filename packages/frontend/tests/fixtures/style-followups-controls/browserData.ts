/** Inert transport only: production UI, parsers, controls and keyboard remain intact. */
const viewId = "12345678-1234-4123-8123-123456789012";
const share = { id: "review-tab", projectId: "review-project", ownerUserId: "owner", audience: "space", mode: "view" } as const;
const query = new URLSearchParams(location.search);
const initialState = query.get("state") ?? "following";
let latest: ReviewSocket | null = null;
let disconnectedOnce = false;

function announce(message: string) {
  window.dispatchEvent(new CustomEvent("style-review-action", { detail: message }));
}
class ReviewSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  requested = initialState === "requested";
  owns = initialState === "control";
  exploring = initialState === "exploring";
  exploreRequested = initialState === "browse-requested";
  timer?: number;
  constructor() {
    super();
    this.timer = window.setTimeout(() => {
      if (initialState === "disconnected" && !disconnectedOnce) { disconnectedOnce = true; this.disconnect(); }
      else { this.publish(); void this.frame(); this.timer = window.setInterval(() => void this.frame(), 3000); }
    }, 100);
  }
  emit(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  publish() {
    this.emit({ type: "controlState", available: true, connectionId: "review-self", requested: this.requested,
      grant: this.owns ? { id: "review-grant", connectionId: "review-self", userId: "review-person" } : null });
    this.emit({ type: "exploreState", available: true, requested: this.exploreRequested,
      view: this.exploring ? { viewId, connectionId: "review-self", userId: "review-person", viewport: { width: 960, height: 600, dpr: 1 } } : null });
  }
  async frame() {
    if (this.readyState !== WebSocket.OPEN) return;
    const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 600;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f7f8fa"; context.fillRect(0, 0, 960, 600);
    context.fillStyle = "#ffffff"; context.fillRect(50, 45, 860, 510);
    context.fillStyle = "#1b2533"; context.font = "28px sans-serif";
    context.fillText("Shared browser page", 90, 110);
    context.font = "18px sans-serif"; context.fillStyle = "#536170";
    context.fillText(this.exploring ? "Your independent view" : "Following the owner's page", 90, 155);
    context.fillText("Local image fixture — no external page or account", 90, 195);
    context.fillStyle = "#e4e9ee";
    for (let i = 0; i < 4; i++) context.fillRect(90, 245 + i * 48, 650 - i * 70, 20);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), "image/jpeg"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (this.readyState !== WebSocket.OPEN) return;
    if (this.exploring) {
      const packet = new Uint8Array(40 + bytes.length); packet.set(new TextEncoder().encode("IEX1" + viewId)); packet.set(bytes, 40);
      this.dispatchEvent(new MessageEvent("message", { data: packet.buffer }));
    } else this.dispatchEvent(new MessageEvent("message", { data: bytes.buffer }));
  }
  send(raw: string) {
    const event = JSON.parse(raw);
    if (["frameAck", "exploreResize"].includes(event.type)) return;
    announce(event.type);
    if (event.type === "requestControl") this.requested = true;
    if (event.type === "releaseControl") { this.owns = false; this.requested = false; }
    if (event.type === "exploreRequest") this.exploreRequested = true;
    if (event.type === "exploreReturn") { this.exploring = false; this.exploreRequested = false; }
    this.publish(); void this.frame();
  }
  approve() { this.owns = true; this.requested = false; this.publish(); }
  approveBrowse() { this.exploring = true; this.exploreRequested = false; this.publish(); void this.frame(); }
  disconnect() { this.close(); this.dispatchEvent(new Event("close")); }
  close() { this.readyState = WebSocket.CLOSED; window.clearTimeout(this.timer); window.clearInterval(this.timer); }
}
export async function browserShareClient() {
  return { list: async () => [share], connect: async (_id: string, _mode: string, signal: AbortSignal) => {
    latest = new ReviewSocket(); const socket = latest; signal.addEventListener("abort", () => socket.close(), { once: true }); return socket;
  } };
}
export function grantControl() { latest?.approve(); }
export function grantBrowse() { latest?.approveBrowse(); }
export { share };
