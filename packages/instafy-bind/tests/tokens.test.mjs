import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adminToken, viewerToken } from "../src/tokens.mjs";

test("tokens and the binder's files are never committed with the site", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-tokens-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "index.html"), "<p>hi</p>");
    adminToken(dir);
    viewerToken(dir);
    fs.writeFileSync(path.join(dir, ".bind", "binder.log"), "{}\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(staged, ["index.html"]);
    // An existing ignore file is left alone.
    fs.writeFileSync(path.join(dir, ".bind", ".gitignore"), "custom\n");
    adminToken(dir);
    assert.equal(fs.readFileSync(path.join(dir, ".bind", ".gitignore"), "utf8"), "custom\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
