// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkUrl, isPrivateAddress, safeFetch } from "../handlers/lib/safe-fetch.mjs";
import * as pages from "./fixtures/pages.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(here, "..");
const handler = path.join(siteDir, "handlers", "read_offer.mjs");

function runHandler(params, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [handler], { cwd: siteDir, env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    child.stdin.end(JSON.stringify({ intent: { name: "read_offer", params, ref: params.ref }, bound: {}, site: { dir: siteDir } }));
  });
}

test("isPrivateAddress", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "224.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("checkUrl refuses non-https, credentials and local names", () => {
  assert.throws(() => checkUrl("http://example.com/"), /https/);
  assert.throws(() => checkUrl("ftp://example.com/"), /https/);
  assert.throws(() => checkUrl("https://user:pw@example.com/"), /credentials/);
  assert.throws(() => checkUrl("https://localhost/"), /Local/);
  assert.throws(() => checkUrl("https://printer.local/"), /Local/);
  assert.throws(() => checkUrl("https://127.0.0.1/"), /Private/);
  assert.throws(() => checkUrl("https://[::1]/"), /Private/);
  assert.ok(checkUrl("https://example.com/p"));
  assert.ok(checkUrl("http://127.0.0.1:9/p", { allowLocal: true }));
});

test("handler refuses loopback without --allow-local, and reads a local fixture with it", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/size" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/size" ? pages.offersPerSize : pages.noProduct);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const refused = await runHandler({ url: `${base}/size`, ref: "shoes:fixture" });
  assert.equal(refused.at(-1).type, "error");
  assert.equal(refused.at(-1).code, "policy");

  const ok = await runHandler({ url: `${base}/redirect`, ref: "shoes:fixture", size: "M10", attr: "size_10" }, { BIND_ALLOW_LOCAL: "1" });
  assert.deepEqual(ok.filter((l) => l.type === "progress").map((l) => l.step), [1, 2, 3]);
  const recs = ok.find((l) => l.type === "records").records;
  assert.equal(recs.find((r) => r.type === "offer").price.amount, 325);
  assert.equal(recs.find((r) => r.attr === "size_10").value, "In stock");
  assert.ok(recs.every((r) => r.prov.lane === "local"));
  assert.equal(ok.at(-1).type, "done");

  const none = await runHandler({ url: `${base}/none`, ref: "shoes:fixture" }, { BIND_ALLOW_LOCAL: "1" });
  assert.equal(none.at(-1).code, "not_found");
});

test("a seed ref is only read from its own store; unknown refs need --allow-local", async () => {
  const planted = await runHandler({ url: "https://fake-store.example/on", ref: "shoes:on-cloudmonster-2" });
  assert.equal(planted.at(-1).type, "error");
  assert.equal(planted.at(-1).code, "policy");
  assert.match(planted.at(-1).message, /on\.com only/);
  assert.ok(!planted.some((l) => l.type === "records"));
  const unknown = await runHandler({ url: "https://example.com/x", ref: "shoes:not-in-the-list" });
  assert.equal(unknown.at(-1).code, "policy");
  assert.match(unknown.at(-1).message, /not in data\/items\.json/);
});

test("safeFetch refuses loopback literals before connecting", async () => {
  await assert.rejects(safeFetch("https://127.0.0.1/"), /Private/);
  await assert.rejects(safeFetch("https://[::ffff:127.0.0.1]/"), /Private/);
});
