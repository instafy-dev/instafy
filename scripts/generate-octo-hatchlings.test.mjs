import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GEOMETRY_PATH, renderOctoHatchlingsGeometry } from "./generate-octo-hatchlings.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(import.meta.dirname, "generate-octo-hatchlings.mjs");
const checkedIn = () => fs.readFileSync(path.join(REPO_ROOT, GEOMETRY_PATH), "utf8");
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8" });

test("the checked-in geometry is what the poses draw", () => {
  assert.equal(renderOctoHatchlingsGeometry(), checkedIn());
  // Deterministic: a second render gives the same bytes.
  assert.equal(renderOctoHatchlingsGeometry(), renderOctoHatchlingsGeometry());
});

test("--check passes on the checked-in file and fails on a stale one", () => {
  const current = run("--check");
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /octo-hatchlings\.geometry\.json is current/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octo-hatchlings-"));
  try {
    const copy = path.join(dir, "geometry.json");
    fs.writeFileSync(copy, checkedIn().replace('"r": 4.1', '"r": 4.2'));
    const stale = run("--check", "--out", copy);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /is not what the poses draw/);
    assert.equal(run("--check", "--out", path.join(dir, "missing.json")).status, 1);

    const written = run("--out", copy);
    assert.equal(written.status, 0, written.stderr);
    assert.equal(fs.readFileSync(copy, "utf8"), checkedIn());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown argument stops before anything is written", () => {
  const before = checkedIn();
  for (const args of [["--chek"], ["--out"], ["--out=geometry.json"], ["--out", "--check"]]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /usage: \[--check\] \[--out <json>\]/);
  }
  assert.equal(checkedIn(), before);
});

test("eight seats in order and the hollow face, each one ink with one even-odd dome", () => {
  const geometry = JSON.parse(checkedIn());
  assert.equal(geometry.viewBox, "0 0 64 64");
  assert.equal(geometry.fill, "currentColor");
  assert.deepEqual(
    Object.entries(geometry.faces).map(([key, face]) => `${key} ${face.name}`),
    ["1 hooray", "2 drift", "3 kick", "4 twirl", "5 wave", "6 catch", "7 rest", "8 swim", "unknown unknown"],
  );
  for (const [key, face] of Object.entries(geometry.faces)) {
    // Four arms, then the dome: the only even-odd path, always last.
    assert.equal(face.paths.length, 5, key);
    assert.deepEqual(face.paths.map((p) => p.fillRule ?? null), [null, null, null, null, "evenodd"], key);
    const subpaths = face.paths[4].d.match(/M/g).length;
    if (key === "unknown") {
      // The outer dome minus the inner one; its two eyes drawn inside, and no dot.
      assert.equal(subpaths, 2);
      assert.equal(face.circles.length, 2);
    } else {
      // The dome with two eye holes, and exactly one dot: never four.
      assert.equal(subpaths, 3, key);
      assert.equal(face.circles.length, 1, key);
    }
  }
});
