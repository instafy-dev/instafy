// The bind client's side of host-mediated Ask Octo: an agent intent is an ask that only a host taking asks (Studio's
// layout caps.ask === true) may send, as the clicker's own chat message. The page never sends it to the binder, to
// "*" or to a frame that is not its host; where no host takes asks, asks are not offered at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("../client/bind-client.js", import.meta.url), "utf8");
const SITE = "https://p-site.example";
const STUDIO = "https://studio.example";
const ASK = { name: "ask_octo", label: "Is it in stock?", executor: "agent", via: "host", params: { type: "object" } };
const CHECK = { name: "check", label: "Check price", executor: "script", params: { type: "object" } };

function load({ embedded = true, search = "?instafy_host=studio", asks = [ASK], catalog = [CHECK], intentReply = { status: 202, body: { status: "queued" } }, parentOrigins = [STUDIO] } = {}) {
  const listeners = {};
  const sent = [];
  const posted = [];
  const parent = { postMessage(msg, origin) { sent.push({ msg: JSON.parse(JSON.stringify(msg)), origin }); } };
  const location = { href: `${SITE}/${search}`, origin: SITE, search, hash: "", pathname: "/" };
  const window = { addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, location, navigator: {} };
  window.parent = embedded ? parent : window;
  const health = { ok: true, host: "instafy-bind", intents: catalog.map((d) => d.name), catalog, asks, parentOrigins };
  const context = {
    window,
    document: { currentScript: null, title: "Shoes", createElement: () => ({ setAttribute() {}, remove() {} }), body: { appendChild() {} } },
    location,
    navigator: window.navigator,
    URL,
    // long timers never fire here; the rest (the page's 3 s polling while a click is pending) never hold the process
    setTimeout: (fn, ms) => (ms >= 10000 ? { fake: true } : setTimeout(fn, ms).unref()),
    clearTimeout: (t) => { if (!t || !t.fake) clearTimeout(t); },
    setInterval: () => 0,
    clearInterval() {},
    console,
    fetch: (url, init) => {
      const u = String(url);
      if (u.endsWith("/health")) return Promise.resolve({ ok: true, json: async () => health });
      if (u.endsWith("/intent")) {
        posted.push(JSON.parse(init.body));
        return Promise.resolve({ ok: intentReply.status < 300, status: intentReply.status, json: async () => intentReply.body });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => null });
    },
    EventSource: undefined,
  };
  vm.runInNewContext(SOURCE, context);
  const page = {
    bind: window.instafyBind,
    sent,
    posted,
    deliver(data, { origin = STUDIO, source = parent } = {}) {
      for (const fn of listeners.message || []) fn({ data, origin, source });
    },
    layout(caps) { page.deliver({ source: "instafy-host", v: 1, type: "layout", caps, theme: "light" }); },
    status(payload, opts) { page.deliver({ source: "instafy-host", v: 1, type: "ask-status", payload }, opts); },
    asksSent: () => sent.filter((s) => s.msg.type === "ask"),
  };
  return page;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const plain = (x) => JSON.parse(JSON.stringify(x));

test("in a host that takes asks, an Ask Octo click goes to the host at its origin as an ask, never to the binder", async () => {
  const page = load();
  await tick(5);
  page.layout({ ask: true });
  const ready = plain(await page.bind.ready);
  assert.deepEqual(ready.names, ["check", "ask_octo"]);
  assert.equal(ready.intents.find((d) => d.name === "ask_octo").via, "host");

  const events = [];
  page.bind.on("*", (type, m) => { if (m.id) events.push([type, m.status || m.summary || (m.error && m.error.message) || null]); });
  const id = page.bind.intent("ask_octo", { ref: "shoes:a" }, { ref: "shoes:a" });
  await tick(5);
  const [ask] = page.asksSent();
  assert.equal(ask.origin, STUDIO, "posted to the host's origin, never *");
  assert.deepEqual(ask.msg, { source: "instafy-bind", v: 1, type: "ask", payload: { id, intent: "ask_octo", label: "Is it in stock?", params: { ref: "shoes:a" }, ref: "shoes:a" } });
  assert.deepEqual(page.posted, [], "the binder never sees an ask");
  assert.equal(page.sent.filter((s) => s.msg.type === "intent").length, 0, "no v2 intent to the parent either");

  // answers count only from the host, for an id it was sent
  page.status({ id, state: "done", reason: "forged" }, { origin: "https://evil.example" });
  page.status({ id: "int_other", state: "done" });
  page.status({ id, state: "sent" });
  assert.equal(page.bind.pendingInfo(id).status, "sent");
  page.status({ id, state: "done", reason: "In stock in EU 42" });
  assert.equal(page.bind.pendingInfo(id), null);
  assert.deepEqual(events.filter(([type]) => type !== "intent"), [["ack", "sent"], ["done", "In stock in EU 42"]]);
  // script intents still go to the binder
  page.bind.intent("check", {});
  await tick(5);
  assert.deepEqual(page.posted.map((m) => m.name), ["check"]);
});

