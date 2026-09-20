import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateKeys, repositoryRoot } from "./fixtures.mjs";
import { normalizePem, pemFingerprint, verifyTrustAnchor } from "./verify-public-bytes.mjs";

const putImmutable = path.join(import.meta.dirname, "put-immutable.sh");
const proveWebLayer = path.join(import.meta.dirname, "prove-web-layer.sh");
const SHA = "8ddffed21d44e19969ba0715fb879b4dced434b9";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ota-shell-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A fake wrangler backed by a directory: `r2 object get|put --remote <bucket/key> --file <f>`.
function fakeWrangler(root, { getError } = {}) {
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  const bin = path.join(root, "wrangler");
  const log = path.join(root, "calls.log");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> ${JSON.stringify(log)}
op="$3"; key="$5"; file="$7"
target=${JSON.stringify(store)}/"$(printf '%s' "$key" | tr '/' '_')"
if [[ "$op" == "get" ]]; then
  ${getError ? `echo ${JSON.stringify(getError)} >&2; exit 1` : `if [[ -f "$target" ]]; then cp "$target" "$file"; exit 0; fi
  echo "The specified key does not exist." >&2; exit 1`}
fi
cp "$file" "$target"
`,
  );
  fs.chmodSync(bin, 0o755);
  return { bin, store, log };
}

function runPut(wrangler, args) {
  return spawnSync("bash", [putImmutable, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, WRANGLER: wrangler.bin, DOWNLOADS_BUCKET: "instafy-downloads" },
  });
}

test("put-immutable uploads when absent and reuses byte-identical objects", (t) => {
  const root = tempRoot(t);
  const wrangler = fakeWrangler(root);
  const file = path.join(root, "ota-v8ddffed21d44.zip");
  fs.writeFileSync(file, "zip-bytes");
  const first = runPut(wrangler, [file, "mobile/ota-v8ddffed21d44.zip", "application/zip"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Uploaded mobile\/ota-v8ddffed21d44\.zip/u);
  const calls = fs.readFileSync(wrangler.log, "utf8");
  assert.match(calls, /r2 object put --remote instafy-downloads\/mobile\/ota-v8ddffed21d44\.zip --file .* --content-type application\/zip --cache-control public, max-age=31536000, immutable/u);
  const again = runPut(wrangler, [file, "mobile/ota-v8ddffed21d44.zip", "application/zip"]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /Reusing byte-identical/u);
});

test("put-immutable refuses different bytes and unprovable absence", (t) => {
  const root = tempRoot(t);
  const wrangler = fakeWrangler(root);
  const file = path.join(root, "a.zip");
  fs.writeFileSync(file, "one");
  assert.equal(runPut(wrangler, [file, "mobile/a.zip", "application/zip"]).status, 0);
  fs.writeFileSync(file, "two");
  const changed = runPut(wrangler, [file, "mobile/a.zip", "application/zip"]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /Refusing to overwrite immutable mobile\/a\.zip/u);

  const other = path.join(root, "other");
  fs.mkdirSync(other);
  const broken = fakeWrangler(other, { getError: "Authentication error [code: 10000]" });
  const unknown = runPut(broken, [file, "mobile/b.zip", "application/zip"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /Unable to prove mobile\/b\.zip is absent/u);
  assert.doesNotMatch(fs.readFileSync(broken.log, "utf8"), /object put/u);

  assert.equal(runPut(wrangler, [file, "mobile/a.yml", "text/yaml"]).status, 2);
});

function webLayer(root, files) {
  const dist = path.join(root, "dist");
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dist, name)), { recursive: true });
    fs.writeFileSync(path.join(dist, name), body);
  }
  return dist;
}

const prove = (dist, sha = SHA) => spawnSync("bash", [proveWebLayer, dist, sha], { encoding: "utf8" });

test("prove-web-layer prints a stable inventory for an exact web layer", (t) => {
  const root = tempRoot(t);
  const dist = webLayer(root, { "index.html": `<meta content="${SHA}">`, "assets/app.js": "1" });
  const first = prove(dist);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout.trim(), /^[0-9a-f]{64}$/u);
  assert.equal(prove(dist).stdout, first.stdout);
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "2");
  assert.notEqual(prove(dist).stdout, first.stdout);
});

test("prove-web-layer refuses inexact, native, hidden, executable or secret-bearing layers", (t) => {
  const root = tempRoot(t);
  const base = { "index.html": `<meta content="${SHA}">` };
  const cases = [
    [{ "index.html": "<html>" }, /does not carry the release commit/u],
    [{ ...base, "lib/native.so": "x" }, /native or executable/u],
    [{ ...base, ".env": "A=1" }, /hidden path/u],
    [{ ...base, "a.js": ["sb", "secret", "abc"].join("_") }, /secret key/u],
  ];
  cases.forEach(([files, message], index) => {
    const dist = webLayer(path.join(root, String(index)), files);
    const result = prove(dist);
    assert.equal(result.status, 1, `${index}`);
    assert.match(result.stderr, message);
  });
  const exec = webLayer(path.join(root, "exec"), { ...base, "run.js": "x" });
  fs.chmodSync(path.join(exec, "run.js"), 0o755);
  assert.match(prove(exec).stderr, /native or executable/u);
  const linked = webLayer(path.join(root, "link"), base);
  fs.symlinkSync("index.html", path.join(linked, "alias.html"));
  assert.match(prove(linked).stderr, /symbolic link/u);
  assert.equal(prove(webLayer(path.join(root, "sha"), base), "HEAD").status, 1);
});

test("the trust-anchor fingerprint equals the resolver's public_key_sha256", (t) => {
  const root = tempRoot(t);
  const keys = generateKeys();
  const output = path.join(root, "github-output");
  const githubEnv = path.join(root, "github-env");
  const derived = crypto.createPublicKey(keys.privateKeyPem).export({ format: "pem", type: "spki" }).toString();
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", "resolve-live-update-public-key.mjs"), "--require-private-key"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: githubEnv,
      OTA_SIGNING_PRIVATE_KEY: keys.privateKeyPem,
      CAPACITOR_LIVE_UPDATE_PUBLIC_KEY: derived.trim().replace(/\n/g, "\\n"),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const resolverSha = /public_key_sha256<<(EOF_[0-9a-f]+)\n([0-9a-f]{64})\n\1/u.exec(fs.readFileSync(output, "utf8"))[2];
  assert.equal(verifyTrustAnchor({ publicKeyPem: derived.trim().replace(/\n/g, "\\n"), expectedSha256: resolverSha }), resolverSha);
  assert.equal(pemFingerprint(normalizePem(derived)), resolverSha);
  assert.doesNotMatch(fs.readFileSync(output, "utf8") + fs.readFileSync(githubEnv, "utf8"), /PRIVATE KEY/u);
});
