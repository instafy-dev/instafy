import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, ".github/workflows/git-conflict-canary.yml"), "utf8");
const fixture = source.slice(source.indexOf("      - name: Verify conflict-resolution fixture\n"));

test("the workflow retains its identity, bounds, triggers and read-only exact checkout", () => {
  assert.match(source, /^name: Public Git Conflict Contract$/mu);
  assert.match(source, /^  deterministic-conflict:\n    name: Deterministic conflict fixture\n    runs-on: ubuntu-latest\n/mu);
  assert.equal((source.match(/^  [\w-]+:\n    name:/gmu) ?? []).length, 1);
  assert.doesNotMatch(source, /runner\.environment|self-hosted|Qualify isolated/u);
  assert.match(source, /^    timeout-minutes: 5$/mu);
  assert.match(source, /permissions:\n  contents: read\n/u);
  assert.match(source, /concurrency:\n  group: public-git-conflict-contract-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true/u);
  assert.match(source, /  push:\n    branches:\n      - main\n/u);
  assert.match(source, /^  workflow_dispatch:$/mu);
  for (const file of [".github/workflows/git-conflict-canary.yml", "scripts/check-git-conflict-ci.test.mjs", "packages/runtime-agent/assets/instafy/.agents/skills/instafy-git-canonical-conflicts/SKILL.md"]) {
    assert.equal(source.split(`      - "${file}"`).length - 1, 2);
  }
  assert.match(source, /uses: actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6\n        with:\n          ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false/u);
  assert.match(source, /- name: Test Git conflict routing contracts\n        run: node --test scripts\/check-git-conflict-ci\.test\.mjs/u);
  assert.doesNotMatch(source, /secrets\.|environment:|continue-on-error:|permissions:\s*write-all|npm install|pnpm install|allow-unsafe-pr-checkout/u);
});

test("the complete original fixture step remains byte-identical", () => {
  assert.equal(createHash("sha256").update(fixture).digest("hex"), "9b9a7d197913ad5da9bc1f90690da38627d2d6b05a3ddd1debd36c4678bab3e5");
});

test("the real fixture resolves a local conflict, rebases and pushes without network credentials", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-git-conflict-test-"));
  try {
    const home = path.join(temporary, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const program = fixture.slice(fixture.indexOf("        run: |\n") + "        run: |\n".length).replace(/^          /gmu, "");
    execFileSync("/bin/bash", ["-c", program], {
      cwd: root, timeout: 30_000, maxBuffer: 256 * 1024,
      env: {
        PATH: process.env.PATH, HOME: home, LANG: "C", TZ: "UTC", TMPDIR: temporary,
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "file",
      },
      stdio: "pipe",
    });
    assert.deepEqual(fs.readdirSync(temporary), ["home"], "the fixture must remove its own repositories");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