test("a host that does not let this person send lists the asks as disabled with its reason, and sends nothing", async () => {
  const page = load();
  await tick(5);
  const reason = "You can view this chat but not send messages.";
  page.layout({ ask: reason });
  const ready = plain(await page.bind.ready);
  assert.equal(ready.intents.find((d) => d.name === "ask_octo").disabled, reason);
  const acks = [];
  page.bind.on("ack", (m) => acks.push(m));
  page.bind.intent("ask_octo", { ref: "shoes:a" });
  await tick(5);
  assert.deepEqual(page.asksSent(), []);
  assert.deepEqual(page.posted, []);
  assert.equal(acks.at(-1).status, "rejected");
  assert.equal(acks.at(-1).reason, reason);
});

test("outside a host that takes asks they are not offered: not framed, or a host without caps.ask", async () => {
  const alone = load({ embedded: false, search: "" });
  assert.deepEqual(plain(await alone.bind.ready).names, ["check"]);
  assert.throws(() => alone.bind.intent("ask_octo", {}), /not available/);

  const framed = load();
  await tick(5);
  framed.layout({ location: "host" });
  assert.deepEqual(plain(await framed.bind.ready).names, ["check"]);
  assert.deepEqual(framed.asksSent(), []);
});

test("an agent intent the binder answers 409 ask_via_host is handed to the host instead, or said to need Instafy", async () => {
  // The binder listed it as its own (the owner's --agent-executor on this machine), but this click reached it another
  // way (a proxy, a tunnel): the binder refuses it, and the client hands it to the host as an ask.
  const OWN = { ...ASK, via: undefined };
  const refused = { status: 409, body: { status: "rejected", reason: "ask_via_host" } };
  const hosted = load({ asks: [], catalog: [CHECK, OWN], intentReply: refused });
  await tick(5);
  hosted.layout({ ask: true });
  await hosted.bind.ready;
  hosted.bind.intent("ask_octo", { ref: "shoes:a" });
  await tick(5);
  assert.deepEqual(hosted.posted.map((m) => m.name), ["ask_octo"]);
  assert.equal(hosted.asksSent().length, 1, "the refused click went to the host as an ask");

  const alone = load({ embedded: false, search: "", asks: [], catalog: [CHECK, OWN], intentReply: refused });
  await alone.bind.ready;
  const acks = [];
  alone.bind.on("ack", (m) => acks.push(m));
  alone.bind.intent("ask_octo", { ref: "shoes:a" });
  await tick(5);
  assert.equal(acks.at(-1).status, "rejected");
  assert.equal(acks.at(-1).reason, "Ask Octo works when this page is open in Instafy.");
});

test("an ask the host never answers is cleared after 5 s with a plain message", async () => {
  const page = load();
  await tick(5);
  page.layout({ ask: true });
  await page.bind.ready;
  const acks = [];
  page.bind.on("ack", (m) => acks.push(m));
  page.bind.intent("ask_octo", { ref: "shoes:a" });
  await tick(5200);
  assert.equal(acks.at(-1).status, "rejected");
  assert.equal(acks.at(-1).reason, "Instafy did not answer. Try again, or ask in the chat.");
  page.status({ id: acks.at(-1).id, state: "done" });
  assert.equal(page.bind.pendingInfo(acks.at(-1).id), null);
});

test("a frame the binder does not list cannot take asks: its caps.ask is ignored and no ask (or its params) reaches it", async () => {
  const page = load({ parentOrigins: [] });
  await tick(5);
  page.layout({ ask: true });
  await tick(2100); // the client waits up to 2 s for a host's first layout
  const ready = plain(await page.bind.ready);
  assert.deepEqual(ready.names, ["check"], "no host, so no Ask Octo");
  assert.throws(() => page.bind.intent("ask_octo", { ref: "shoes:a" }), /not available/);
  assert.deepEqual(page.asksSent(), []);
});

test("an ask carries the clicker's position rounded to about 100 m, without precision details or private params", async () => {
  const ask = { ...ASK, private_params: ["note"] };
  const page = load({ asks: [ask] });
  await tick(5);
  page.layout({ ask: true });
  await page.bind.ready;
  page.bind.intent("ask_octo", {
    ref: "cafes:a", lat: 52.370216, lng: 4.895168, accuracy: 12, near: "52.370216, 4.895168",
    position: { latitude: 52.370216, longitude: 4.895168, altitude: 3.5, heading: 90 }, note: "my flat is at 12 Elm St", topic: "quiet",
  }, { ref: "cafes:a" });
  await tick(5);
  const [sent] = page.asksSent();
  const text = JSON.stringify(sent.msg.payload);
  assert.doesNotMatch(text, /52\.3702|4\.8951|Elm St/, "no precise position and no private param reaches the chat");
  assert.deepEqual(plain(sent.msg.payload.params), {
    ref: "cafes:a", lat: 52.37, lng: 4.895, near: "52.37, 4.895", position: { latitude: 52.37, longitude: 4.895 }, topic: "quiet",
  });
  assert.deepEqual(plain(sent.msg.payload.withheld), ["accuracy", "note"]);
  assert.deepEqual(plain(sent.msg.payload.coarsened), ["lat", "lng", "near", "position"]);
});
