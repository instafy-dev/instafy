import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { downloadManagedUvInstallerArtifact } from "../scripts/download-speech-bootstrap-assets.mjs";

const execFileAsync = promisify(execFile);
const trustedContent = Buffer.from("#!/bin/sh\nexit 0\n");
const downloaderUrl = new URL("../scripts/download-speech-bootstrap-assets.mjs", import.meta.url);
const childScript = `
  import assert from 'node:assert/strict';
  import { getGlobalDispatcher } from 'undici';
  import { downloadManagedUvInstallerArtifact, downloadSpeechBootstrapAssets } from ${JSON.stringify(downloaderUrl.href)};
  const originalFetch = globalThis.fetch;
  const originalDispatcher = getGlobalDispatcher();
  let outcome;
  try {
    const { batch, ...options } = JSON.parse(process.argv[1]);
    outcome = { result: await (batch ? downloadSpeechBootstrapAssets : downloadManagedUvInstallerArtifact)(options) };
  } catch (error) {
    outcome = { error: error.message };
  }
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(getGlobalDispatcher(), originalDispatcher);
  console.log(JSON.stringify(outcome));
`;

async function fixture(t, handler, { tls = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "instafy-speech-proxy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let certificatePath;
  let tlsOptions;
  if (tls) {
    const certificateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "instafy-speech-test-ca-"));
    t.after(() => fs.rm(certificateRoot, { recursive: true, force: true }));
    certificatePath = path.join(certificateRoot, "certificate.pem");
    const keyPath = path.join(certificateRoot, "key.pem");
    // Generate ephemeral fixture material, never commit a private key. OpenSSL
    // is an explicit test prerequisite, not a downloader runtime dependency.
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=github.com", "-addext", "subjectAltName=DNS:github.com",
      "-keyout", keyPath, "-out", certificatePath,
    ], { timeout: 10_000, maxBuffer: 64 * 1024 });
    await fs.chmod(keyPath, 0o600);
    tlsOptions = { key: await fs.readFile(keyPath), cert: await fs.readFile(certificatePath) };
  }
  const sockets = new Set();
  const trackSocket = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  };
  const origin = tls ? https.createServer(tlsOptions, handler) : http.createServer(handler);
  const proxy = http.createServer((_request, response) => {
    response.writeHead(405).end();
  });
  const tunnels = [];
  proxy.on("connect", (request, client, head) => {
    tunnels.push(request.url);
    // The fixture never resolves or connects to the requested external hostname.
    const upstream = net.connect(origin.address().port, "127.0.0.1");
    trackSocket(upstream);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  for (const server of [origin, proxy]) {
    server.on("connection", trackSocket);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, proxy].map((server) =>
      new Promise((resolve) => server.close(resolve)),
    ));
  });
  const artifact = {
    fileName: "install.sh",
    platform: "posix",
    releaseFileName: "uv-installer.sh",
    sha256: createHash("sha256").update(trustedContent).digest("hex"),
    url: `http://127.0.0.1:${origin.address().port}/install.sh`,
    version: "test",
  };
  const target = path.join(directory, "vendor", "uv", "test", "install.sh");
  return {
    artifact, certificatePath, directory, sockets, target, tunnels,
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
  };
}

async function download(f, proxyEnv = {}, { batch = false } = {}) {
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module", "--eval", childScript,
    JSON.stringify({ artifact: f.artifact, outputRoot: f.directory, batch }),
  ], {
    cwd: new URL("..", import.meta.url),
    // No ambient proxy, credentials, NODE_OPTIONS, or NODE_USE_ENV_PROXY in the
    // child: these tests exercise the downloader itself, including on Node 20.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...proxyEnv },
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  // Natural child exit plus closed server sockets proves dispatcher cleanup,
  // before the fixture's emergency teardown can destroy anything.
  for (let attempt = 0; f.sockets.size && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(f.sockets.size, 0, "download left an open connection");
  return JSON.parse(stdout);
}

test("speech assets use a real CONNECT proxy, follow redirects, and keep global fetch unchanged", async (t) => {
  const requests = [];
  const f = await fixture(t, (request, response) => {
    requests.push(request.url);
    assert.equal(request.headers["cache-control"], "no-store");
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/install.sh" }).end();
    } else {
      response.end(trustedContent);
    }
  });
  f.artifact.url = "http://speech-assets.invalid/redirect";
  const outcome = await download(f, { HTTP_PROXY: f.proxyUrl });
  assert.equal(outcome.result.sha256, f.artifact.sha256);
  assert.deepEqual(await fs.readFile(f.target), trustedContent);
  assert.deepEqual(requests, ["/redirect", "/install.sh"]);
  assert.ok(f.tunnels.length > 0);
  assert.ok(f.tunnels.every((authority) => authority === "speech-assets.invalid:80"));
});

