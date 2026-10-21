import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { cleanup, eventsUrl, intentMessage, makeSite, openSse, postIntent, simpleParams, sleep, startBinder } from "./helpers.mjs";

const QUICK_HANDLER = `
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
kit.progress(1, 1, "working");
kit.records([{ type: "claim", cid: kit.rid("clm", intent.params.name), ref: "things:" + intent.params.name, attr: "greeting", value: "hi " + intent.params.name, basis: "editorial", prov: { source: "test", lane: "local", observed_at: new Date().toISOString(), ttl_s: 60 } }]);
kit.done("ok " + intent.params.name);
`;
const SLOW_HANDLER = `
const kit = await import(process.env.BIND_KIT);
await kit.readInput();
kit.progress(1, 2, "slow");
setTimeout(() => kit.done("slow done"), 400);
`;

function site(extraIntents = {}) {
  return makeSite({
    "index.html": "<!doctype html><title>t</title><p>hello</p>",
    "app.js": "console.log(1)",
    "styles/a.css": "body{}",
    "big.bin": Buffer.alloc(1000, 7).toString("latin1"),
    ".env": "SECRET=1",
    "sub/index.html": "<p>sub</p>",
    "handlers/quick.mjs": QUICK_HANDLER,
    "handlers/slow.mjs": SLOW_HANDLER,
    "bound.json": {
      version: 1,
      title: "Test site",
      intents: {
        hello: { label: "Hello", params: simpleParams(), handler: "handlers/quick.mjs", lanes: ["local"], cooldown_s: 30 },
        slow: { label: "Slow", params: simpleParams({ n: { type: "integer", default: 1 } }), handler: "handlers/slow.mjs" },
        fetch_url: { label: "Fetch", params: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } }, handler: "handlers/quick.mjs" },
        missing: { label: "Missing", params: simpleParams(), handler: "handlers/nope.mjs" },
        ...extraIntents,
      },
    },
  });
}

