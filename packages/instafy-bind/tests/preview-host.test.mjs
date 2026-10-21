// serve --preview: a bound site inside Studio's preview card, with no viewer token. The binder answers localhost and
// the private preview capability host opened for its port, and nothing else (see src/preview-host.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PREVIEW_HOST_RE, previewHostParts, previewTunnelOf, previewTunnelReader } from "../src/preview-host.mjs";
import { cleanup, intentMessage, makeSite, startBinder } from "./helpers.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");
const HANDLER = `
const kit = await import(process.env.BIND_KIT);
const { intent } = await kit.readInput();
kit.done("ok " + intent.params.name);
`;
const LABEL = "abcdefghijklmnopqrstuvwxyz";
const TUNNEL = "0123456789abcdef0123456789abcdef";
const TUNNEL_HYPHENATED = "01234567-89ab-cdef-0123-456789abcdef";
const OTHER_TUNNEL = "fedcba9876543210fedcba9876543210";
const SUFFIX = "preview.localhost:8083";
const capHost = (tunnel = TUNNEL, domain = SUFFIX) => `p-${LABEL}--${tunnel}.${domain}`;

function site() {
  return makeSite({
    "index.html": "<!doctype html><title>t</title><script src=\"__bind/client.js\"></script><p>hello</p>",
    "handlers/hello.mjs": HANDLER,
    "bound.json": {
      version: 1,
      title: "Hello",
      intents: {
        hello: {
          label: "Say hello",
          params: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", maxLength: 20 } } },
          handler: "handlers/hello.mjs",
        },
      },
    },
  });
}

function writeState(file, previews) {
  fs.writeFileSync(file, JSON.stringify({ version: 1, previews }, null, 2));
}

