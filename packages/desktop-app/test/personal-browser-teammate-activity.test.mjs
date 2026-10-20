import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  createFileTeammateActivityStore,
  createMemoryTeammateActivityStore,
  teammateActivitySite,
  MAX_TEAMMATE_SITES,
} = require(path.join(packageRoot, "dist/personalBrowserTeammateActivity.js"));

function temporaryFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-teammate-activity-"));
  return { file: path.join(directory, "nested", "activity.json"), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("only http(s) host names are recorded, never paths or queries", () => {
  assert.equal(teammateActivitySite("https://Bank.Example.test/accounts?iban=AT00"), "bank.example.test");
  assert.equal(teammateActivitySite("about:blank"), null);
  assert.equal(teammateActivitySite("file:///etc/hosts"), null);
  assert.equal(teammateActivitySite("not a url"), null);
  const store = createMemoryTeammateActivityStore();
  store.mark("p", "https://a.test/x?token=secret");
  store.mark("p", "about:blank");
  store.mark("p", "https://b.test/");
  store.mark("p", "https://a.test/y");
  assert.deepEqual(store.read("p").sites, ["b.test", "a.test"]);
  assert.equal(JSON.stringify(store.read("p")).includes("secret"), false);
  store.clear("p");
  assert.equal(store.read("p"), null);
});

test("the file store persists per profile, caps sites and forgets one profile", () => {
  const { file, cleanup } = temporaryFile();
  try {
    const first = createFileTeammateActivityStore(file);
    for (let index = 0; index < MAX_TEAMMATE_SITES + 5; index += 1) first.mark("profile-a", `https://site-${index}.test/`);
    first.mark("profile-b", null);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const reopened = createFileTeammateActivityStore(file);
    assert.equal(reopened.read("profile-a").sites.length, MAX_TEAMMATE_SITES);
    assert.equal(reopened.read("profile-a").sites.at(-1), `site-${MAX_TEAMMATE_SITES + 4}.test`);
    assert.deepEqual(reopened.read("profile-b").sites, []);
    assert.equal(reopened.read("profile-c"), null);
    reopened.clear("profile-a");
    const again = createFileTeammateActivityStore(file);
    assert.equal(again.read("profile-a"), null);
    assert.notEqual(again.read("profile-b"), null);
  } finally {
    cleanup();
  }
});

test("a damaged file marks every profile until it is forgotten", () => {
  const { file, cleanup } = temporaryFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    const messages = [];
    const store = createFileTeammateActivityStore(file, (message) => messages.push(message));
    assert.notEqual(store.read("profile-a"), null);
    assert.notEqual(store.read("profile-b"), null);
    assert.equal(messages.length, 1);
    store.clear("profile-a");
    assert.equal(store.read("profile-a"), null);
    assert.equal(createFileTeammateActivityStore(file).read("profile-a"), null);
  } finally {
    cleanup();
  }
});
