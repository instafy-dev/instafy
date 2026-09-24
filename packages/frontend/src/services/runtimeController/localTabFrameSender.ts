export type LocalTabSocket = WebSocket & { frameFlowVersion?: 1 };

/** One frame on the wire; retain only the latest waiting image of each view. */
export function localTabFrameSender(socket: LocalTabSocket) {
  const waiting = new Map<string, Uint8Array>();
  let pending = false;
  let disposed = false;
  let timeout: number | undefined;
  function flush() {
    if (disposed || pending || socket.readyState !== WebSocket.OPEN) return;
    const next = waiting.entries().next().value;
    if (!next) return;
    const [view, bytes] = next;
    waiting.delete(view);
    pending = socket.frameFlowVersion === 1;
    if (pending) timeout = window.setTimeout(() => socket.close(), 5000);
    socket.send(bytes);
  }
  function received(event: MessageEvent) {
    if (event.data !== '{"type":"frameAck"}' || !pending) return;
    window.clearTimeout(timeout);
    pending = false;
    flush();
  }
  socket.addEventListener("message", received);
  return {
    offer(view: string, bytes: Uint8Array) {
      if (disposed) return;
      // Updating a Map entry preserves its place, so a busy view cannot starve
      // other participants while an earlier image is travelling to the relay.
      waiting.set(view, bytes);
      flush();
    },
    remove(view: string) { waiting.delete(view); },
    dispose() {
      disposed = true;
      waiting.clear();
      window.clearTimeout(timeout);
      socket.removeEventListener("message", received);
    },
  };
}
