import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The public repository runs only on GitHub-hosted runners. It must never
// regain a dependency on the private fleet: no runner group, no self-hosted
// label, no runtime selector that could route a job there.
const workflowRoot = path.resolve(import.meta.dirname, "../.github/workflows");
const allowedRunners = new Set(["ubuntu-latest", "ubuntu-24.04", "ubuntu-24.04-arm", "${{ matrix.runner }}"]);
const forbidden = /self-hosted|instafy-ci-|instafy-trusted-build|instafy-build|runner\.environment|SELF_HOSTED|RUNNER_MODE/u;

test("every public workflow job runs on an allowlisted GitHub-hosted runner", () => {
  const workflows = fs.readdirSync(workflowRoot).filter((name) => /\.ya?ml$/u.test(name));
  assert.ok(workflows.length > 0);
  for (const name of workflows) {
    const source = fs.readFileSync(path.join(workflowRoot, name), "utf8");
    const selectors = [...source.matchAll(/^\s+runs-on:(.*)$/gmu)].map((match) => match[1].trim());
    for (const selector of selectors) {
      assert.ok(allowedRunners.has(selector), `${name}: runs-on must be a hosted literal, found ${JSON.stringify(selector)}`);
    }
    if (selectors.includes("${{ matrix.runner }}")) {
      for (const match of source.matchAll(/^\s+runner: (.*)$/gmu)) {
        assert.ok(allowedRunners.has(match[1].trim()), `${name}: matrix runner ${match[1]} is not hosted`);
      }
    }
    assert.doesNotMatch(source, forbidden, `${name} must not reference self-hosted runners, groups, labels or switches`);
  }
});
