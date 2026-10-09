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

// The pull-request-policy job's steps, keyed by name, each with its literal env
// block and its run script as bash receives it.
function policySteps() {
  const source = read("npm-release.yml");
  const job = source.slice(source.indexOf("\n  pull-request-policy:\n") + 1).split(/\n  [\w-]+:\n/u)[0];
  // No job-level env or token: every credential is visible in a step's own env block.
  assert.doesNotMatch(job.slice(0, job.indexOf("\n    steps:\n")), /^    env:|github\.token|secrets\./mu);
  return job.split("\n      - name: ").slice(1).map((text) => {
    const name = text.slice(0, text.indexOf("\n"));
    const env = {};
    const block = text.match(/\n        env:\n((?:          .*\n)+)/u)?.[1] ?? "";
    for (const line of block.split("\n").filter((value) => /^          [A-Z]/u.test(value))) {
      const [, key, value] = line.match(/^          ([A-Z][A-Z0-9_]*): (.*)$/u);
      env[key] = value;
    }
    const marker = "\n        run: |\n";
    const run = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length).split("\n").map((line) => line.slice(10)).join("\n") : "";
    return { name, text, env, run, if: text.match(/^        if: (.*)$/mu)?.[1] };
  });
}

// Evaluates a workflow expression the way Actions does for these operands:
// missing properties are null, and && / || return an operand.
function expression(value, context) {
  const body = value.match(/^\$\{\{ (.+) \}\}$/u)?.[1];
  if (body === undefined) return value;
  const js = body.replace(/\b(github|steps)((?:\.[\w-]+)+)/gu, (_, head, rest) => head + rest.replaceAll(".", "?."))
    .replace(/ == /gu, " === ");
  const result = vm.runInNewContext(js, context, { timeout: 1000 });
  return result === undefined || result === null || result === false ? "" : String(result);
}

