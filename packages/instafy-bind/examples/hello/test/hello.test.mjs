// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(siteDir, "handlers", "hello.mjs")], {
      cwd: siteDir,
      env: { ...process.env, HELLO_STEP_MS: "5" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim().split("\n").map((l) => JSON.parse(l))));
    child.stdin.end(JSON.stringify(input));
  });
}

test("hello streams 3 progress steps, one claim, then done", async () => {
  const lines = await run({ intent: { name: "hello", params: { name: "Kim Lee", ref: "hello:kim-lee" } } });
  assert.deepEqual(lines.map((l) => l.type), ["progress", "progress", "progress", "records", "done"]);
  assert.deepEqual(lines.slice(0, 3).map((l) => `${l.step}/${l.of}`), ["1/3", "2/3", "3/3"]);
  const [claim] = lines[3].records;
  assert.equal(claim.type, "claim");
  assert.equal(claim.ref, "hello:kim-lee");
  assert.equal(claim.attr, "greeting");
  assert.match(claim.value, /Kim Lee/);
  assert.equal(claim.prov.lane, "local");
  assert.ok(Date.parse(claim.prov.observed_at));
});

test("hello derives a ref from the name when none is given", async () => {
  const lines = await run({ intent: { params: { name: "Åsa Ö" } } });
  assert.equal(lines[3].records[0].ref, "hello:asa-o");
});

test("the page greys out Ask Octo with the host's reason for someone who may not ask, and follows the host's layout", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(path.join(siteDir, "index.html"), "utf8");
  const sync = html.slice(html.indexOf("function syncOcto()"));
  assert.match(sync, /bind\.hostLayout\?\.caps\?\.ask/);
  assert.match(sync, /octo\.disabled = Boolean\(reason\)/);
  assert.match(sync, /why\.textContent = reason/);
  assert.match(html, /bind\.on\("layout", syncOcto\)/);
  assert.match(html, /<p class="note" id="octo-why" hidden><\/p>/);
});
