import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureLocalSecret } from "./localSecret.mjs";

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-local-secret-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("two secrets in one checkout are separate and each survives a restart", (t) => {
  const root = makeTempRoot(t);
  const first = ensureLocalSecret({ explicit: "", filePath: path.join(root, "a") });
  const second = ensureLocalSecret({ explicit: "", filePath: path.join(root, "b") });

  assert.notEqual(first, second);
  assert.equal(ensureLocalSecret({ explicit: "", filePath: path.join(root, "a") }), first);
  assert.equal(ensureLocalSecret({ explicit: "", filePath: path.join(root, "b") }), second);
});

test("a stored value shorter than the floor is replaced", (t) => {
  const filePath = path.join(makeTempRoot(t), "hook-secret");
  fs.writeFileSync(filePath, "short\n");

  const secret = ensureLocalSecret({ explicit: "", filePath, minBytes: 16 });
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(filePath, "utf-8"), `${secret}\n`);
});

test("the warning names the secret by its label, never its value", (t) => {
  const blocker = path.join(makeTempRoot(t), "not-a-directory");
  fs.writeFileSync(blocker, "");
  const warnings = [];

  const secret = ensureLocalSecret({
    explicit: "",
    filePath: path.join(blocker, "hook-secret"),
    label: "tunnel broker hook secret",
    warn: (message) => warnings.push(message),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tunnel broker hook secret/);
  assert.equal(warnings[0].includes(secret), false);
});
