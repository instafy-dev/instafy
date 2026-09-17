import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Fixture zips are generated at test time (binary files are not committed to
// the public tree) with Python's zipfile, which lets each entry carry an
// exact mode and exact first bytes.
const validator = path.join(import.meta.dirname, "validate-ota-web-archive.py");
const python = process.env.PYTHON ?? "python3";

function makeZip(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ota-archive-test-"));
  const archive = path.join(root, "bundle.zip");
  const script = `
import base64, json, sys, zipfile
entries = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    for entry in entries:
        info = zipfile.ZipInfo(entry["name"])
        info.external_attr = entry.get("mode", 0o100644) << 16
        archive.writestr(info, base64.b64decode(entry["data"]))
`;
  const payload = entries.map((entry) => ({ ...entry, data: Buffer.from(entry.data).toString("base64") }));
  const made = spawnSync(python, ["-c", script, archive, JSON.stringify(payload)], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return { archive, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function validate(entries) {
  const fixture = makeZip(entries);
  try {
    return spawnSync(python, [validator, fixture.archive], { encoding: "utf8" });
  } finally {
    fixture.cleanup();
  }
}

const INDEX = { name: "index.html", data: "<!doctype html>" };

const hasPython = spawnSync(python, ["--version"]).status === 0;

test("a web-only archive with a root index.html passes", { skip: !hasPython }, () => {
  const result = validate([INDEX, { name: "assets/app.js", data: "console.log(1)" }, { name: "_headers", data: "/*\n" }]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /structure verified/u);
});

test("native magic bytes are refused without echoing archive content", { skip: !hasPython }, () => {
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("secret-name")]);
  const result = validate([INDEX, { name: "assets/lib.js", data: elf }]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /validation failed/u);
  assert.doesNotMatch(result.stderr + result.stdout, /lib\.js|secret-name/u);
});

test("executable entries are refused", { skip: !hasPython }, () => {
  const result = validate([INDEX, { name: "assets/run.js", data: "x", mode: 0o100755 }]);
  assert.equal(result.status, 1);
});

test("an archive without a root index.html is refused", { skip: !hasPython }, () => {
  assert.equal(validate([{ name: "nested/index.html", data: "<html>" }]).status, 1);
});

test("hidden, traversal and non-web entries are refused", { skip: !hasPython }, () => {
  assert.equal(validate([INDEX, { name: ".env", data: "A=1" }]).status, 1);
  assert.equal(validate([INDEX, { name: "../escape.js", data: "x" }]).status, 1);
  assert.equal(validate([INDEX, { name: "assets/tool.sh", data: "echo" }]).status, 1);
  assert.equal(validate([INDEX, { name: "App.app/index.js", data: "x" }]).status, 1);
});
