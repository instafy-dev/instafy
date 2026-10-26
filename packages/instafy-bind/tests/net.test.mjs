import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { MAX_HEADER_BYTES, checkPublicUrl, checkUriParams, isLocalHostName, isPrivateAddress, originAllowed, safeFetch } from "../src/net.mjs";

test("isPrivateAddress covers loopback, private, link-local, CGNAT, mapped and reserved ranges", () => {
  const blocked = [
    "127.0.0.1", "127.255.0.9", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "64:ff9b:1::a9fe:a9fe", "64:ff9b:1::808:808", "::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "ff02::1", "2001:db8::1", "not-an-ip",
    "2002:7f00:1::1", "2002:0a00:0001::", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  ];
  for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip);
  const allowed = ["8.8.8.8", "93.184.215.14", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:0808:0808::1", "2001:4860::8888"];
  for (const ip of allowed) assert.equal(isPrivateAddress(ip), false, ip);
});

test("checkPublicUrl: schemes, credentials, local names, literal IPs and DNS answers", async () => {
  const lookup = async (host) => (host === "rebind.example" ? [{ address: "8.8.8.8" }, { address: "10.0.0.5" }] : [{ address: "93.184.215.14" }]);
  assert.equal((await checkPublicUrl("https://shop.example/a", { lookup })).ok, true);
  for (const url of ["ftp://x.example", "file:///etc/passwd", "https://user:pw@x.example", "http://localhost:3000", "http://printer.local", "http://intranet",
    "http://127.0.0.1", "http://[::1]:8080", "http://2130706433/", "http://0x7f.1/", "https://rebind.example"]) {
    const result = await checkPublicUrl(url, { lookup });
    assert.equal(result.ok, false, url);
  }
  assert.equal((await checkPublicUrl("http://127.0.0.1", { allowLocal: true })).ok, true);
  assert.equal((await checkPublicUrl("file:///etc/passwd", { allowLocal: true })).ok, false, "--allow-local never allows non-http schemes");
  const failing = async () => {
    throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
  };
  assert.match((await checkPublicUrl("https://nx.example", { lookup: failing })).reason, /does not resolve/);
});

test("checkUriParams only checks format: uri params", async () => {
  const schema = { type: "object", properties: { url: { type: "string", format: "uri" }, note: { type: "string" } } };
  assert.equal(await checkUriParams(schema, { note: "http://127.0.0.1" }), null);
  assert.match(await checkUriParams(schema, { url: "http://127.0.0.1" }), /^url: /);
});

test("checkUriParams walks nested objects and arrays, and applies allowed_origins", async () => {
  const lookup = async () => [{ address: "93.184.215.14" }];
  const schema = {
    type: "object",
    properties: {
      pages: { type: "array", items: { type: "object", properties: { href: { type: "string", format: "uri" } } } },
      extra: { type: "object", additionalProperties: { type: "string", format: "uri" } },
    },
  };
  assert.match(await checkUriParams(schema, { pages: [{ href: "https://ok.example" }, { href: "http://10.0.0.1/" }] }, { lookup }), /^pages\[1\]\.href: /);
  assert.match(await checkUriParams(schema, { extra: { a: "http://[::1]/" } }, { lookup }), /^extra\.a: /);
  const allowedOrigins = ["https://*.shop.example"];
  assert.equal(await checkUriParams(schema, { pages: [{ href: "https://www.shop.example/a" }] }, { lookup, allowedOrigins }), null);
  assert.match(await checkUriParams(schema, { pages: [{ href: "https://attacker.example/x" }] }, { lookup, allowedOrigins }), /not in allowed_origins/);
});

test("safeFetch drops credential headers when a redirect changes origin, and answers like fetch", async () => {
  const seen = [];
  const second = http.createServer((req, res) => { seen.push(["second", req.headers.authorization, req.headers.cookie]); res.end("ok"); });
  await new Promise((resolve) => second.listen(0, "127.0.0.1", resolve));
  const first = http.createServer((req, res) => {
    seen.push(["first", req.headers.authorization]);
    res.writeHead(302, { location: `http://localhost:${second.address().port}/` });
    res.end();
  });
  await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
  try {
    const res = await safeFetch(`http://127.0.0.1:${first.address().port}/`, { allowLocal: true, headers: { Authorization: "Bearer x", Cookie: "a=1", accept: "text/plain" } });
    assert.equal(res.ok, true);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(seen, [["first", "Bearer x"], ["second", undefined, undefined]]);
  } finally {
    first.close();
    second.close();
  }
});

test("safeFetch refuses loopback, including through a redirect, unless allowLocal", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1/secret" });
      return res.end();
    }
    res.end("local secret");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(safeFetch(`${base}/`), (e) => e.code === "policy");
    const ok = await safeFetch(`${base}/`, { allowLocal: true });
    assert.equal(await ok.text(), "local secret");
    assert.equal(ok.ok, true);
    await assert.rejects(safeFetch(`http://localhost:${server.address().port}/`), (e) => e.code === "policy");
  } finally {
    server.close();
  }
});

test("safeFetch reads a page whose headers pass Node's 16 KB default, and names the site when a read fails", async () => {
  const big = http.createServer((req, res) => {
    res.writeHead(200, { "content-security-policy": `default-src 'self' ${"https://cdn.example.com ".repeat(1500)}`, "content-type": "text/html" });
    res.end("<p>$129.95</p>");
  });
  await new Promise((resolve) => big.listen(0, "127.0.0.1", resolve));
  const broken = net.createServer((socket) => socket.end("HTTP/1.1 200 OK\r\nX-Bad: " + "a".repeat(MAX_HEADER_BYTES + 10) + "\r\n\r\n"));
  await new Promise((resolve) => broken.listen(0, "127.0.0.1", resolve));
  try {
    const res = await safeFetch(`http://127.0.0.1:${big.address().port}/`, { allowLocal: true });
    assert.equal(res.ok, true);
    assert.match(await res.text(), /129\.95/);
    await assert.rejects(safeFetch(`http://127.0.0.1:${broken.address().port}/`, { allowLocal: true }),
      (e) => e.code === "upstream" && /^could not read 127\.0\.0\.1: /.test(e.message));
  } finally {
    big.close();
    broken.close();
  }
});

test("originAllowed matches allowed_origins patterns", () => {
  assert.equal(originAllowed("https://a.example/x", ["https://*"]), true);
  assert.equal(originAllowed("http://a.example/x", ["https://*"]), false);
  assert.equal(originAllowed("https://www.shop.example/a", ["https://*.shop.example"]), true);
  assert.equal(originAllowed("https://shop.example.evil.com/", ["https://*.shop.example"]), false);
  assert.equal(originAllowed("https://shop.example/", ["https://shop.example"]), true);
  assert.equal(originAllowed("https://shop.example:8443/", ["https://shop.example"]), false);
  assert.equal(originAllowed("not a url", ["https://*"]), false);
  assert.equal(originAllowed("https://x.example", undefined), true);
});

test("isLocalHostName names this machine and local networks, not public names", () => {
  for (const host of ["localhost", "app.localhost", "printer.local", "nas.lan", "intranet", "db.internal", "router.home"]) {
    assert.equal(isLocalHostName(host), true, host);
  }
  for (const host of ["example.com", "docs.example.test", "local.example.com"]) {
    assert.equal(isLocalHostName(host), false, host);
  }
});
