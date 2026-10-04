import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureLocalAuthorPseudonymKeys,
  isValidAuthorPseudonymKeys,
} from "./localAuthorPseudonymKeys.mjs";

const KEY = Buffer.alloc(32, 0x11).toString("base64");
const NEXT_KEY = Buffer.alloc(32, 0x22).toString("base64");

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-author-keys-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("validates keyrings the way the controller does", () => {
  assert.equal(isValidAuthorPseudonymKeys(`v1:${KEY}`), true);
  assert.equal(isValidAuthorPseudonymKeys(` v1:${KEY} , v2:${NEXT_KEY} ,`), true);
  for (const invalid of [
    "",
    " , ",
    KEY,
    `v0:${KEY}`,
    `v01:${KEY}`,
    `v1:${KEY},v1:${NEXT_KEY}`,
    `v1:${KEY},v2:${KEY}`,
    `v1:${KEY.slice(0, -1)}`,
    // Non-canonical: the last character carries bits the key does not have.
    `v1:${KEY.slice(0, -2)}F=`,
    Array.from({ length: 65 }, (_, index) =>
      `v${index + 1}:${Buffer.alloc(32, index + 1).toString("base64")}`
    ).join(","),
    `v1:${Buffer.alloc(16, 1).toString("base64")}`,
    `v1:${Buffer.alloc(65, 1).toString("base64")}`,
    "v1:not*base64",
  ]) {
    assert.equal(isValidAuthorPseudonymKeys(invalid), false, invalid);
  }
});

test("an explicit keyring wins and nothing is written", (t) => {
  const filePath = path.join(makeTempRoot(t), "tmp", "author-pseudonym-keys");

  assert.equal(
    ensureLocalAuthorPseudonymKeys({ explicit: `  v3:${KEY}  `, filePath }),
    `v3:${KEY}`
  );
  assert.equal(fs.existsSync(filePath), false);
});

test("generates an owner-only keyring once and reuses it", (t) => {
  const filePath = path.join(makeTempRoot(t), "tmp", "author-pseudonym-keys");

  const first = ensureLocalAuthorPseudonymKeys({ explicit: "", filePath });
  assert.match(first, /^v1:[A-Za-z0-9+/]{43}=$/);
  assert.equal(isValidAuthorPseudonymKeys(first), true);
  assert.equal(fs.readFileSync(filePath, "utf-8"), `${first}\n`);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }

  assert.equal(ensureLocalAuthorPseudonymKeys({ explicit: undefined, filePath }), first);
});

test("keeps a rotated keyring and replaces one the controller would refuse", (t) => {
  const root = makeTempRoot(t);
  const rotated = path.join(root, "rotated");
  fs.writeFileSync(rotated, `v1:${KEY},v2:${NEXT_KEY}\n`, { mode: 0o600 });
  assert.equal(
    ensureLocalAuthorPseudonymKeys({ explicit: "", filePath: rotated }),
    `v1:${KEY},v2:${NEXT_KEY}`
  );

  const broken = path.join(root, "broken");
  fs.writeFileSync(broken, "v1:short\n", { mode: 0o644 });
  const replaced = ensureLocalAuthorPseudonymKeys({ explicit: "", filePath: broken });
  assert.equal(isValidAuthorPseudonymKeys(replaced), true);
  assert.equal(fs.readFileSync(broken, "utf-8"), `${replaced}\n`);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(broken).mode & 0o777, 0o600);
  }
});

test("still returns a usable keyring when it cannot be persisted", (t) => {
  const root = makeTempRoot(t);
  const blocker = path.join(root, "not-a-directory");
  fs.writeFileSync(blocker, "");
  const warnings = [];

  const keys = ensureLocalAuthorPseudonymKeys({
    explicit: "",
    filePath: path.join(blocker, "author-pseudonym-keys"),
    warn: (message) => warnings.push(message),
  });
  assert.equal(isValidAuthorPseudonymKeys(keys), true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes(keys.slice(3)), false);
});
