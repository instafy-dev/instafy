import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { MERGE_GROUP_TRIGGER } from "./lib/mergeQueueTestBaseline.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, ".github/workflows", file), "utf8");
const triggers = (source) => source.slice(source.indexOf("\non:\n") + 5, source.search(/\n(?:concurrency|permissions|jobs):/u));
// Every context main requires is reported by one of these three workflows.
const REQUIRED = {
  "build.yml": ["Secret scan", "JavaScript packages", "Go packages", "Rust packages", "Browser verification"],
  "npm-release.yml": ["Require reviewed Changeset release intent"],
  "public-boundary.yml": ["Public boundary (trusted base)"],
};

test("exactly the workflows that report main's required checks run for queued merge groups", () => {
  for (const file of fs.readdirSync(path.join(root, ".github/workflows")).filter((name) => /\.ya?ml$/u.test(name))) {
    const source = read(file);
    const expected = file in REQUIRED ? 1 : 0;
    assert.equal(triggers(source).split(MERGE_GROUP_TRIGGER).length - 1, expected, file);
    assert.equal((source.match(/^  merge_group:$/gmu) ?? []).length, expected, file);
    for (const name of REQUIRED[file] ?? []) assert.match(source, new RegExp(`^    name: ${name.replace(/[()]/gu, "\\$&")}$`, "mu"), `${file}: ${name}`);
  }
  const browser = read("browser-e2e.yml");
  for (const name of ["Personal Browser E2E", "Browser UI rendering", "Shared Browser profile E2E"]) assert.match(browser, new RegExp(`^    name: ${name}$`, "mu"));
});

