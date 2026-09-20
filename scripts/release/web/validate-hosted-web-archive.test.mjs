import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Fixture archives are generated at test time with Python's tarfile so each
// member can carry an exact type and name.
const validator = path.join(import.meta.dirname, "validate-hosted-web-archive.py");
const python = process.env.PYTHON ?? "python3";

function makeTar(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-web-archive-"));
  const archive = path.join(root, "hosted-frontend.tar.gz");
  const script = `
import io, json, sys, tarfile
entries = json.loads(sys.argv[2])
with tarfile.open(sys.argv[1], "w:gz") as archive:
    for entry in entries:
        info = tarfile.TarInfo(entry["name"])
        kind = entry.get("type", "file")
        if kind == "dir":
            info.type = tarfile.DIRTYPE
            archive.addfile(info)
        elif kind == "symlink":
            info.type = tarfile.SYMTYPE
            info.linkname = "index.html"
            archive.addfile(info)
        else:
            data = entry.get("data", "x").encode()
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
`;
  const made = spawnSync(python, ["-c", script, archive, JSON.stringify(entries)], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return archive;
}

const run = (archive) => spawnSync(python, [validator, archive], { encoding: "utf8" });
const base = [{ name: "dist", type: "dir" }, { name: "dist/index.html" }, { name: "dist/instafy-build.json" }];

test("a dist-only archive of plain files passes", () => {
  const result = run(makeTar(base));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 files/u);
});

test("unsafe members, workers and empty archives are refused", () => {
  for (const entries of [
    [...base, { name: "outside.txt" }],
    [...base, { name: "dist/../escape.txt" }],
    [...base, { name: "/dist/absolute.txt" }],
    [...base, { name: "dist/link.html", type: "symlink" }],
    [...base, { name: "dist/_worker.js" }],
    [...base, { name: "dist/functions", type: "dir" }],
    [{ name: "dist/index.html" }],
  ]) {
    assert.notEqual(run(makeTar(entries)).status, 0, JSON.stringify(entries.at(-1)));
  }
});
