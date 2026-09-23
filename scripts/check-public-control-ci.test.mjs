import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = file => fs.readFileSync(path.join(root, ".github/workflows", file), "utf8");
const jobs = [
  { file: "npm-release.yml", key: "select", name: "Select version or publish mode", minutes: 15 },
  { file: "continuous-image-publication.yml", key: "publish", name: "Publish exact protected-main images after CI", minutes: 5 },
  { file: "npm-release.yml", key: "pack", name: "Test and pack exact npm artifacts", minutes: 25 },
  { file: "npm-release.yml", key: "version", name: "Create or update the signed version pull request", minutes: 15 },
];

function section(job) {
  const source = read(job.file), start = source.indexOf(`\n  ${job.key}:\n`);
  assert.ok(start >= 0);
  return source.slice(start + 1).split(/\n  [\w-]+:\n/u)[0];
}

test("the protected-main control jobs run on hosted Ubuntu with their fixed identities and budgets", () => {
  for (const job of jobs) {
    assert.match(section(job), /^    runs-on: ubuntu-24\.04$/mu);
    assert.match(section(job), new RegExp(`^    name: ${job.name}$`, "mu"));
    assert.match(section(job), new RegExp(`^    timeout-minutes: ${job.minutes}$`, "mu"));
    assert.doesNotMatch(section(job), /runner\.environment|self-hosted|Qualify isolated/u);
  }
  assert.match(fs.readFileSync(path.join(root, "scripts/check-public-release-workflows.test.mjs"), "utf8"), /import "\.\/check-public-control-ci\.test\.mjs";/u);
});

test("pack keeps its exact selected publish plan, read-only permissions and no publication authority", () => {
  const job = jobs.find(value => value.key === "pack");
  const pack = section(job);
  assert.match(pack, /^    needs: select$/mu);
  assert.match(pack, /^    if: \$\{\{ needs\.select\.outputs\.mode == 'publish' \}\}$/mu);
  assert.match(pack, /permissions:\n      actions: read\n      contents: read/u);
  assert.doesNotMatch(pack, /secrets\.|id-token:|environment:|contents: write|actions: write|cache:|pnpm changeset publish/u);
  assert.match(section({ file: job.file, key: "publish" }), /^    runs-on: ubuntu-24\.04$/mu);
  assert.match(section({ file: job.file, key: "publish" }), /environment: npm-release[\s\S]*id-token: write/u);
});

test("version retains the two exact bot-secret uses after a credential-free checkout and install", () => {
  const source = read("npm-release.yml"), job = jobs.find(value => value.key === "version"), version = section(job);
  assert.match(version, /^    needs: select\n    if: \$\{\{ needs\.select\.outputs\.mode == 'version' \}\}$/mu);
  assert.match(version, /permissions:\n      contents: read\n\n    steps:/u);
  assert.doesNotMatch(version, /id-token:|environment:|contents: write|actions: write|NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_ENV/u);
  assert.equal((source.match(/secrets\.INSTAFY_BOT_TOKEN/gu) ?? []).length, 2);
  assert.equal((version.match(/secrets\.INSTAFY_BOT_TOKEN/gu) ?? []).length, 2);
  const credential = version.indexOf("      - name: Require the dedicated instafy-bot credential\n");
  assert.ok(credential > version.indexOf("run: pnpm install --frozen-lockfile --ignore-scripts"));
  const freshness = version.indexOf("      - name: Require exact current protected main before bot authorization\n");
  assert.ok(freshness > 0 && freshness < credential);
  const freshnessStep = version.slice(freshness, credential);
  assert.doesNotMatch(freshnessStep, /^        if:/mu);
  assert.match(freshnessStep, /gh api --method GET "repos\/instafy-dev\/instafy\/branches\/main" --jq 'select\(\.name == "main" and \.protected == true\) \| \.commit\.sha'/u);
  assert.match(freshnessStep, /test "\$current_sha" = "\$GITHUB_SHA"\n[^\n]*\n\s+test "\$checkout_sha" = "\$GITHUB_SHA"/u);
  assert.doesNotMatch(version.slice(0, credential), /secrets\./u);
  assert.ok(version.indexOf("      - name: Create or update the Changesets version pull request\n") > credential);
});