test("speech assets connect directly without proxy configuration", async (t) => {
  const f = await fixture(t, (_request, response) => response.end(trustedContent));
  const outcome = await download(f);
  assert.equal(outcome.result.sha256, f.artifact.sha256);
  assert.deepEqual(f.tunnels, []);
  assert.deepEqual(await fs.readFile(f.target), trustedContent);
});

test("lowercase no_proxy bypasses the configured proxy and uppercase NO_PROXY", async (t) => {
  const f = await fixture(t, (_request, response) => response.end(trustedContent));
  const outcome = await download(f, {
    HTTP_PROXY: f.proxyUrl,
    NO_PROXY: "not-the-origin.invalid",
    no_proxy: "127.0.0.1",
  });
  assert.equal(outcome.result.sha256, f.artifact.sha256);
  assert.deepEqual(f.tunnels, []);
});

test("lowercase http_proxy takes precedence over uppercase HTTP_PROXY", async (t) => {
  const f = await fixture(t, (_request, response) => response.end(trustedContent));
  f.artifact.url = "http://speech-assets.invalid/install.sh";
  assert.ok((await download(f, {
    HTTP_PROXY: "http://unused.invalid:1",
    http_proxy: f.proxyUrl,
  })).result);
});

test("HTTPS speech assets use CONNECT with certificate verification still enabled", async (t) => {
  const f = await fixture(t, (_request, response) => response.end(trustedContent), { tls: true });
  f.artifact.url = "https://github.com/fixture/install.sh";
  const proxyEnv = { HTTPS_PROXY: f.proxyUrl };
  // The same self-signed origin must fail until this child explicitly trusts
  // the ephemeral CA. No TLS-disable flag or global fetch patch is involved.
  assert.match((await download(f, proxyEnv)).error, /fetch failed/u);
  assert.deepEqual(await fs.readdir(f.directory), []);
  const outcome = await download(f, { ...proxyEnv, NODE_EXTRA_CA_CERTS: f.certificatePath });
  assert.equal(outcome.result.sha256, f.artifact.sha256);
  assert.deepEqual(await fs.readFile(f.target), trustedContent);
  assert.ok(f.tunnels.length >= 2);
  assert.ok(f.tunnels.every((authority) => authority === "github.com:443"));
});

test("batch integrity failure destroys an unfinished HTTPS sibling and its dispatcher", async (t) => {
  const responses = [];
  const f = await fixture(t, (_request, response) => {
    responses.push(response);
    if (responses.length === 2) {
      responses[1].writeHead(200);
      responses[1].write("unfinished sibling installer");
      responses[0].end("not the source-controlled installer bytes");
    }
  }, { tls: true });
  const outcome = await download(f, {
    HTTPS_PROXY: f.proxyUrl,
    NODE_EXTRA_CA_CERTS: f.certificatePath,
  }, { batch: true });
  assert.match(outcome.error, /integrity check failed/u);
  assert.equal(responses.length, 2, "both batch downloads must enter before failure");
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("proxy integrity failure preserves the prior installer and leaves no temporary files", async (t) => {
  const f = await fixture(t, (_request, response) => response.end("untrusted installer"));
  await fs.mkdir(path.dirname(f.target), { recursive: true });
  await fs.writeFile(f.target, trustedContent);
  f.artifact.url = "http://speech-assets.invalid/install.sh";
  const outcome = await download(f, { HTTP_PROXY: f.proxyUrl });
  assert.match(outcome.error, /integrity check failed/u);
  assert.deepEqual(await fs.readFile(f.target), trustedContent);
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), ["install.sh"]);
});

test("non-OK streaming responses are cancelled and release their CONNECT tunnel", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(503);
    response.write("unfinished error body");
  });
  f.artifact.url = "http://speech-assets.invalid/install.sh";
  const outcome = await download(f, { HTTP_PROXY: f.proxyUrl });
  assert.match(outcome.error, /Failed to download bundled uv installer \(503\)/u);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("truncated proxy responses release connections without publishing partial bytes", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-length": trustedContent.length + 100 });
    response.end(trustedContent);
    response.socket?.destroySoon();
  });
  f.artifact.url = "http://speech-assets.invalid/install.sh";
  const outcome = await download(f, { HTTP_PROXY: f.proxyUrl });
  assert.equal(typeof outcome.error, "string");
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("injected fetch retains ownership but non-OK response bodies are cancelled", async () => {
  let cancelled = 0;
  await assert.rejects(downloadManagedUvInstallerArtifact({
    artifact: { url: "https://speech-assets.invalid/install.sh" },
    fetchImpl: async (_url, init) => {
      assert.equal(init.dispatcher, undefined);
      return {
        ok: false,
        status: 502,
        body: { async cancel() { cancelled += 1; } },
        async arrayBuffer() { assert.fail("must not read the error body"); },
      };
    },
  }), /Failed to download bundled uv installer \(502\)/u);
  assert.equal(cancelled, 1);
});
