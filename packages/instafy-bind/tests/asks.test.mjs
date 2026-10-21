// "Ask Octo" is host-mediated: an agent intent clicked in a page is an ask the page hands to Studio, which sends it as
// the clicker's own chat message. The binder never starts an Octo turn for it and, by default, never reads an
// Instafy login. Only the owner's --agent-executor runs agent intents itself, and only for clicks made on this machine.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { cleanup, eventsUrl, intentMessage, makeSite, openSse, postIntent, startBinder } from "./helpers.mjs";
import { TOKEN, startMockController } from "./mock-controller.mjs";

const askDef = {
  label: "Ask Octo",
  params: { type: "object", required: ["ref"], additionalProperties: false, properties: { ref: { type: "string", pattern: "^things:[a-z]{1,20}$" } } },
  executor: "agent",
  agent: { prompt: "Is {{ref}} still sold? Report what its page shows." },
};
const scriptDef = { label: "Check", params: { type: "object", additionalProperties: false, properties: {} }, handler: "handlers/check.mjs" };

function site() {
  return makeSite({
    "index.html": "<!doctype html><title>x</title>",
    "bound.json": { version: 1, title: "Things", intents: { ask_octo: askDef, check: scriptDef } },
    "handlers/check.mjs": "process.stdout.write(JSON.stringify({type:'done'})+'\\n');",
  });
}

const health = async (binder, headers = {}) => (await fetch(`${binder.url}/__bind/health`, { headers })).json();

/** A request with a Host header (fetch cannot set one): what a tunnel or a proxy in front of the binder sends. */
function postWithHost(binder, hostHeader, msg) {
  const { port } = new URL(binder.url);
  const body = JSON.stringify(msg);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/__bind/intent", method: "POST",
      headers: { host: hostHeader, "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-bind-token": binder.sites[0].token },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("by default an agent intent is an ask through Studio: 409 ask_via_host, and the binder holds no login", async () => {
  const controller = await startMockController({ replies: [] });
  const dir = site();
  // Even handed a login and a space, the binder does not take it without --agent-executor.
  const binder = await startBinder(dir, { serverUrl: controller.url, accessToken: TOKEN, space: "space_1", conversation: "conv_owner" });
  const sse = openSse(eventsUrl(binder));
  try {
    assert.equal(binder.agentState, "host");
    assert.equal(binder.controller.hasToken, false);
    assert.equal(binder.controller.token, null);
    assert.equal(binder.controller.controllerUrl, null);

    const h = await health(binder);
    assert.deepEqual(h.intents, ["check"], "the binder runs only the script intent");
    assert.deepEqual(h.asks.map((a) => [a.name, a.via, a.executor, a.label]), [["ask_octo", "host", "agent", "Ask Octo"]]);
    assert.equal(h.executors.agent, "host");

    const res = await postIntent(binder, intentMessage("ask_octo", { ref: "things:a" }));
    assert.equal(res.status, 409);
    assert.equal(res.body.reason, "ask_via_host");

    await sse.opened;
    const hello = await sse.waitFor((e) => e.event === "hello");
    assert.deepEqual(hello.data.capabilities, { intents: ["check"], asks: ["ask_octo"] });
    assert.deepEqual(controller.requests, [], "nothing ever reached the controller");
  } finally {
    sse.close();
    await binder.close();
    await controller.close();
    cleanup(dir);
  }
});

test("--agent-executor runs the owner's own clicks on this machine; a click through a tunnel or proxy is still an ask", async () => {
  const controller = await startMockController({ replies: [] });
  const dir = site();
  const binder = await startBinder(dir, {
    agentExecutor: true, serverUrl: controller.url, accessToken: TOKEN, space: "space_1", conversation: "conv_owner",
    publicOrigins: ["https://abc123.tunnel.example"], pollMs: 20,
  });
  try {
    assert.equal(binder.agentState, "ready");
    // the owner on localhost: the binder offers and queues it
    const local = await health(binder);
    assert.deepEqual(local.intents.sort(), ["ask_octo", "check"]);
    assert.deepEqual(local.asks, []);

    // a request a proxy forwarded: never the owner's own click
    const proxied = await health(binder, { "x-forwarded-for": "203.0.113.9" });
    assert.deepEqual(proxied.intents, ["check"]);
    assert.deepEqual(proxied.asks.map((a) => a.name), ["ask_octo"]);
    const viaProxy = await postIntent(binder, intentMessage("ask_octo", { ref: "things:a" }), { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(viaProxy.status, 409);
    assert.equal(viaProxy.body.reason, "ask_via_host");

    // the tunnel's public name (or a preview capability host): the same
    const viaTunnel = await postWithHost(binder, "abc123.tunnel.example", intentMessage("ask_octo", { ref: "things:a" }));
    assert.equal(viaTunnel.status, 409);
    assert.equal(viaTunnel.body.reason, "ask_via_host");
    assert.equal(controller.requests.filter((r) => r.method === "POST").length, 0, "no Octo turn for anyone else's click");

    const mine = await postIntent(binder, intentMessage("ask_octo", { ref: "things:a" }));
    assert.equal(mine.status, 202, JSON.stringify(mine.body));
  } finally {
    await binder.close();
    await controller.close();
    cleanup(dir);
  }
});