test("health and client.js under __bind/, and no other endpoint prefix", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  try {
    for (const prefix of ["__bind"]) {
      const health = await (await fetch(`${binder.url}/${prefix}/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(health.host, "instafy-bind");
      assert.equal(health.v, 2);
      assert.deepEqual(health.intents.sort(), ["fetch_url", "hello", "slow"], "missing handler is not listed");
      assert.equal(health.catalog.find((i) => i.name === "hello").label, "Hello");
      const client = await fetch(`${binder.url}/${prefix}/client.js`);
      assert.match(client.headers.get("content-type"), /javascript/);
      assert.match(await client.text(), /instafyBind/);
    }
    // a page in a subfolder resolves endpoints relative to itself
    assert.equal((await fetch(`${binder.url}/sub/__bind/health`)).status, 200);
    // one protocol: the old __uw/ alias is just a (missing) file
    assert.equal((await fetch(`${binder.url}/__uw/health`)).status, 404);
    assert.ok(binder.logs.some((l) => /missing is not available/.test(l.text)));
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("static: MIME, index.html, directory redirect, Range, no dotfiles, no traversal", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  try {
    let res = await fetch(`${binder.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    res = await fetch(`${binder.url}/app.js`);
    assert.match(res.headers.get("content-type"), /text\/javascript/);
    res = await fetch(`${binder.url}/styles/a.css`);
    assert.match(res.headers.get("content-type"), /text\/css/);
    res = await fetch(`${binder.url}/sub`, { redirect: "manual" });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/sub/");
    res = await fetch(`${binder.url}/big.bin`, { headers: { range: "bytes=10-19" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), "bytes 10-19/1000");
    assert.equal((await res.arrayBuffer()).byteLength, 10);
    res = await fetch(`${binder.url}/big.bin`, { headers: { range: "bytes=-5" } });
    assert.equal(res.headers.get("content-range"), "bytes 995-999/1000");
    res = await fetch(`${binder.url}/big.bin`, { headers: { range: "bytes=5000-" } });
    assert.equal(res.status, 416);
    assert.equal((await fetch(`${binder.url}/.env`)).status, 404);
    assert.equal((await fetch(`${binder.url}/.bind/admin-token`)).status, 404);
    for (const raw of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/sub/..%2f..%2fetc/passwd", "/a%00b"]) {
      const status = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: new URL(binder.url).port, path: raw }, (r) => { r.resume(); resolve(r.statusCode); }));
      assert.ok([400, 404].includes(status), `${raw} -> ${status}`);
    }
    assert.equal((await fetch(`${binder.url}/nope.html`)).status, 404);
    assert.equal((await fetch(`${binder.url}/app.js`, { method: "POST" })).status, 405);
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("intent validation: token, origin, content type, unknown name, bad params, oversize", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  try {
    const ok = intentMessage("hello", { name: "kim" });
    assert.equal((await postIntent(binder, ok, { token: null })).status, 401, "missing token");
    assert.equal((await postIntent(binder, ok, { token: "x".repeat(32) })).status, 401, "wrong token");
    const cookie = `${binder.sites[0].cookie}=${binder.sites[0].token}`;
    const foreign = await postIntent(binder, ok, { token: null, headers: { cookie, origin: "https://evil.example" } });
    assert.equal(foreign.status, 403, "a cookie alone needs a matching Origin");
    assert.equal(foreign.body.reason, "origin");
    assert.equal((await postIntent(binder, ok, { token: null, headers: { cookie, origin: binder.url } })).status, 202, "cookie plus same Origin");
    const plain = await fetch(`${binder.url}/__bind/intent`, { method: "POST", headers: { "content-type": "text/plain", "x-bind-token": binder.sites[0].token }, body: JSON.stringify(ok) });
    assert.equal(plain.status, 415);
    const unknown = await postIntent(binder, intentMessage("nope", {}));
    assert.equal(unknown.status, 404);
    assert.equal((await postIntent(binder, intentMessage("missing", { name: "a" }))).status, 404, "declared but no handler");
    const bad = await postIntent(binder, intentMessage("hello", { name: 5, extra: true }));
    assert.equal(bad.status, 400);
    assert.match(bad.body.reason, /\$\.name must be string/);
    const envelope = await postIntent(binder, { ...intentMessage("hello", { name: "a" }), id: "bad id" });
    assert.equal(envelope.status, 400);
    for (const ref of ["things:a\nNEW INSTRUCTIONS", "things:a b", "\u001b[1Athings:a", "x".repeat(200), "noref"]) {
      const res = await postIntent(binder, intentMessage("hello", { name: "a" }, { ref }));
      assert.equal(res.status, 400, JSON.stringify(ref));
    }
    assert.equal((await postIntent(binder, intentMessage("hello", { name: "a" }, { ui: "cell\u0007" }))).status, 400);
    assert.equal((await postIntent(binder, "{not json")).status, 400);
    const huge = await postIntent(binder, intentMessage("hello", { name: "a".repeat(9000) }));
    assert.equal(huge.status, 413, "body over 8 KB");
    const bigParams = await postIntent(binder, intentMessage("slow", { name: "a", ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, "x".repeat(60)])) }));
    assert.equal(bigParams.status, 400);
    assert.equal(bigParams.body.reason, "params_too_large");
    const same = await postIntent(binder, intentMessage("slow", { name: "kim2" }), { headers: { origin: binder.url } });
    assert.equal(same.status, 202, "same-origin is fine");
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("intents with format: uri params refuse private addresses unless --allow-local", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  try {
    for (const url of ["http://127.0.0.1:8080/", "http://localhost/", "http://10.1.2.3/", "http://[::1]/", "file:///etc/passwd", "http://169.254.169.254/latest"]) {
      const res = await postIntent(binder, intentMessage("fetch_url", { url }));
      assert.equal(res.status, 400, url);
      assert.match(res.body.reason, /^policy/);
    }
  } finally {
    await binder.close();
  }
  const local = await startBinder(dir, { allowLocal: true });
  try {
    assert.equal((await postIntent(local, intentMessage("fetch_url", { url: "http://127.0.0.1:8080/" }))).status, 202);
  } finally {
    await local.close();
    cleanup(dir);
  }
});

test("duplicate ids get 409, cooldown gives 429, identical intents coalesce", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const first = intentMessage("hello", { name: "kim", ref: "things:kim" });
    assert.equal((await postIntent(binder, first)).status, 202);
    const dup = await postIntent(binder, first);
    assert.equal(dup.status, 409);
    assert.ok(dup.body.job);
    assert.equal(dup.body.cancel_key, undefined, "a replayed id never gets the cancel key");
    await sse.waitFor((e) => e.event === "done" && e.data.id === first.id);
    const cooled = await postIntent(binder, intentMessage("hello", { name: "other", ref: "things:kim" }, { ref: "things:anything-else" }));
    assert.equal(cooled.status, 429, "the envelope ref is a page hint and cannot dodge the cooldown");
    assert.ok(cooled.body.retry_after_s > 0);
    assert.equal((await postIntent(binder, intentMessage("hello", { name: "x", ref: "things:other" }))).status, 202, "cooldown is per (name, params.ref)");

    const a = intentMessage("slow", { name: "same" });
    const b = intentMessage("slow", { name: "same" });
    const ra = await postIntent(binder, a);
    const rb = await postIntent(binder, b);
    assert.equal(ra.status, 202);
    assert.equal(rb.status, 202);
    assert.equal(rb.body.coalesced, true);
    assert.equal(rb.body.job, ra.body.job);
    const doneA = await sse.waitFor((e) => e.event === "done" && e.data.id === a.id);
    const doneB = await sse.waitFor((e) => e.event === "done" && e.data.id === b.id);
    assert.deepEqual(doneA.data.ids, [a.id, b.id]);
    assert.equal(doneB.data.job, ra.body.job, "every id of a coalesced job gets its own events");
    const version = JSON.parse(fs.readFileSync(path.join(dir, "data/version.json"), "utf8"));
    assert.equal(version.jobs[a.id], "done");
    assert.equal(version.jobs[b.id], "done");
    const jobs = await (await fetch(`${binder.url}/__bind/jobs`, { headers: { "x-bind-token": binder.sites[0].token } })).json();
    assert.ok(jobs.jobs.length >= 3);
    assert.equal((await fetch(`${binder.url}/__bind/jobs`)).status, 401);
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("at most 2 jobs run at once per site", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const msgs = [1, 2, 3].map((i) => intentMessage("slow", { name: `n${i}` }));
    for (const m of msgs) assert.equal((await postIntent(binder, m)).status, 202);
    await sleep(150);
    const running = binder.sites[0].jobs.jobs.filter((j) => j.state === "running").length;
    assert.equal(running, 2);
    await sse.waitFor((e) => e.event === "done" && e.data.id === msgs[2].id, 5000);
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("--no-token works on localhost only; gallery mode serves each site under its folder", async () => {
  const dir = site();
  const open = await startBinder(dir, { noToken: true });
  try {
    assert.equal((await postIntent(open, intentMessage("hello", { name: "a" }), { token: null })).status, 202);
  } finally {
    await open.close();
  }
  await assert.rejects(startBinder(dir, { noToken: true, host: "0.0.0.0" }), /only allowed when serving on localhost/);

  const gallery = makeSite({});
  fs.renameSync(dir, path.join(gallery, "one"));
  const binder = await startBinder(gallery);
  try {
    assert.equal(binder.sites.length, 1);
    assert.equal(binder.sites[0].prefix, "/one");
    assert.equal((await fetch(`${binder.url}/one/__bind/health`)).status, 200);
    assert.equal((await fetch(`${binder.url}/__bind/health`)).status, 404);
    assert.match(await (await fetch(`${binder.url}/`)).text(), /Bound sites/);
    assert.equal((await postIntent(binder, intentMessage("hello", { name: "g" }))).status, 202);
    assert.match(binder.shareUrl(binder.sites[0], binder.url, "hash"), /\/one\/#k=/);
    assert.match(binder.shareUrl(binder.sites[0], binder.url, "query"), /\/one\/\?k=/);
  } finally {
    await binder.close();
    cleanup(gallery);
  }
});

test("--no-token: the Host header must be a name the binder was started for (DNS rebinding)", async () => {
  const dir = site();
  const open = await startBinder(dir, { noToken: true });
  const port = new URL(open.url).port;
  const raw = (headers) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/__bind/intent", method: "POST", headers: { "content-type": "application/json", ...headers } }, (r) => { r.resume(); resolve(r.statusCode); });
    req.end(JSON.stringify(intentMessage("hello", { name: "r" })));
  });
  try {
    assert.equal(await raw({ host: `rebind.attacker.example:${port}`, origin: `http://rebind.attacker.example:${port}` }), 421);
    assert.equal(await raw({ host: `127.0.0.1:${port}`, "x-forwarded-host": `rebind.attacker.example:${port}`, origin: `http://rebind.attacker.example:${port}` }), 403, "x-forwarded-host is ignored without --trust-proxy");
    assert.equal(await raw({ host: `localhost:${port}`, origin: `http://localhost:${port}` }), 202);
  } finally {
    await open.close();
    cleanup(dir);
  }
});

test("gallery mode serves only discovered site folders", async () => {
  const gallery = makeSite({ "private-project/config.env": "API_KEY=sk-live-123", "private-project/secrets.json": "{}", "notes.txt": "x" });
  fs.renameSync(site(), path.join(gallery, "one"));
  const binder = await startBinder(gallery);
  try {
    assert.equal((await fetch(`${binder.url}/private-project/config.env`)).status, 404);
    assert.equal((await fetch(`${binder.url}/private-project/secrets.json`)).status, 404);
    assert.equal((await fetch(`${binder.url}/notes.txt`)).status, 404);
    assert.equal((await fetch(`${binder.url}/one/`)).status, 200);
    const bare = await fetch(`${binder.url}/one`, { redirect: "manual" });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get("location"), "/one/");
  } finally {
    await binder.close();
    cleanup(gallery);
  }
});

test("reads need the viewer token: records, bound.json and written data; handlers and tests are never served", async () => {
  const dir = site();
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "test/x.test.mjs"), "x");
  const binder = await startBinder(dir);
  const token = binder.sites[0].token;
  try {
    await postIntent(binder, intentMessage("slow", { name: "w" }));
    await sleep(600);
    for (const p of ["/__bind/records", "/bound.json", "/data/version.json"]) {
      assert.equal((await fetch(`${binder.url}${p}`)).status, 401, `${p} without token`);
      assert.equal((await fetch(`${binder.url}${p}`, { headers: { "x-bind-token": token } })).status, 200, `${p} with token`);
    }
    for (const p of ["/handlers/quick.mjs", "/test/x.test.mjs"]) {
      assert.equal((await fetch(`${binder.url}${p}`, { headers: { "x-bind-token": token } })).status, 404, p);
    }
    assert.equal((await fetch(`${binder.url}/index.html`)).status, 200, "the page itself stays public");
    assert.equal((await fetch(`${binder.url}/__bind/client.js`)).status, 200);
    const health = await (await fetch(`${binder.url}/__bind/health`)).json();
    assert.equal(health.viewer, false);
    assert.equal((await (await fetch(`${binder.url}/__bind/health`, { headers: { "x-bind-token": token } })).json()).viewer, true);
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("session: the client trades its header token for an HttpOnly cookie; HTML carries frame-ancestors", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  try {
    const s = binder.sites[0];
    assert.equal((await fetch(`${binder.url}/__bind/session`, { method: "POST" })).status, 401);
    const res = await fetch(`${binder.url}/__bind/session`, { method: "POST", headers: { "x-bind-token": s.token } });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.equal((await fetch(`${binder.url}/__bind/records`, { headers: { cookie: cookie.split(";")[0] } })).status, 200);
    const page = await fetch(`${binder.url}/`);
    assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'self'");
    assert.equal((await fetch(`${binder.url}/app.js`)).headers.get("content-security-policy"), null);
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("limits: SSE viewers per site, waiting jobs, intents per minute; eviction never drops waiting jobs", async () => {
  const dir = site({ gated: { label: "Gated", params: simpleParams(), handler: "handlers/quick.mjs", confirm: true } });
  const binder = await startBinder(dir);
  const s = binder.sites[0];
  try {
    s.hub.maxClients = 2;
    const a = openSse(eventsUrl(binder));
    const b = openSse(eventsUrl(binder));
    await a.opened;
    await b.opened;
    await assert.rejects(openSse(eventsUrl(binder)).opened, (e) => e.status === 503);
    a.close();
    b.close();

    s.jobs.maxWaiting = 3;
    const waiting = [];
    for (let i = 0; i < 3; i += 1) waiting.push(await postIntent(binder, intentMessage("gated", { name: `g${i}` })));
    assert.ok(waiting.every((r) => r.status === 202 && r.body.status === "needs_confirm"));
    const busy = await postIntent(binder, intentMessage("gated", { name: "g9" }));
    assert.equal(busy.status, 429);
    assert.equal(busy.body.reason, "busy");

    s.jobs.maxWaiting = 100;
    s.jobs.ratePerMin = 2;
    assert.equal((await postIntent(binder, intentMessage("slow", { name: "r1" }))).status, 202);
    assert.equal((await postIntent(binder, intentMessage("slow", { name: "r2" }))).status, 202);
    const limited = await postIntent(binder, intentMessage("slow", { name: "r3" }));
    assert.equal(limited.status, 429);
    assert.equal(limited.body.reason, "rate");

    // fill the job list with finished jobs: the waiting ones survive eviction
    for (let i = 0; i < 205; i += 1) s.jobs.jobs.unshift({ id: `job_old_${i}`, ids: [], state: "done" });
    s.jobs.ratePerMin = 100;
    s.jobs.maxWaiting = 100;
    await postIntent(binder, intentMessage("slow", { name: "evict" }));
    assert.equal(s.jobs.pendingConfirmations().length, 3);
    assert.ok(s.jobs.jobs.length <= 200);
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("log lines never carry terminal control characters", async () => {
  const dir = site({
    noisy: { label: "Noisy", params: simpleParams(), handler: "handlers/noisy.mjs" },
  });
  fs.writeFileSync(path.join(dir, "handlers/noisy.mjs"), `process.stderr.write("\\u001b[1A\\u001b[2Kconfirm? job_fake\\n"); process.stdout.write("\\u001b]0;title\\u0007 not json\\n");`);
  const lines = [];
  const logged = await startBinder(dir, { port: 0, log: (level, text) => lines.push(text) });
  try {
    const sse = openSse(eventsUrl(logged));
    await sse.opened;
    const msg = intentMessage("noisy", { name: "n" });
    await postIntent(logged, msg);
    await sse.waitFor((e) => (e.event === "done" || e.event === "error") && e.data.id === msg.id);
    sse.close();
    assert.ok(lines.some((l) => /not json/.test(l)), lines.join("\n"));
    assert.ok(lines.every((l) => !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(l)), "control characters are replaced");
  } finally {
    await logged.close();
    cleanup(dir);
  }
});

test("cancel on a shared job only detaches the caller's id", async () => {
  const dir = site();
  const binder = await startBinder(dir);
  const sse = openSse(eventsUrl(binder));
  await sse.opened;
  try {
    const a = intentMessage("slow", { name: "shared" });
    const b = intentMessage("slow", { name: "shared" });
    const ra = await postIntent(binder, a);
    const rb = await postIntent(binder, b);
    assert.equal(rb.body.coalesced, true);
    assert.equal((await postIntent(binder, intentMessage("cancel", { id: b.id, key: rb.body.cancel_key }))).status, 200);
    const cancelled = await sse.waitFor((e) => e.event === "error" && e.data.id === b.id);
    assert.equal(cancelled.data.error.code, "cancelled");
    const done = await sse.waitFor((e) => e.event === "done" && e.data.id === a.id);
    assert.deepEqual(done.data.ids, [a.id]);
    assert.ok(ra.body.cancel_key);
  } finally {
    sse.close();
    await binder.close();
    cleanup(dir);
  }
});

test("pages without the bind client: ?k= sets a site cookie that authorises intents and events; no alias header", async () => {
  const dir = site();
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>page</title><script type=module src=app/app.js></script>");
  const binder = await startBinder(dir);
  try {
    const s = binder.sites[0];
    assert.equal(s.linkStyle, "query");
    const share = binder.shareUrl(s);
    assert.match(share, /\/\?k=[A-Za-z0-9_-]{16,}$/);

    const page = await fetch(`${binder.url}/index.html`);
    assert.equal(page.headers.get("x-uw-host"), null);

    const wrong = await fetch(`${binder.url}/?k=${"x".repeat(32)}`, { redirect: "manual" });
    assert.equal(wrong.status, 200, "a wrong token is ignored, never a cookie");
    assert.equal(wrong.headers.get("set-cookie"), null);

    const handoff = await fetch(`${share}&lens=sleep`, { redirect: "manual" });
    assert.equal(handoff.status, 303);
    assert.equal(handoff.headers.get("location"), "/?lens=sleep");
    const setCookie = handoff.headers.get("set-cookie");
    assert.match(setCookie, /^bind_k_[0-9a-f]{12}=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(";")[0];

    const withCookie = await postIntent(binder, intentMessage("hello", { name: "cookie" }), { token: null, headers: { cookie } });
    assert.equal(withCookie.status, 202);
    const noCookie = await postIntent(binder, intentMessage("hello", { name: "none" }), { token: null });
    assert.equal(noCookie.status, 401);
    const otherCookie = await postIntent(binder, intentMessage("hello", { name: "x" }), { token: null, headers: { cookie: `${s.cookie}=${"y".repeat(32)}` } });
    assert.equal(otherCookie.status, 401);

    const events = await fetch(`${binder.url}/__bind/events`, { headers: { cookie } });
    assert.equal(events.status, 200);
    await events.body.cancel();
  } finally {
    await binder.close();
    cleanup(dir);
  }
});

test("a plain site (index.html, no bound.json) is served with the bind client added, so Studio can present and follow it", async () => {
  const dir = makeSite({
    "index.html": "<!doctype html><html><head><title>Activities</title></head><body><table id=t></table></body></html>",
    "about.html": "<p>no head or body</p>",
    "own.html": "<html><head><script src=\"__bind/client.js\"></script></head><body></body></html>",
    "data.json": { rows: [] },
  });
  const binder = await startBinder(dir, { noToken: true });
  try {
    assert.equal(binder.sites.length, 1);
    const page = await fetch(`${binder.url}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<script src="\/__bind\/client\.js"><\/script><\/head>/, "the client goes into <head>");
    assert.equal(Number(page.headers.get("content-length")), Buffer.byteLength(html));
    assert.match(await (await fetch(`${binder.url}/about.html`)).text(), /<p>no head or body<\/p><script src="\/__bind\/client\.js"><\/script>$/);
    assert.equal((await (await fetch(`${binder.url}/own.html`)).text()).match(/client\.js/g).length, 1, "a page that loads it keeps one");
    assert.deepEqual(await (await fetch(`${binder.url}/data.json`)).json(), { rows: [] }, "other files are untouched");
    const health = await fetch(`${binder.url}/__bind/health`);
    assert.equal(health.status, 200, "the client finds a binder: no 404s for preview check to report");
    assert.deepEqual((await health.json()).intents, []);
    assert.equal((await fetch(`${binder.url}/__bind/client.js`)).status, 200);
  } finally {
    await binder.close();
    cleanup(dir);
  }
  // a folder with neither is still refused
  const empty = makeSite({ "notes.txt": "x" });
  await assert.rejects(startBinder(empty, { noToken: true }), /no bound\.json .* and no index\.html/);
  cleanup(empty);
});

test("other spellings of a guarded path are guarded too: case, trailing dots and spaces, streams, the real name", async () => {
  const dir = site();
  fs.mkdirSync(path.join(dir, "data", "records"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data", "records", "x.json"), JSON.stringify({ schema: "instafy.records@1", records: [] }));
  const binder = await startBinder(dir);
  try {
    const get = async (p) => (await fetch(`${binder.url}${p}`)).status;
    for (const p of ["/bound.json", "/Bound.json", "/BOUND.JSON", "/bound.json.", "/bound.json%20", "/bound.json::$DATA", "/data/records/x.json", "/DATA/records/x.json", "/data/Records/X.json", "/data./records/x.json", "/Data/version.json"]) {
      assert.equal(await get(p), 401, `${p} needs the viewer token`);
    }
    for (const p of ["/handlers/quick.mjs", "/Handlers/quick.mjs", "/HANDLERS/quick.mjs", "/handlers./quick.mjs", "/handlers%20/quick.mjs", "/Tests/x", "/node_modules./x"]) {
      assert.equal(await get(p), 404, `${p} is never served`);
    }
    // with the token, the guarded files are served (by any spelling the filesystem knows)
    assert.equal((await fetch(`${binder.url}/bound.json`, { headers: { "x-bind-token": binder.sites[0].token } })).status, 200);
    assert.equal(await get("/app.js"), 200, "other files are untouched");
  } finally {
    await binder.close();
    cleanup(dir);
  }
});