test("only the merge-group lookup step, before the checkout, has a token in its env", () => {
  const steps = policySteps();
  const names = steps.map((step) => step.name);
  const lookup = steps.find((step) => step.name === "Read the queued pull request identity");
  const validate = steps.find((step) => step.name === "Validate ordinary or generated release changes");
  for (const step of [lookup, validate]) assert.ok(step.run.startsWith("set -euo pipefail\n"), step.name);
  assert.ok(names.indexOf(lookup.name) < names.indexOf("Checkout the exact pull request commit"), "the lookup must run before any checkout");
  assert.equal(lookup.if, "${{ github.event_name == 'merge_group' }}");
  assert.match(lookup.text, /^        id: queued$/mu);
  assert.deepEqual(Object.keys(lookup.env), ["GH_TOKEN", "MERGE_GROUP_BASE_REF", "MERGE_GROUP_HEAD_REF"]);
  assert.equal(lookup.env.GH_TOKEN, "${{ github.token }}");
  // The lookup runs no checked-out code: no action, interpreter, package
  // manager or repository path, only bash and the runner image's gh.
  assert.doesNotMatch(lookup.text, /uses:|\b(?:node|pnpm|npx|npm|git|curl|source)\b|scripts\/|\.\//u);
  assert.deepEqual([...lookup.run.matchAll(/\bgh (\w+)/gu)].map((match) => match[1]), ["api"]);
  // The policy step has exactly the identity and diff inputs, and no token variable.
  assert.deepEqual(Object.keys(validate.env), ["BASE_SHA", "HEAD_SHA", "HEAD_REF", "HEAD_REPOSITORY", "PULL_REQUEST_AUTHOR"]);
  for (const step of steps) {
    const expected = step === lookup ? 1 : 0;
    assert.equal((step.text.match(/github\.token|secrets\./gu) ?? []).length, expected, step.name);
    assert.equal(Object.keys(step.env).filter((key) => /TOKEN/u.test(key)).length, expected, step.name);
  }
});

test("the queued Changeset policy uses the group's own diff and the queued PR's identity", () => {
  const steps = policySteps();
  const lookup = steps.find((step) => step.name === "Read the queued pull request identity");
  const validate = steps.find((step) => step.name === "Validate ordinary or generated release changes");
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
  // Stub policy: fails if its environment carries any token variable.
  fs.writeFileSync(path.join(bin, "scripts/check-changeset-pr.mjs"),
    'if (Object.keys(process.env).some((key) => /TOKEN/u.test(key))) process.exit(3);\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  const base = "b".repeat(40), head = "c".repeat(40);
  const queueRef = (suffix) => `refs/heads/gh-readonly-queue/main/${suffix}`;
  const ghLog = path.join(bin, "gh.log"), outputs = path.join(bin, "github-output");
  const bash = (script, env) => childProcess.spawnSync("bash", ["-c", script], { cwd: bin, encoding: "utf8", timeout: 10_000,
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "instafy-dev/instafy", ...env } });
  // Runs the job's two steps as Actions would: the lookup only when its if:
  // holds, the policy with its own env block and the lookup's outputs.
  const run = ({ github, pr = {} }) => {
    fs.rmSync(outputs, { force: true });
    fs.writeFileSync(outputs, "");
    const queued = { outputs: {} };
    if (expression(lookup.if, { github })) {
      const env = Object.fromEntries(Object.entries(lookup.env).map(([key, value]) => [key, expression(value, { github })]));
      const result = bash(lookup.run, { ...env, GITHUB_EVENT_NAME: github.event_name, GITHUB_OUTPUT: outputs, GH_LOG: ghLog,
        PR_HEAD_REF: "fix/topic", PR_HEAD_REPO: "instafy-dev/instafy", PR_AUTHOR: "instafy-bot", ...pr });
      if (result.status !== 0) return result;
      for (const line of fs.readFileSync(outputs, "utf8").split("\n").filter(Boolean)) {
        const index = line.indexOf("=");
        queued.outputs[line.slice(0, index)] = line.slice(index + 1);
      }
    }
    const env = Object.fromEntries(Object.entries(validate.env).map(([key, value]) => [key, expression(value, { github, steps: { queued } })]));
    return bash(validate.run, { ...env, GITHUB_EVENT_NAME: github.event_name });
  };
  const group = (merge_group = {}) => ({ event_name: "merge_group", token: "lookup-token", event: { merge_group: {
    base_ref: "refs/heads/main", base_sha: base, head_sha: head, head_ref: queueRef(`pr-12-${"d".repeat(40)}`), ...merge_group } } });
  const args = (result) => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const ordinary = ["--base", base, "--head", head];
  const version = [...ordinary, "--version-pr"];
  assert.deepEqual(args(run({ github: group() })), ordinary);
  assert.deepEqual(args(run({ github: group(), pr: { PR_HEAD_REF: "changeset-release/main" } })), version);
  assert.deepEqual(args(run({ github: group(), pr: { PR_HEAD_REF: "changeset-release/main", PR_AUTHOR: "someone" } })), ordinary);
  assert.deepEqual(args(run({ github: group(), pr: { PR_HEAD_REF: "changeset-release/main", PR_HEAD_REPO: "fork/instafy" } })), ordinary);
  // A deleted head repository is never the generated version PR.
  assert.deepEqual(args(run({ github: group(), pr: { PR_HEAD_REF: "changeset-release/main", PR_HEAD_REPO: "" } })), ordinary);
  // The PR number is the only part of the ref the lane requires; GitHub owns the suffix.
  for (const suffix of ["pr-12-0123abcd", "pr-12", "pr-12-a.b_c/d-e"])
    assert.deepEqual(args(run({ github: group({ head_ref: queueRef(suffix) }), pr: { PR_HEAD_REF: "changeset-release/main" } })), version, suffix);
  for (const merge_group of [{ base_ref: "refs/heads/topic" }, { head_ref: queueRef("other") },
    { head_ref: queueRef("pr-012-abc") }, { head_ref: queueRef("pr-12x") },
    { head_ref: queueRef("pr-12-a b") }, { head_ref: "" },
    { head_ref: `refs/heads/gh-readonly-queue/topic/pr-12-${"d".repeat(40)}` },
    { head_ref: queueRef(`pr-13-${"d".repeat(40)}`) }]) {
    const rejected = run({ github: group(merge_group) });
    assert.notEqual(rejected.status, 0, JSON.stringify(merge_group));
    // The lookup fails before the policy for a group it cannot bind to its
    // queued PR, and publishes no identity.
    assert.doesNotMatch(rejected.stdout, /--base/u, JSON.stringify(merge_group));
    assert.equal(fs.readFileSync(outputs, "utf8"), "", JSON.stringify(merge_group));
  }
  // A pull_request event skips the lookup, keeps the payload identity and never calls gh.
  fs.rmSync(ghLog, { force: true });
  const pull = (user) => ({ event_name: "pull_request", token: "lookup-token", event: { pull_request: {
    base: { sha: base }, head: { sha: head, ref: "changeset-release/main", repo: { full_name: "instafy-dev/instafy" } }, user: { login: user } } } });
  assert.deepEqual(args(run({ github: pull("instafy-bot") })), version);
  assert.deepEqual(args(run({ github: pull("someone") })), ordinary);
  assert.equal(fs.existsSync(ghLog), false, "the pull_request path must not call gh");
  fs.rmSync(bin, { recursive: true, force: true });
});
