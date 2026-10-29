import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBound } from "../src/bound.mjs";
import { openSse } from "./helpers.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");
const cleanEnv = { PATH: process.env.PATH, HOME: os.tmpdir() };

test("init, doctor, serve --json, command and a clean shutdown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-cli-"));
  try {
    execFileSync(process.execPath, [BIN, "init", dir], { env: cleanEnv });
    const bound = JSON.parse(fs.readFileSync(path.join(dir, "bound.json"), "utf8"));
    assert.deepEqual(checkBound(bound), []);
    assert.ok(fs.existsSync(path.join(dir, "handlers/hello.mjs")));
    assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /__bind\/client\.js/);
    const again = execFileSync(process.execPath, [BIN, "init", dir], { env: cleanEnv, encoding: "utf8" });
    assert.match(again, /kept/, "init keeps existing files");

    const doctor = execFileSync(process.execPath, [BIN, "doctor", dir], { env: cleanEnv, encoding: "utf8" });
    assert.match(doctor, /ok {4}.*hello -> script handlers\/hello\.mjs/);
    // Ask Octo needs no login (Studio sends it as the clicker); only --agent-executor checks the owner's.
    assert.match(doctor, /Ask Octo: clicks go through Studio as the clicker's own message/);
    assert.doesNotMatch(doctor, /controller|access token/);
    const owner = execFileSync(process.execPath, [BIN, "doctor", dir, "--agent-executor"], { env: cleanEnv, encoding: "utf8" });
    assert.match(owner, /no Instafy access token/);

    const child = spawn(process.execPath, [BIN, "serve", dir, "--port", "0", "--json", "--dry-run"], { env: cleanEnv });
    let out = "";
    const listening = await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const line = out.split("\n").find((l) => l.includes('"listening"'));
        if (line) resolve(JSON.parse(line));
      });
      child.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
    });
    try {
      assert.equal(listening.agent, "dry_run");
      const share = listening.sites[0].url;
      assert.match(share, /#k=[A-Za-z0-9_-]{16,}/);
      assert.ok(!out.includes(fs.readFileSync(path.join(dir, ".bind/admin-token"), "utf8").trim()), "the admin token is never printed");
      const token = share.split("#k=")[1];
      const sse = openSse(`${listening.url}/__bind/events?k=${token}`);
      await sse.opened;
      const result = execFileSync(process.execPath, [BIN, "command", dir, "select", '{"ref":"greetings:kim"}'], { env: cleanEnv, encoding: "utf8" });
      assert.match(result, /"ok":true/);
      const event = await sse.waitFor((e) => e.event === "command");
      assert.deepEqual(event.data.command, { name: "select", args: { ref: "greetings:kim" } });
      sse.close();
      assert.throws(() => execFileSync(process.execPath, [BIN, "command", dir, "rm", "{}"], { env: cleanEnv, stdio: "pipe" }), /unknown command/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
    }
    assert.equal(fs.existsSync(path.join(dir, ".bind/server.json")), false, "server.json is removed on exit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor warns about a site whose every intent is agent-only (its buttons only work where Instafy sends asks)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-cli-agent-only-"));
  try {
    execFileSync(process.execPath, [BIN, "init", dir], { env: cleanEnv });
    const withScript = execFileSync(process.execPath, [BIN, "doctor", dir], { env: cleanEnv, encoding: "utf8" });
    assert.doesNotMatch(withScript, /no script intent/, "the starter has a script intent");
    const bound = JSON.parse(fs.readFileSync(path.join(dir, "bound.json"), "utf8"));
    for (const [name, def] of Object.entries(bound.intents)) {
      if (!def.agent) delete bound.intents[name];
    }
    assert.ok(Object.keys(bound.intents).length > 0, "the starter has an agent intent");
    fs.writeFileSync(path.join(dir, "bound.json"), JSON.stringify(bound, null, 2));
    const agentOnly = execFileSync(process.execPath, [BIN, "doctor", dir], { env: cleanEnv, encoding: "utf8" });
    assert.match(agentOnly, /warn.*no script intent: agent intents are "Ask Octo" buttons that only work where Instafy can send them as the clicker's message/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serve --detach keeps serving after the command (and the turn that ran it) ends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-cli-detach-"));
  const log = path.join(dir, "bind.log");
  const port = 4900 + Math.floor(Math.random() * 90);
  let pid = null;
  try {
    execFileSync(process.execPath, [BIN, "init", path.join(dir, "site")], { env: cleanEnv });
    const out = execFileSync(process.execPath, [BIN, "serve", path.join(dir, "site"), "--port", String(port), "--preview", "--dry-run", "--detach", "--log", log],
      { env: cleanEnv, encoding: "utf8", timeout: 30_000 });
    assert.match(out, /in the background \(pid \d+; log .*bind\.log\); it keeps running after this turn/);
    assert.match(out, /show it in Studio: instafy preview open --port/);
    pid = Number(out.match(/pid (\d+)/)[1]);
    // The command has exited; the binder still answers.
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(fs.readFileSync(log, "utf8"), /instafy-bind serving/);
  } finally {
    if (pid) try { process.kill(pid, "SIGTERM"); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs the binder's CLI without blocking this process (a server in this process must keep answering meanwhile). */
function runBin(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("serve --detach takes only its own binder's answer: another server on the port is never this site being served", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-cli-detach-taken-"));
  const log = path.join(dir, "bind.log");
  // Another site's server already holds the port. It answers every path, __bind/health included, as a dev server's
  // fallback page or another binder does.
  const seen = [];
  const other = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, host: "instafy-bind" }));
  });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const port = other.address().port;
  try {
    execFileSync(process.execPath, [BIN, "init", path.join(dir, "site")], { env: cleanEnv });
    const result = await runBin(["serve", path.join(dir, "site"), "--port", String(port), "--preview", "--dry-run", "--detach", "--log", log]);
    assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, new RegExp(`port ${port} is in use by another server, so .*site is not served there`));
    assert.doesNotMatch(result.stdout, /in the background/);
    assert.ok(seen.includes("/__bind/health"), "the other server was asked, and its answer was not taken");
    // The other server still has its port.
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    await new Promise((resolve) => other.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a binder's health names its folder and process only to this machine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-cli-health-"));
  const { createBinder } = await import("../src/server.mjs");
  execFileSync(process.execPath, [BIN, "init", dir], { env: cleanEnv });
  const binder = createBinder({ root: dir, port: 0, env: {}, publicOrigins: ["https://site.tunnel.test"], log: () => {} });
  await binder.listen();
  try {
    const port = new URL(binder.url).port;
    const health = (host) =>
      new Promise((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/__bind/health", headers: { host } }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(JSON.parse(body)));
        });
        req.on("error", reject);
      });
    const local = await health(`127.0.0.1:${port}`);
    assert.deepEqual(local.binder, { root: path.resolve(dir), pid: process.pid });
    // A tunnel's client connects from this machine too, but keeps the viewer's host: nothing about this machine.
    const viewer = await health("site.tunnel.test");
    assert.equal(viewer.ok, true);
    assert.equal(viewer.binder, undefined);
  } finally {
    await binder.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serve --detach keeps credentials the binder does not need out of the long-lived binder's environment", async () => {
  const { detachedBinderEnv, resolveControllerConfig, agentUnavailableReason } = await import("../src/config.mjs");
  const base = {
    PATH: "/bin", HOME: "/root", LANG: "C", STEP_MS: "5", SPACE_ID: "s", INSTAFY_CONVERSATION_ID: "c", RUNTIME_ID: "r",
    CONTROLLER_BASE_URL: "https://ctl.example", CONTROLLER_ACCESS_TOKEN: "job-token", CONTROLLER_INTERNAL_SECRET: "x",
    SUPABASE_SERVICE_ROLE_KEY: "svc", STRIPE_API_KEY: "sk", GITHUB_TOKEN: "g", DB_PASSWORD: "p", WEATHER_KEY: "w",
    INSTAFY_ACCESS_TOKEN: "owner-login",
  };
  const env = detachedBinderEnv(base, ["WEATHER_KEY"]);
  // Ask Octo goes through Studio, so by default the binder keeps no Instafy login at all.
  assert.deepEqual(Object.keys(env).sort(), [
    "CONTROLLER_BASE_URL", "HOME", "INSTAFY_CONVERSATION_ID", "LANG", "PATH", "RUNTIME_ID", "SPACE_ID", "STEP_MS", "WEATHER_KEY",
  ]);
  // Only --agent-executor, the owner's opt-in to dispatch Octo turns, keeps the owner's login.
  assert.deepEqual(Object.keys(detachedBinderEnv(base, ["WEATHER_KEY"], { keepLogin: true })).sort(), [
    "CONTROLLER_BASE_URL", "HOME", "INSTAFY_ACCESS_TOKEN", "INSTAFY_CONVERSATION_ID", "LANG", "PATH", "RUNTIME_ID", "SPACE_ID", "STEP_MS", "WEATHER_KEY",
  ]);
  // Without the job token the binder still knows it runs in a runtime and says why agent intents are off.
  const config = resolveControllerConfig({ env, cwd: os.tmpdir(), home: fs.mkdtempSync(path.join(os.tmpdir(), "bind-home-")) });
  assert.equal(config.tokenSource, "runtime-refused");
  assert.match(agentUnavailableReason(config), /runtime job token/);
  const source = fs.readFileSync(BIN, "utf8");
  assert.match(source, /env: detachedBinderEnv\(process\.env, \[\]\.concat\(flags\["allow-env"\] \|\| \[\]\), \{ keepLogin: Boolean\(flags\["agent-executor"\]\) \}\)/, "serveDetached must not pass process.env through, nor the login without --agent-executor");
});
