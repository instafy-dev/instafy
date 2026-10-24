import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, ".github/workflows/npm-release-daily.yml"), "utf8");
const TITLE = "chore(release): version npm packages";
const HEAD = "a".repeat(40);

function step(name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing step: ${name}`);
  const end = source.indexOf("\n      - name: ", start + 1);
  return source.slice(start, end === -1 ? undefined : end + 1);
}

function script(name) {
  const body = step(name);
  const run = body.slice(body.indexOf("        run: |\n") + "        run: |\n".length);
  return run.split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
}

const FIND = "Find the pending version pull request";
const ARM = "Mark it ready and arm auto-merge through the merge queue";

test("the daily release runs only on schedule or dispatch from protected main with least privilege", () => {
  const on = source.indexOf("\non:\n") + 1;
  assert.equal(source.slice(on, source.indexOf("\n\n", on)), 'on:\n  schedule:\n    - cron: "43 6 * * *"\n  workflow_dispatch:');
  assert.match(source, /\nconcurrency:\n  group: npm-release-main\n  cancel-in-progress: false\n  queue: max\n\npermissions: \{\}\n/u);
  assert.deepEqual([...source.matchAll(/^  ([\w-]+):\n    name:/gmu)].map((match) => match[1]), ["arm"]);
  for (const clause of [
    "github.repository == 'instafy-dev/instafy'",
    "github.ref == 'refs/heads/main'",
    "github.ref_protected == true",
    "(github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')",
  ]) assert.ok(source.includes(clause), clause);
  assert.match(source, /^    runs-on: ubuntu-24\.04$/mu);
  assert.match(source, /^    timeout-minutes: 5$/mu);
  assert.match(source, /^    permissions:\n      contents: read\n      pull-requests: read\n\n/mu);
  assert.doesNotMatch(source, /write-all|: write$|environment:|id-token|NPM_TOKEN|NODE_AUTH_TOKEN|vars\.|self-hosted|continue-on-error/mu);
  // Nothing is checked out or loaded: only the runner image's gh runs.
  assert.doesNotMatch(source, /^\s+uses:/mu);
  assert.doesNotMatch(source, /pull_request|merge_group|push:|workflow_run|repository_dispatch/u);
});

test("only the final step holds the bot credential and it never approves, bypasses or pushes", () => {
  assert.deepEqual([...source.matchAll(/\bsecrets\.(\w+)/gu)].map((match) => match[1]), ["INSTAFY_BOT_TOKEN"]);
  assert.match(step(ARM), /GH_TOKEN: \$\{\{ secrets\.INSTAFY_BOT_TOKEN \}\}/u);
  assert.match(step(ARM), /if: \$\{\{ steps\.find\.outputs\.pending == 'true' \}\}/u);
  assert.match(step(FIND), /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(source, /--admin|--approve|pr review|git push|gh pr edit|gh pr close|gh api .*(?:-X|--method) (?:POST|PUT|PATCH|DELETE)/u);
  const mutations = [...script(ARM).matchAll(/^\s*gh (.+?)(?: \\)?$/gmu)].map((match) => match[1]);
  assert.deepEqual(mutations, [
    'pr ready "$PULL_REQUEST" --repo "$GITHUB_REPOSITORY"',
    'pr merge "$PULL_REQUEST" --repo "$GITHUB_REPOSITORY" --auto --squash',
  ]);
  assert.match(script(ARM), /--match-head-commit "\$HEAD_SHA"/u);
});

function harness(fixture) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "npm-release-daily-"));
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(directory, "fixture.json"), JSON.stringify(fixture));
  // A fake gh that answers the read-only lookups from the fixture through jq
  // and records every invocation.
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
const fixture = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, "utf8"));
if (args[0] === "pr") process.exit(0);
const jq = args[args.indexOf("--jq") + 1];
const endpoint = args[1] === "graphql" ? "graphql" : args.find((arg) => arg.startsWith("repos/"));
const key = endpoint === "graphql" ? "graphql" : /\\/files\\?/.test(endpoint) ? "files" : /\\/rules\\//.test(endpoint) ? "rules" : "pulls";
try {
  process.stdout.write(execFileSync("jq", ["-r", jq], { input: JSON.stringify(fixture[key]) }));
} catch (error) { process.stderr.write(String(error.stderr)); process.exit(1); }
`, { mode: 0o755 });
  const output = path.join(directory, "output");
  const calls = path.join(directory, "calls");
  fs.writeFileSync(output, "");
  fs.writeFileSync(calls, "");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    GH_FIXTURE: path.join(directory, "fixture.json"),
    GH_CALLS: calls,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
    GITHUB_REPOSITORY: "instafy-dev/instafy",
    GITHUB_REPOSITORY_OWNER: "instafy-dev",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_PROTECTED: "true",
  };
  const run = (name, extra = {}) => childProcess.spawnSync("bash", ["-c", script(name)], { env: { ...env, ...extra }, encoding: "utf8" });
  const outputs = () => Object.fromEntries(fs.readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("=")));
  const recorded = () => fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { run, outputs, recorded, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function versionPr(overrides = {}) {
  return {
    number: 714,
    title: TITLE,
    user: { login: "instafy-bot" },
    head: { ref: "changeset-release/main", repo: { full_name: "instafy-dev/instafy" } },
    base: { ref: "main" },
    ...overrides,
  };
}

function fixture({ pulls = [versionPr()], files = ["packages/instafy-cli/package.json", "packages/instafy-cli/CHANGELOG.md"],
  draft = true, queued = false, armed = false, labels = [], rules = [{ type: "pull_request" }] } = {}) {
  return {
    pulls,
    files: files.map((filename) => ({ filename })),
    rules,
    graphql: { data: { repository: { pullRequest: {
      id: "PR_x", isDraft: draft, isInMergeQueue: queued, headRefOid: HEAD,
      autoMergeRequest: armed ? { enabledAt: "2026-10-24T06:43:00Z" } : null,
      labels: { nodes: labels.map((name) => ({ name })) },
    } } } },
  };
}

function arm(state) {
  const fake = harness(fixture(state));
  try {
    const found = fake.run(FIND);
    assert.equal(found.status, 0, found.stderr);
    const outputs = fake.outputs();
    let mutations = [];
    if (outputs.pending === "true") {
      const armed = fake.run(ARM, {
        GH_TOKEN: "bot-token", PULL_REQUEST: outputs.number, HEAD_SHA: outputs.head, DRAFT: outputs.draft, ARMED: outputs.armed,
      });
      assert.equal(armed.status, 0, armed.stderr);
      mutations = fake.recorded().filter((args) => args[0] === "pr");
    }
    return { outputs, mutations, stdout: found.stdout };
  } finally {
    fake.cleanup();
  }
}

test("a pending draft version pull request is marked ready and queued at its inspected head", () => {
  const result = arm({});
  assert.equal(result.outputs.pending, "true");
  assert.deepEqual(result.mutations, [
    ["pr", "ready", "714", "--repo", "instafy-dev/instafy"],
    ["pr", "merge", "714", "--repo", "instafy-dev/instafy", "--auto", "--squash", "--match-head-commit", HEAD],
  ]);
});

test("a ready, unarmed version pull request is only armed", () => {
  assert.deepEqual(arm({ draft: false }).mutations, [
    ["pr", "merge", "714", "--repo", "instafy-dev/instafy", "--auto", "--squash", "--match-head-commit", HEAD],
  ]);
  assert.deepEqual(arm({ draft: true, armed: true }).mutations, [["pr", "ready", "714", "--repo", "instafy-dev/instafy"]]);
});

test("every other state exits cleanly without touching anything", () => {
  const none = "No version pull request is open";
  const cases = [
    [none, { pulls: [] }],
    [none, { pulls: [versionPr({ title: "chore(release): something else" })] }],
    [none, { pulls: [versionPr({ user: { login: "someone" } })] }],
    [none, { pulls: [versionPr({ head: { ref: "changeset-release/main", repo: { full_name: "fork/instafy" } } })] }],
    [none, { pulls: [versionPr({ head: { ref: "changeset-release/other", repo: { full_name: "instafy-dev/instafy" } } })] }],
    ["changes no package version", { files: [".changeset/a.md", "packages/instafy-cli/CHANGELOG.md"] }],
    ["has the release-hold label", { labels: ["release-hold"] }],
    ["Protected main is frozen", { rules: [{ type: "pull_request" }, { type: "update" }] }],
    ["is already ready and set to merge", { draft: false, armed: true }],
    ["is already ready and set to merge", { draft: false, queued: true }],
  ];
  for (const [message, state] of cases) {
    const result = arm(state);
    assert.equal(result.outputs.pending, "false", message);
    assert.deepEqual(result.mutations, [], message);
    assert.ok(result.stdout.includes(message), `${message}: ${result.stdout}`);
  }
});

test("lookups refuse ambiguity and any other repository or ref", () => {
  const fake = harness(fixture({ pulls: [versionPr(), versionPr({ number: 715 })] }));
  try {
    assert.notEqual(fake.run(FIND).status, 0);
    for (const extra of [{ GITHUB_REPOSITORY: "fork/instafy" }, { GITHUB_REF: "refs/heads/other" }, { GITHUB_REF_PROTECTED: "false" }]) {
      assert.notEqual(fake.run(FIND, extra).status, 0, JSON.stringify(extra));
    }
    assert.deepEqual(fake.recorded().filter((args) => args[0] === "pr"), []);
  } finally {
    fake.cleanup();
  }
});
