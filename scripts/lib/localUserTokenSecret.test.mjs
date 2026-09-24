import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureLocalUserTokenSecret,
  MIN_USER_TOKEN_SECRET_BYTES,
} from "./localUserTokenSecret.mjs";

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-user-token-secret-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("an explicit USER_TOKEN_SECRET wins and nothing is written", (t) => {
  const filePath = path.join(makeTempRoot(t), "tmp", "user-token-secret");

  assert.equal(
    ensureLocalUserTokenSecret({ explicit: "  operator-supplied  ", filePath }),
    "operator-supplied"
  );
  assert.equal(fs.existsSync(filePath), false);
});

test("generates a strong owner-only secret once and reuses it", (t) => {
  const filePath = path.join(makeTempRoot(t), "tmp", "user-token-secret");

  const first = ensureLocalUserTokenSecret({ explicit: "", filePath });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, "dev-user-token-secret");
  assert.equal(fs.readFileSync(filePath, "utf-8"), `${first}\n`);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }

  assert.equal(ensureLocalUserTokenSecret({ explicit: undefined, filePath }), first);
});

test("replaces a stored value the controller would refuse", (t) => {
  const filePath = path.join(makeTempRoot(t), "user-token-secret");
  fs.writeFileSync(filePath, "dev-user-token-secret\n", { mode: 0o644 });

  const secret = ensureLocalUserTokenSecret({ explicit: "", filePath });
  assert.ok(Buffer.byteLength(secret) >= MIN_USER_TOKEN_SECRET_BYTES);
  assert.equal(fs.readFileSync(filePath, "utf-8"), `${secret}\n`);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});

test("still returns a usable secret when it cannot be persisted", (t) => {
  const root = makeTempRoot(t);
  const blocker = path.join(root, "not-a-directory");
  fs.writeFileSync(blocker, "");
  const warnings = [];

  const secret = ensureLocalUserTokenSecret({
    explicit: "",
    filePath: path.join(blocker, "user-token-secret"),
    warn: (message) => warnings.push(message),
  });
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes(secret), false);
});
