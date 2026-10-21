// Server-sent events: every connected viewer gets every event. A ring buffer (200 events, 2 MB) serves
// Last-Event-ID replay after a reconnect; a comment ping every 15 s keeps proxies from closing the stream.
//
// A stream also ends on its own after MAX_STREAM_MS. Whatever authenticates the viewer in front of the binder (the
// preview broker's forwardAuth, a proxy) decides once per request, so a stream that never ended would keep
// delivering after the viewer's access was revoked. EventSource reconnects by itself (retry: 2000) and the ring
// replays from Last-Event-ID, so a viewer sees no gap; the reconnect simply passes that check again.

export const RING_SIZE = 200;
export const RING_BYTES = 2 * 1024 * 1024;
export const PING_MS = 15_000;
/** Open streams per site; more are refused with 503 so one token holder cannot pin the binder's sockets. */
export const MAX_CLIENTS = 50;
/**
 * Open streams per source (one address behind the preview tunnel or a proxy), so one viewer cannot take every slot.
 * Past it that source's new stream is refused like a full hub; the bind client then falls back to polling.
 */
export const MAX_PER_SOURCE = 8;
/** How long one stream lives before the client reconnects (and is checked again). */
export const MAX_STREAM_MS = 60_000;

export class EventHub {
  constructor({
    ringSize = RING_SIZE, ringBytes = RING_BYTES, pingMs = PING_MS, maxClients = MAX_CLIENTS, maxPerSource = MAX_PER_SOURCE,
    maxStreamMs = MAX_STREAM_MS,
  } = {}) {
    this.ringSize = ringSize;
    this.ringBytes = ringBytes;
    this.ringUsed = 0;
    this.maxClients = maxClients;
    this.maxPerSource = maxPerSource;
    this.maxStreamMs = maxStreamMs;
    this.ring = [];
    this.nextId = 1;
    this.clients = new Set();
    /** source -> open responses, oldest first */
    this.bySource = new Map();
    this.ping = setInterval(() => {
      for (const res of this.clients) res.write(": ping\n\n");
    }, pingMs);
    this.ping.unref?.();
  }

  get size() {
    return this.clients.size;
  }

  /**
   * Attach a response as an SSE stream. `hello` is sent first and never buffered. `source` identifies who opened it
   * (see sourceOf in server.mjs; null = not limited per source); one source holds at most maxPerSource streams.
   * Returns null when full.
   */
  attach(req, res, { hello = null, lastEventId = null, source = null } = {}) {
    const own = source == null ? 0 : this.bySource.get(source)?.length || 0;
    if (this.clients.size >= this.maxClients || own >= this.maxPerSource) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "10", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, reason: "too many viewers" }));
      return null;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    if (hello) res.write(`event: ${hello.type}\ndata: ${JSON.stringify(hello)}\n\n`);
    const last = Number(lastEventId ?? req.headers["last-event-id"]);
    if (Number.isFinite(last) && last > 0) {
      for (const entry of this.ring) if (entry.id > last) res.write(entry.frame);
    }
    this.clients.add(res);
    if (source != null) {
      if (!this.bySource.has(source)) this.bySource.set(source, []);
      this.bySource.get(source).push(res);
    }
    const timer = this.maxStreamMs > 0 ? setTimeout(() => res.end(), this.maxStreamMs) : null;
    timer?.unref?.();
    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      if (timer) clearTimeout(timer);
      this.clients.delete(res);
      const list = source == null ? null : this.bySource.get(source);
      if (list) {
        const i = list.indexOf(res);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this.bySource.delete(source);
      }
    };
    req.on("close", drop);
    res.on("close", drop);
    res.on("finish", drop);
    res.on("error", drop);
    return drop;
  }

  /** Broadcast a host message; its `type` is the SSE event name. Returns the event id. */
  broadcast(message) {
    const id = this.nextId++;
    const frame = `id: ${id}\nevent: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
    const bytes = Buffer.byteLength(frame);
    this.ring.push({ id, frame, bytes });
    this.ringUsed += bytes;
    while (this.ring.length > 1 && (this.ring.length > this.ringSize || this.ringUsed > this.ringBytes)) {
      this.ringUsed -= this.ring.shift().bytes;
    }
    for (const res of this.clients) res.write(frame);
    return id;
  }

  close() {
    clearInterval(this.ping);
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.bySource.clear();
  }
}
