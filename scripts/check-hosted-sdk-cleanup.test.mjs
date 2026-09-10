import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflowRoot = path.resolve(import.meta.dirname, "../.github/workflows");
const read = (name) => fs.readFileSync(path.join(workflowRoot, name), "utf8");
const steps = (source) => source.split(/(?=^      - )/mu);
const cleanupSteps = (source) => steps(source).filter((step) =>
  /\b(?:rm|Remove-Item)\s[^\n]*(?:\/usr\/share\/(?:dotnet|swift)|\/usr\/local\/lib\/android|\/opt\/(?:ghc|swift|hostedtoolcache))/u
    .test(step.replace(/\\\n/gu, " ")));

test("system SDK cleanup is restricted to GitHub-hosted runners in every workflow", () => {
  const inventory = new Map();
  for (const name of fs.readdirSync(workflowRoot).filter((entry) => /\.ya?ml$/u.test(entry))) {
    const found = cleanupSteps(read(name));
    for (const step of found) {
      assert.match(step, /^        if: runner\.environment == 'github-hosted'$/mu,
        `${name}: system tool removal must not run on self-hosted or unknown runners`);
    }
    if (found.length) inventory.set(name, found.length);
  }
  assert.deepEqual(Object.fromEntries(inventory), {
    "browser-e2e.yml": 2,
    "build.yml": 5,
    "publish-runtime-agent.yml": 1,
  });
});

test("cleanup detection covers continued commands but excludes owned fixtures", () => {
  const step = (command) => `      - name: Cleanup\n        run: |\n          ${command}\n`;
  for (const command of [
    "sudo rm -rf /usr/local/lib/android",
    "rm -rf -- \\\n            /opt/ghc \\\n            /opt/hostedtoolcache/CodeQL",
    "rm -rf /usr/share/swift",
    "Remove-Item -Recurse /opt/swift",
  ]) assert.equal(cleanupSteps(step(command)).length, 1);
  assert.deepEqual(cleanupSteps(step('rm -rf "$fixture_root"')), []);
});

function diskStep() {
  const found = steps(read("publish-runtime-agent.yml")).filter((step) =>
    step.startsWith("      - name: Require sufficient free disk for the audited image\n"));
  assert.equal(found.length, 1);
  return found[0];
}

test("runtime minimum disk check cannot be skipped with hosted SDK cleanup", () => {
  const source = read("publish-runtime-agent.yml");
  const step = diskStep();
  assert.ok(source.indexOf(step) > source.indexOf("      - name: Reclaim hosted-runner disk"));
  assert.ok(source.indexOf(step) < source.indexOf("      - name: Set up Docker Buildx"));
  assert.doesNotMatch(step, /^        if:|\brm\s/mu);
  assert.match(step, /available_kib < 20 \* 1024 \* 1024/u);
  assert.match(step, /df -Pk \//u);
});

test("actual workflow disk check accepts the threshold and rejects insufficient or invalid disk", () => {
  const step = diskStep();
  const script = step.slice(step.indexOf("        run: |\n") + "        run: |\n".length)
    .split("\n").map((line) => line.replace(/^          /u, "")).join("\n");
  assert.doesNotMatch(script, /\brm\s/u);
  for (const [available, status] of [
    ["20971520", 0], ["20971521", 0], ["20971519", 1], ["0", 1], ["unknown", 1], ["", 1],
  ]) {
    // Only df is stubbed. Execute the actual non-mutating workflow condition,
    // with no inherited credentials, shell startup files or host disk cleanup.
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c",
      'df() { printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n"; printf "fixture 0 0 %s 0%% /\\n" "$TEST_AVAILABLE"; }\n' + script], {
      env: { PATH: "/usr/bin:/bin", TEST_AVAILABLE: available },
      encoding: "utf8", timeout: 3000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, `${available}: ${result.stderr}${result.stdout}`);
  }
});
