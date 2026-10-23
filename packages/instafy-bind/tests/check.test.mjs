// `instafy-bind check`: a page built for a request that named items (products to compare, stops, entries) must show
// every one of them, or the check fails loudly. A builder that loses an item to a lookup that timed out, or trims a
// list, otherwise ships a page that quietly leaves it out.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSite, htmlText, names, parseExpect } from "../src/check.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");
const cleanEnv = { PATH: process.env.PATH, HOME: os.tmpdir() };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env: cleanEnv, encoding: "utf8" });

function compareSite(items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-check-"));
  execFileSync(process.execPath, [BIN, "init", dir, "--starter", "compare"], { env: cleanEnv });
  const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
  data.title = "Three running shoes for flat feet";
  data.items = items.map((name, i) => ({ ref: `shoes:item-${i}`, name, facts: {} }));
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data, null, 2));
  return dir;
}

test("expected items are read from a list or a JSON array, without duplicates", () => {
  assert.deepEqual(parseExpect("Brooks Adrenaline GTS 24, ASICS Gel-Kayano 31;Hoka Arahi 7\nbrooks adrenaline gts 24"),
    ["Brooks Adrenaline GTS 24", "ASICS Gel-Kayano 31", "Hoka Arahi 7"]);
  assert.deepEqual(parseExpect('["Taipei", {"name": "Hualien"}]'), ["Taipei", "Hualien"]);
  assert.deepEqual(parseExpect(""), []);
});

test("an item counts as shown when the page's text or data names it as whole words", () => {
  assert.equal(names("ASICS Gel Kayano 31 · seen 17 Oct", "ASICS Gel-Kayano 31"), true);
  assert.equal(names("Hoka Arahi 75", "Hoka Arahi 7"), false, "a longer number is another product");
  assert.equal(names("京都駅から徒歩5分", "京都"), true);
  assert.equal(htmlText('<h1>Shoes</h1><script>const x = "Hoka Arahi 7"</script><!-- Brooks -->'), " Shoes ");
});

test("check fails and names every item the page leaves out", () => {
  const dir = compareSite(["Brooks Adrenaline GTS 24", "ASICS Gel-Kayano 31"]);
  try {
    const out = run("check", dir, "--expect", "Brooks Adrenaline GTS 24, ASICS Gel-Kayano 31, Hoka Arahi 7");
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /^MISSING: the request named 1 item\(s\) the site does not show: Hoka Arahi 7\./m);
    assert.match(out.stdout, /2 of 3 expected item\(s\) shown: Brooks Adrenaline GTS 24, ASICS Gel-Kayano 31\./);
    const json = JSON.parse(run("check", dir, "--expect", "Hoka Arahi 7", "--json").stdout);
    assert.deepEqual([json.ok, json.missing], [false, ["Hoka Arahi 7"]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check passes once every item is on the page, from --expect or data.json's own list", () => {
  const dir = compareSite(["Brooks Adrenaline GTS 24", "ASICS Gel-Kayano 31", "Hoka Arahi 7"]);
  try {
    const ok = run("check", dir, "--expect", "Brooks Adrenaline GTS 24, ASICS Gel-Kayano 31, Hoka Arahi 7");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /3 of 3 expected item\(s\) shown/);
    // the list kept with the data is checked on every run, and is never itself counted as shown
    const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
    data.expect = ["Hoka Arahi 7", "Saucony Guide 18"];
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data));
    const declared = run("check", dir);
    assert.equal(declared.status, 1, declared.stdout);
    assert.match(declared.stdout, /does not show: Saucony Guide 18\./);
    assert.deepEqual(checkSite(dir).missing, ["Saucony Guide 18"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("check with nothing to check says how to give the list (exit 2)", () => {
  const dir = compareSite(["Brooks Adrenaline GTS 24"]);
  try {
    const out = run("check", dir);
    assert.equal(out.status, 2);
    assert.match(out.stdout, /nothing to check: pass --expect/);
    assert.equal(run("check", path.join(dir, "nope"), "--expect", "x").status, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
