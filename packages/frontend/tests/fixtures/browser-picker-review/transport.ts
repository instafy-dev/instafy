/** Inert transport: production parsing, frame decoding and controls stay mounted. */
export const share = { id: "review-share", projectId: "review-project", ownerUserId: "review-owner", audience: "space", mode: "view" } as const;
const params = new URLSearchParams(location.search);
const initial = params.get("state") ?? "live";
class ReviewSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  frameFlowVersion = 1;
  send(value: string) { review.commands.push(JSON.parse(value)); }
  close() { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
  json(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
}
function pageFrame(): ArrayBuffer {
  const canvas = document.createElement("canvas"); canvas.width = 1000; canvas.height = 650;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#f7f6f3"; context.fillRect(0, 0, 1000, 650);
  context.fillStyle = "#31556a"; context.fillRect(0, 0, 1000, 95);
  context.fillStyle = "white"; context.font = "600 26px system-ui"; context.fillText("FIELDNOTES", 48, 60);
  context.fillStyle = "#202b31"; context.font = "600 42px system-ui"; context.fillText("A calmer place to work", 48, 180);
  context.font = "23px system-ui"; context.fillText("Plan the next release together.", 48, 224);
  for (let index = 0; index < 3; index++) {
    const x = 48 + index * 308;
    context.fillStyle = ["#d6e3d8", "#e6dfd2", "#dbe3eb"][index]!; context.fillRect(x, 280, 280, 220);
    context.fillStyle = "#29363b"; context.font = "600 25px system-ui"; context.fillText(["Research", "Design", "Review"][index]!, x + 24, 330);
    context.fillStyle = "#677779"; context.font = "19px system-ui"; context.fillText("Notes and next steps", x + 24, 370);
  }
  const bytes = atob(canvas.toDataURL("image/jpeg", 0.88).split(",")[1]!);
  return Uint8Array.from(bytes, value => value.charCodeAt(0)).buffer;
}
let pending: (() => void) | null = null;
export const review = {
  attempts: 0, listCalls: 0, commands: [] as Array<Record<string, unknown>>, sockets: [] as ReviewSocket[], ended: false,
  connect: async (_id: string, _role: string, signal: AbortSignal) => {
    review.attempts++;
    const attempt = review.attempts;
    if (attempt === 1 && (initial === "error" || initial === "reconnecting")) throw new Error("Synthetic connection failure");
    if (initial === "connecting" || attempt > 1 && initial === "reconnecting") await new Promise<void>(resolve => { pending = resolve; });
    const socket = new ReviewSocket(); review.sockets.push(socket);
    signal.addEventListener("abort", () => socket.close(), { once: true });
    if (!signal.aborted) window.setTimeout(() => {
      if (attempt === 1 && initial === "closed") socket.close();
      else review.frame();
    }, 80);
    return socket;
  },
  list: async () => { review.listCalls++; return review.ended ? [] : [share]; },
  resume: () => { pending?.(); pending = null; },
  disconnect: () => review.sockets.at(-1)?.close(),
  frame: () => {
    const socket = review.sockets.at(-1);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.json({ type: "controlState", available: true, connectionId: "review-self", requested: false, grant: null });
    socket.json({ type: "exploreState", available: true, requested: false, view: null });
    socket.dispatchEvent(new MessageEvent("message", { data: pageFrame() }));
  },
};
declare global { interface Window { __browserPickerReview: typeof review } }
window.__browserPickerReview = review;