test("npm-release keys merge-group concurrency on the queued group, never on the main release lock", () => {
  const expression = read("npm-release.yml").match(/^  group: npm-release-\$\{\{ (.+) \}\}$/mu)[1];
  const evaluate = (github) => vm.runInNewContext(expression.replace(/([\w.]+) == ('[^']*')/gu, "($1 === $2)"), { github }, { timeout: 1000 });
  assert.equal(evaluate({ event_name: "pull_request", event: { pull_request: { number: 7 } } }), 7);
  assert.equal(evaluate({ event_name: "merge_group", event: { merge_group: { head_ref: "refs/heads/gh-readonly-queue/main/pr-7-" + "a".repeat(40) } } }),
    "refs/heads/gh-readonly-queue/main/pr-7-" + "a".repeat(40));
  assert.equal(evaluate({ event_name: "push", event: {} }), "main");
  assert.equal(evaluate({ event_name: "workflow_dispatch", event: {} }), "main");
});

test("the queued Changeset policy uses the group's own diff and the queued PR's identity", () => {
  const source = read("npm-release.yml");
  const section = source.split("\n      - name: Validate ordinary or generated release changes\n")[1].split(/\n  [\w-]+:\n/u)[0];
  const script = section.slice(section.indexOf("        run: |\n") + 15).split("\n").map((line) => line.slice(10)).join("\n");
  assert.match(section, /^          QUEUE_LOOKUP_TOKEN: \$\{\{ github\.event_name == 'merge_group' && github\.token \|\| '' \}\}$/mu);
  assert.doesNotMatch(section, /GH_TOKEN:|secrets\./u);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "merge-queue-policy-"));
  // Stub gh: answers only the queued PR's pulls read, joined the way the --jq filter joins it.
  fs.writeFileSync(path.join(bin, "gh"), [
    "#!/bin/bash",
    'printf "%s\\n" "$*" >> "$GH_LOG"',
    '[[ "$GH_TOKEN" == lookup-token && "$1" == api && "$2" == "repos/instafy-dev/instafy/pulls/12" && "$3" == --jq ]] || exit 1',
    'printf "%s\\x1f%s\\x1f%s\\n" "$PR_HEAD_REF" "$PR_HEAD_REPO" "$PR_AUTHOR"',
    "",
  ].join("\n"), { mode: 0o755 });
  fs.mkdirSync(path.join(bin, "scripts"));
  // Stub policy: the checked-out code must never see the lookup token.
  fs.writeFileSync(path.join(bin, "scripts/check-changeset-pr.mjs"),
    'if (process.env.QUEUE_LOOKUP_TOKEN || process.env.GH_TOKEN) process.exit(3);\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  const base = "b".repeat(40), head = "c".repeat(40);
  const queueRef = (suffix) => `refs/heads/gh-readonly-queue/main/${suffix}`;
  const ghLog = path.join(bin, "gh.log");
  const run = (env) => childProcess.spawnSync("bash", ["-c", script], { cwd: bin, encoding: "utf8", timeout: 10_000,
    env: { PATH: `${bin}:${process.env.PATH}`, GH_LOG: ghLog, GITHUB_REPOSITORY: "instafy-dev/instafy", GITHUB_EVENT_NAME: "merge_group",
      BASE_SHA: base, HEAD_SHA: head, MERGE_GROUP_BASE_REF: "refs/heads/main", QUEUE_LOOKUP_TOKEN: "lookup-token",
      MERGE_GROUP_HEAD_REF: queueRef(`pr-12-${"d".repeat(40)}`),
      PR_HEAD_REF: "fix/topic", PR_HEAD_REPO: "instafy-dev/instafy", PR_AUTHOR: "instafy-bot", ...env } });
  const args = (result) => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const ordinary = ["--base", base, "--head", head];
  const version = [...ordinary, "--version-pr"];
  assert.deepEqual(args(run({})), ordinary);
  assert.deepEqual(args(run({ PR_HEAD_REF: "changeset-release/main" })), version);
  assert.deepEqual(args(run({ PR_HEAD_REF: "changeset-release/main", PR_AUTHOR: "someone" })), ordinary);
  assert.deepEqual(args(run({ PR_HEAD_REF: "changeset-release/main", PR_HEAD_REPO: "fork/instafy" })), ordinary);
  // A deleted head repository is never the generated version PR.
  assert.deepEqual(args(run({ PR_HEAD_REF: "changeset-release/main", PR_HEAD_REPO: "" })), ordinary);
  // The PR number is the only part of the ref the lane requires; GitHub owns the suffix.
  for (const suffix of ["pr-12-0123abcd", "pr-12", "pr-12-a.b_c/d-e"])
    assert.deepEqual(args(run({ PR_HEAD_REF: "changeset-release/main", MERGE_GROUP_HEAD_REF: queueRef(suffix) })), version, suffix);
  for (const env of [{ MERGE_GROUP_BASE_REF: "refs/heads/topic" }, { MERGE_GROUP_HEAD_REF: queueRef("other") },
    { MERGE_GROUP_HEAD_REF: queueRef("pr-012-abc") }, { MERGE_GROUP_HEAD_REF: queueRef("pr-12x") },
    { MERGE_GROUP_HEAD_REF: queueRef("pr-12-a b") }, { MERGE_GROUP_HEAD_REF: "" },
    { MERGE_GROUP_HEAD_REF: `refs/heads/gh-readonly-queue/topic/pr-12-${"d".repeat(40)}` },
    { MERGE_GROUP_HEAD_REF: queueRef(`pr-13-${"d".repeat(40)}`) }]) {
    const rejected = run(env);
    assert.notEqual(rejected.status, 0, JSON.stringify(env));
    // The policy never runs for a group the lane cannot bind to its queued PR.
    assert.doesNotMatch(rejected.stdout, /--base/u, JSON.stringify(env));
  }
  // A pull_request event keeps the payload identity and never calls the API.
  fs.rmSync(ghLog, { force: true });
  const pr = { GITHUB_EVENT_NAME: "pull_request", HEAD_REF: "changeset-release/main", HEAD_REPOSITORY: "instafy-dev/instafy",
    PULL_REQUEST_AUTHOR: "instafy-bot", MERGE_GROUP_BASE_REF: "", MERGE_GROUP_HEAD_REF: "", QUEUE_LOOKUP_TOKEN: "", PR_AUTHOR: "someone" };
  assert.deepEqual(args(run(pr)), version);
  assert.deepEqual(args(run({ ...pr, PULL_REQUEST_AUTHOR: "someone", PR_AUTHOR: "instafy-bot" })), ordinary);
  assert.equal(fs.existsSync(ghLog), false, "the pull_request path must not call gh");
  fs.rmSync(bin, { recursive: true, force: true });
});