/** A raw request with any Host header (fetch would not let us set it). */
function raw(port, { method = "GET", path: urlPath = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
        // SSE never ends; the first frame is enough.
        if (res.headers["content-type"]?.startsWith("text/event-stream")) {
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, text });
        }
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const intent = (port, host, origin = `http://${host}`) =>
  raw(port, {
    method: "POST",
    path: "/__bind/intent",
    headers: { host, "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(intentMessage("hello", { name: "kim" })),
  });

test("previewTunnelOf reads only the broker's capability host shape", () => {
  assert.equal(previewTunnelOf(capHost()), TUNNEL);
  assert.equal(previewTunnelOf(capHost(TUNNEL, "preview.instafy.dev")), TUNNEL, "no port on https");
  assert.equal(previewTunnelOf(capHost().toUpperCase()), TUNNEL, "Host is case-insensitive");
  for (const bad of [
    `p-${LABEL.slice(1)}--${TUNNEL}.preview.localhost`, // 25-char label
    `p-${LABEL}1--${TUNNEL}.preview.localhost`, // 1 is not base32
    `p-${LABEL}-${TUNNEL}.preview.localhost`, // single dash
    `p-${LABEL}--${TUNNEL.slice(1)}.preview.localhost`, // 31 hex
    `p-${LABEL}--${TUNNEL_HYPHENATED}.preview.localhost`, // hyphenated uuid is not what the broker routes
    `p-${LABEL}--${TUNNEL}`, // no domain
    `x.p-${LABEL}--${TUNNEL}.preview.localhost`, // not the first label
    `${TUNNEL_HYPHENATED}.tunnel.instafy.dev`, // a public tunnel host
    "localhost:4180",
  ]) {
    assert.equal(previewTunnelOf(bad), null, bad);
  }
  assert.ok(PREVIEW_HOST_RE.test(capHost()));
  assert.deepEqual(previewHostParts(capHost()), { tunnel: TUNNEL, suffix: SUFFIX });
});

test("previewTunnelReader returns the previews the CLI opened for one port and follows file changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-preview-state-"));
  const file = path.join(dir, "cli-preview-state.json");
  try {
    const read = previewTunnelReader(file);
    assert.deepEqual([...read(4180)], [], "no file yet");
    writeState(file, [
      { previewId: TUNNEL_HYPHENATED, localPort: 4180, hostSuffix: SUFFIX, studioOrigin: "http://localhost:5174" },
      { previewId: OTHER_TUNNEL, localPort: 4181, hostSuffix: "preview.instafy.dev", studioOrigin: "https://instafy.dev/studio" },
      { previewId: "not-a-uuid", localPort: 4180, hostSuffix: SUFFIX },
      { previewId: "11111111111111111111111111111111", localPort: 4180 }, // an older CLI: no domain recorded
      { previewId: "22222222222222222222222222222222", localPort: 4180, hostSuffix: "bad/suffix" },
      null,
    ]);
    const flat = (m) => [...m].map(([id, s]) => [id, [...s].map(([suffix, studios]) => [suffix, [...studios]])]);
    assert.deepEqual(flat(read(4180)), [[TUNNEL, [[SUFFIX, ["http://localhost:5174"]]]]]);
    assert.deepEqual(flat(read(4181)), [[OTHER_TUNNEL, [["preview.instafy.dev", []]]]], "a Studio origin with a path is no origin");
    fs.writeFileSync(file, "{ broken");
    assert.deepEqual([...read(4180)], [], "an unreadable file trusts nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--preview: no token; localhost and this port's preview capability host are served, intents work same-origin", async () => {
  const dir = site();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-preview-state-"));
  const stateFile = path.join(stateDir, "cli-preview-state.json");
  const binder = await startBinder(dir, { preview: true, previewStateFile: stateFile });
  const port = Number(new URL(binder.url).port);
  try {
    assert.equal(binder.sites[0].token, null, "preview mode has no viewer token");
    assert.equal(binder.shareUrl(binder.sites[0]), `${binder.url}/`, "no #k= in the printed URL");

    // localhost works at once (the CLI's probe, Octo's own checks).
    assert.equal((await intent(port, `127.0.0.1:${port}`)).status, 202);
    assert.equal((await intent(port, `localhost:${port}`)).status, 202);
    const probe = await raw(port, { method: "HEAD", headers: { host: "localhost" } });
    assert.equal(probe.status, 200, "the broker's health probe sends Host: localhost without a port");

    // The capability host is refused until `instafy preview open` records the preview for this port...
    assert.equal((await intent(port, capHost())).status, 421);
    writeState(stateFile, [{ previewId: TUNNEL_HYPHENATED, localPort: port, hostSuffix: SUFFIX }]);
    // ...and accepted after (the state file is written after serve starts).
    const ok = await intent(port, capHost());
    assert.equal(ok.status, 202, ok.text);
    const page = await raw(port, { headers: { host: capHost() } });
    assert.equal(page.status, 200);
    assert.match(page.text, /hello/);
    assert.equal(page.headers["content-security-policy"], undefined, "no Studio origin recorded: Studio may still show it...");
    const unpinned = JSON.parse((await raw(port, { path: "/__bind/health", headers: { host: capHost() } })).text);
    assert.deepEqual(unpinned.parentOrigins, [], "...but no frame may talk to the page (no asks, location or follow)");
    const local = await raw(port, { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(
      local.headers["content-security-policy"],
      "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*",
      "loopback names keep frame-ancestors but let a loopback page frame them (instafy preview check)",
    );
    const health = JSON.parse((await raw(port, { path: "/__bind/health", headers: { host: capHost() } })).text);
    assert.equal(health.token, false);
    assert.equal(health.viewer, true);
    const events = await raw(port, { path: "/__bind/events", headers: { host: capHost(), accept: "text/event-stream" } });
    assert.equal(events.status, 200, "SSE needs no token on the capability host");
    assert.equal((await raw(port, { path: "/__bind/records", headers: { host: capHost() } })).status, 200);

    // Same-origin is still required for intents.
    assert.equal((await intent(port, capHost(), `http://${capHost(OTHER_TUNNEL)}`)).status, 403);
    assert.equal((await intent(port, capHost(), "https://evil.example")).status, 403);
  } finally {
    await binder.close();
    cleanup(dir);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("--preview: on the capability host only the Studio that opened the preview may frame and talk to the page", async () => {
  const dir = site();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-preview-state-"));
  const stateFile = path.join(stateDir, "cli-preview-state.json");
  const binder = await startBinder(dir, { preview: true, previewStateFile: stateFile });
  const port = Number(new URL(binder.url).port);
  try {
    writeState(stateFile, [{ previewId: TUNNEL, localPort: port, hostSuffix: SUFFIX, studioOrigin: "http://localhost:5174" }]);
    const page = await raw(port, { headers: { host: capHost() } });
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], "frame-ancestors 'self' http://localhost:5174");
    const health = JSON.parse((await raw(port, { path: "/__bind/health", headers: { host: capHost() } })).text);
    assert.deepEqual(health.parentOrigins, ["http://localhost:5174"], "the client hosts only this origin");
    const hello = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/__bind/events", headers: { host: capHost(), accept: "text/event-stream" } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (/"type":"hello"[^\n]*\n/.test(text)) { req.destroy(); resolve(text); }
        });
      });
      req.on("error", reject);
      req.end();
    });
    assert.match(hello, /"parentOrigins":\["http:\/\/localhost:5174"\]/, "hello carries the same list");
    // a loopback name of the same binder is not the preview: no Studio origin there
    const local = JSON.parse((await raw(port, { path: "/__bind/health", headers: { host: `127.0.0.1:${port}` } })).text);
    assert.deepEqual(local.parentOrigins, []);
  } finally {
    await binder.close();
    cleanup(dir);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("--preview: commands and confirmations need the binder's loopback address, even with the admin token", async () => {
  const dir = site();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-preview-state-"));
  const stateFile = path.join(stateDir, "cli-preview-state.json");
  const binder = await startBinder(dir, { preview: true, previewStateFile: stateFile });
  const port = Number(new URL(binder.url).port);
  writeState(stateFile, [{ previewId: TUNNEL_HYPHENATED, localPort: port, hostSuffix: SUFFIX }]);
  const admin = (endpoint, host, extra = {}) =>
    raw(port, {
      method: "POST",
      path: `/__bind/${endpoint}`,
      headers: { host, "content-type": "application/json", authorization: `Bearer ${binder.adminToken}`, ...extra },
      body: JSON.stringify(endpoint === "command" ? { name: "toast", args: { text: "hi" } } : { job: "all" }),
    });
  try {
    for (const endpoint of ["command", "confirm"]) {
      const remote = await admin(endpoint, capHost());
      assert.equal(remote.status, 403, `${endpoint} through the preview capability host: ${remote.text}`);
      assert.equal((await admin(endpoint, `127.0.0.1:${port}`, { "x-forwarded-for": "203.0.113.9" })).status, 403, `${endpoint} through a proxy`);
    }
    assert.equal((await admin("command", `127.0.0.1:${port}`)).status, 202, "the local CLI still works");
    assert.equal((await admin("confirm", `localhost:${port}`)).status, 404, "nothing waiting, but accepted locally");
  } finally {
    await binder.close();
    cleanup(dir);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("--preview refuses every other Host: public tunnels, other previews, other ports, look-alikes", async () => {
  const dir = site();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-preview-state-"));
  const stateFile = path.join(stateDir, "cli-preview-state.json");
  const binder = await startBinder(dir, { preview: true, previewStateFile: stateFile });
  const port = Number(new URL(binder.url).port);
  writeState(stateFile, [
    { previewId: TUNNEL_HYPHENATED, localPort: port, hostSuffix: SUFFIX },
    { previewId: OTHER_TUNNEL, localPort: port + 1, hostSuffix: SUFFIX },
  ]);
  try {
    const refused = [
      `${TUNNEL_HYPHENATED}.tunnel.instafy.dev`, // `instafy tunnel` on the same port: public, no forwardAuth
      capHost(OTHER_TUNNEL), // a preview opened for another port
      capHost("00000000000000000000000000000000"), // a preview this runtime never opened (DNS rebinding)
      `p-${LABEL}--${TUNNEL}evil.example`, // look-alike without the dot
      `p-ABC--${TUNNEL}.preview.localhost`,
      `rebind.attacker.example:${port}`,
      `localhost:${port + 1}`,
      // DNS rebinding with the known preview id: any label, the attacker's own domain or port (the id is not secret)
      `p-${"a".repeat(26)}--${TUNNEL}.attacker.example:${port}`,
      capHost(TUNNEL, "attacker.example"),
      capHost(TUNNEL, `${SUFFIX.split(":")[0]}.attacker.example:8083`),
      capHost(TUNNEL, "preview.localhost:8084"),
      capHost(TUNNEL, "preview.localhost"),
    ];
    for (const host of refused) {
      assert.equal((await raw(port, { headers: { host } })).status, 421, `GET with Host ${host}`);
      assert.equal((await intent(port, host)).status, 421, `intent with Host ${host}`);
      assert.equal((await raw(port, { path: "/__bind/records", headers: { host } })).status, 421, `records with Host ${host}`);
      assert.equal((await raw(port, { path: "/__bind/events", headers: { host, accept: "text/event-stream" } })).status, 421, `events with Host ${host}`);
    }
    // A preview recorded without its domain (an older CLI) is not accepted on any domain.
    writeState(stateFile, [{ previewId: TUNNEL_HYPHENATED, localPort: port }]);
    assert.equal((await intent(port, capHost())).status, 421);
  } finally {
    await binder.close();
    cleanup(dir);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("--preview --public-url: the public tunnel the user asked for needs the viewer token; the card stays tokenless", async () => {
  const dir = site();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-preview-state-"));
  const binder = await startBinder(dir, { preview: true, previewStateFile: path.join(stateDir, "none.json"), publicOrigins: ["https://abc123.tunnel.example"] });
  const port = Number(new URL(binder.url).port);
  try {
    assert.equal((await intent(port, "abc123.tunnel.example", "https://abc123.tunnel.example")).status, 401, "no token, no checks for strangers");
    const s = binder.sites[0];
    const withToken = await raw(port, {
      method: "POST", path: "/__bind/intent",
      headers: { host: "abc123.tunnel.example", origin: "https://abc123.tunnel.example", "content-type": "application/json", "x-bind-token": s.token },
      body: JSON.stringify(intentMessage("hello", { name: "kim" })),
    });
    assert.equal(withToken.status, 202, withToken.text);
    assert.equal((await raw(port, { path: "/bound.json", headers: { host: "abc123.tunnel.example" } })).status, 401);
    const health = JSON.parse((await raw(port, { path: "/__bind/health", headers: { host: "abc123.tunnel.example" } })).text);
    assert.equal(health.token, true);
    // the loopback names (and the preview card) stay tokenless
    assert.equal((await intent(port, `127.0.0.1:${port}`)).status, 202);
    assert.equal(binder.shareUrl(s), `${binder.url}/`, "the local URL carries no token");
    assert.equal(binder.shareUrl(s, "https://abc123.tunnel.example"), `https://abc123.tunnel.example/#k=${s.token}`, "the public link does");
    assert.equal((await intent(port, "other.tunnel.example", "https://other.tunnel.example")).status, 421);
  } finally {
    await binder.close();
    cleanup(dir);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("--preview only listens on loopback; without it capability hosts are not special", async () => {
  const dir = site();
  try {
    await assert.rejects(startBinder(dir, { preview: true, host: "0.0.0.0" }), /--preview is only allowed when serving on localhost/);
    // --no-token (no preview) never accepts a capability host, even one the CLI recorded.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-preview-state-"));
    const stateFile = path.join(stateDir, "cli-preview-state.json");
    const binder = await startBinder(dir, { noToken: true, previewStateFile: stateFile });
    const port = Number(new URL(binder.url).port);
    writeState(stateFile, [{ previewId: TUNNEL, localPort: port, hostSuffix: SUFFIX }]);
    try {
      assert.equal((await intent(port, capHost())).status, 421);
    } finally {
      await binder.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  } finally {
    cleanup(dir);
  }
});

test("serve --preview --json prints the instafy preview open command and no token", async () => {
  const dir = site();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bind-preview-home-"));
  const child = spawn(process.execPath, [BIN, "serve", dir, "--port", "0", "--preview", "--json"], { env: { PATH: process.env.PATH, HOME: home } });
  let out = "";
  try {
    const listening = await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const line = out.split("\n").find((l) => l.includes('"listening"'));
        if (line) resolve(JSON.parse(line));
      });
      child.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
      setTimeout(() => reject(new Error(`serve printed no listening event: ${out}`)), 10_000).unref();
    });
    const port = new URL(listening.url).port;
    assert.equal(listening.preview, true);
    assert.doesNotMatch(listening.sites[0].url, /[#?]k=/);
    assert.equal(listening.sites[0].preview_command, `instafy preview open --port ${port} --title "Hello"`);
    // The binder reads the CLI's state under the same HOME.
    fs.mkdirSync(path.join(home, ".instafy"), { recursive: true });
    writeState(path.join(home, ".instafy", "cli-preview-state.json"), [{ previewId: TUNNEL_HYPHENATED, localPort: Number(port), hostSuffix: SUFFIX }]);
    assert.equal((await intent(Number(port), capHost())).status, 202);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.on("exit", resolve)));
    cleanup(dir);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
