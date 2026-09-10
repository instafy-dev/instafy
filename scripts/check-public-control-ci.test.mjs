import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = file => fs.readFileSync(path.join(root, ".github/workflows", file), "utf8");
const jobs = [
  { file: "npm-release.yml", key: "select", label: "public-npm-select", name: "Select version or publish mode", minutes: 15,
    tools: ["bash", "git", "curl", "tar", "sha256sum", "unzip", "gh"],
    baseline: "cc6e1f9c78e8ce69b7d34a816d785c71c20febc1c7b7fbc92b95c440a6c78670" },
  { file: "continuous-image-publication.yml", key: "publish", label: "public-image-coordinator", name: "Publish exact protected-main images after CI", minutes: 5,
    tools: ["bash", "gh", "jq", "date"],
    baseline: "3838d5ccfed0f56540dd42251203a5472845aa8abe234e8122b8c2587d7abe6d" },
];
const workflowRef = job => `instafy-dev/instafy/.github/workflows/${job.file}@refs/heads/main`;

function section(job) {
  const source = read(job.file), start = source.indexOf(`\n  ${job.key}:\n`);
  assert.ok(start >= 0);
  return source.slice(start + 1).split(/\n  [\w-]+:\n/u)[0];
}

function selector(job) {
  const match = section(job).match(/^    runs-on: >-\n((?:      .*\n)+)/mu);
  assert.ok(match);
  return match;
}

function context(job) {
  return { repository: "instafy-dev/instafy", repository_id: "1309636737", run_id: "2002", run_attempt: "1",
    event_name: "push", ref: "refs/heads/main", ref_protected: true, workflow_ref: workflowRef(job),
    event: { repository: { private: true } } };
}

function select(job, github = context(job), toggle) {
  if (arguments.length < 3) toggle = "true";
  // GitHub string equality is case-insensitive; plain JavaScript == is not.
  // Translate only the selector's literal comparisons, not its output labels.
  const expression = selector(job)[1].trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(/((?:vars|github)\.[\w.]+) == ('[^']*'|true)/gu, "actionsEqual($1, $2)");
  assert.doesNotMatch(expression, /==/u);
  const value = vm.runInNewContext(expression, {
    github, vars: { CI_PUBLIC_CONTROL_SELF_HOSTED: toggle, CI_EXPANDED_SELF_HOSTED: "true", CI_BOOTSTRAP_SELF_HOSTED: "true", CI_RUNNER_MODE: "self-hosted" },
    actionsEqual: (left, right) => typeof left === "string" && typeof right === "string"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right,
    fromJSON: JSON.parse,
    format: (template, ...values) => template.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match, index) => match === "{{" ? "{" : match === "}}" ? "}" : String(values[index])),
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(value));
}

function expectedPreflight(job) {
  return `      - name: Qualify isolated protected-main control runner
        if: runner.environment == 'self-hosted'
        shell: bash
        run: |
          node <<'NODE'
          const assert = require('node:assert/strict');
          const { execFileSync } = require('node:child_process');
          assert.equal(process.env.GITHUB_REPOSITORY, 'instafy-dev/instafy');
          assert.equal(process.env.GITHUB_REPOSITORY_ID, '1309636737');
          assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
          assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
          assert.equal(process.env.GITHUB_REF_PROTECTED, 'true');
          assert.equal(process.env.GITHUB_WORKFLOW_REF, '${workflowRef(job)}');
          assert.match(process.env.GITHUB_SHA, /^[0-9a-f]{40}$/);
          assert.equal(process.platform, 'linux');
          assert.equal(process.arch, 'arm64');
          assert.ok(Number.isSafeInteger(process.getuid()) && process.getuid() > 0);
          assert.equal(process.versions.node.split('.')[0], '22');
          assert.equal(process.env.RUNNER_OS, 'Linux');
          assert.equal(process.env.RUNNER_ARCH, 'ARM64');
          assert.equal(process.env.INSTAFY_CI_JOB_ISOLATION, 'ephemeral');
          assert.ok(!process.env.INSTAFY_ENV_DIR);
          for (const tool of [${job.tools.map(tool => `'${tool}'`).join(", ")}]) {
            execFileSync('/bin/bash', ['-c', 'command -v "$1" >/dev/null', 'public-control-preflight', tool], { timeout: 1000, stdio: 'ignore' });
          }
${job.key === "publish" ? "          assert.equal(execFileSync('date', ['-u', '-d', '1970-01-01T00:00:00Z', '+%s'], { timeout: 1000, encoding: 'utf8' }).trim(), '0');\n" : ""}          NODE

`;
}

function preflight(job, mutate = () => {}, missingTool, dateResult = "0\n") {
  const source = section(job), expected = expectedPreflight(job);
  assert.ok(source.includes(`    steps:\n${expected}`), "qualification is the exact first step");
  const program = expected.match(/          node <<'NODE'\n([\s\S]*?)          NODE\n/u)[1].replace(/^          /gmu, "");
  const state = { platform: "linux", arch: "arm64", getuid: () => 1000, versions: { node: "22.23.2" },
    env: { GITHUB_REPOSITORY: "instafy-dev/instafy", GITHUB_REPOSITORY_ID: "1309636737", GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", GITHUB_WORKFLOW_REF: workflowRef(job), GITHUB_SHA: "a".repeat(40),
      RUNNER_OS: "Linux", RUNNER_ARCH: "ARM64", INSTAFY_CI_JOB_ISOLATION: "ephemeral" } };
  mutate(state);
  const observed = [];
  vm.runInNewContext(program, { process: state, require(name) {
    if (name === "node:assert/strict") return assert;
    assert.equal(name, "node:child_process");
    return { execFileSync(file, args, options) {
      assert.equal(options.timeout, 1000);
      if (file === "date") {
        assert.equal(job.key, "publish");
        assert.deepEqual(Array.from(args), ["-u", "-d", "1970-01-01T00:00:00Z", "+%s"]);
        assert.equal(options.encoding, "utf8");
        observed.push("GNU date parse");
        return dateResult;
      }
      assert.equal(file, "/bin/bash");
      assert.deepEqual(Array.from(args.slice(0, 3)), ["-c", 'command -v "$1" >/dev/null', "public-control-preflight"]);
      assert.equal(options.stdio, "ignore");
      if (args[3] === missingTool) throw new Error("missing required tool");
      observed.push(args[3]);
    } };
  } }, { timeout: 1000 });
  return observed;
}

test("public control routing is independently default-off even when existing CI switches are enabled", () => {
  for (const job of jobs) for (const toggle of [undefined, "", "false", "0", "unknown", null]) {
    assert.equal(select(job, context(job), toggle), "ubuntu-24.04");
  }
});

test("GitHub case-folded opt-in and identity selection do not weaken exact preflight identity checks", () => {
  for (const job of jobs) {
    for (const toggle of ["TRUE", "TrUe"]) assert.deepEqual(select(job, context(job), toggle), select(job));
    for (const [key, envKey] of [["repository", "GITHUB_REPOSITORY"], ["event_name", "GITHUB_EVENT_NAME"],
      ["ref", "GITHUB_REF"], ["workflow_ref", "GITHUB_WORKFLOW_REF"]]) {
      const github = context(job); github[key] = github[key].toUpperCase();
      assert.deepEqual(select(job, github), select(job));
      assert.throws(() => preflight(job, state => { state.env[envKey] = github[key]; }));
    }
  }
});

test("only exact protected-main pushes select literal main-group run-attempt labels", () => {
  for (const job of jobs) {
    assert.deepEqual(select(job), { group: "org/instafy-ci-main", labels: ["self-hosted", "Linux", "ARM64",
      `instafy-ci-bootstrap-1309636737-2002-1-${job.label}`, "instafy-ci-trust-main"] });
    for (const key of ["run_id", "run_attempt"]) {
      const github = context(job); github[key] = "9009";
      assert.notEqual(select(job, github).labels[3], select(job).labels[3]);
    }
  }
});

test("public visibility, repository identity drift, unprotected refs and wrong workflow refs stay hosted", () => {
  for (const job of jobs) for (const mutate of [
    github => { github.event.repository.private = false; }, github => { delete github.event.repository.private; },
    github => { github.repository = "someone/instafy"; }, github => { github.repository_id = "1309636738"; },
    github => { delete github.repository_id; }, github => { github.ref_protected = false; },
    github => { delete github.ref_protected; }, github => { github.ref = "refs/heads/topic"; },
    github => { github.ref = "refs/tags/v1"; }, github => { github.workflow_ref = workflowRef(job).replace("@refs/heads/main", "@refs/heads/topic"); },
    github => { github.workflow_ref = workflowRef(jobs.find(other => other !== job)); },
  ]) {
    const github = context(job); mutate(github);
    assert.equal(select(job, github), "ubuntu-24.04");
  }
});

test("PR, fork, scheduled, manual and all unsupported event shapes stay hosted", () => {
  for (const job of jobs) for (const event of ["pull_request", "pull_request_target", "workflow_dispatch", "schedule", "workflow_run", "repository_dispatch", "merge_group", "release"]) {
    const github = context(job); github.event_name = event;
    github.event.pull_request = { head: { repo: { fork: true, full_name: "someone/instafy" } } };
    assert.equal(select(job, github), "ubuntu-24.04");
  }
});

test("both control preflights check exact source identity and baseline tools before any existing step", () => {
  for (const job of jobs) {
    assert.deepEqual(preflight(job), [...job.tools, ...(job.key === "publish" ? ["GNU date parse"] : [])]);
    for (const tool of job.tools) assert.throws(() => preflight(job, undefined, tool), /missing required tool/u);
    for (const key of ["GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_REF_PROTECTED", "GITHUB_WORKFLOW_REF", "GITHUB_SHA"]) {
      for (const value of [undefined, "wrong", "TRUE"]) assert.throws(() => preflight(job, state => { state.env[key] = value; }));
    }
    assert.throws(() => preflight(job, state => { state.env.GITHUB_SHA = "A".repeat(40); }));
  }
  for (const value of ["", "1\n", "invalid date"]) assert.throws(() => preflight(jobs[1], undefined, undefined, value));
});

test("control preflights reject nonisolated, root, wrong-platform, runtime or private-environment execution", () => {
  for (const job of jobs) for (const mutate of [
    state => { state.platform = "darwin"; }, state => { state.arch = "x64"; }, state => { state.getuid = () => 0; },
    state => { state.getuid = () => undefined; }, state => { state.versions.node = "20.20.2"; }, state => { state.versions.node = "24.13.1"; },
    state => { state.env.RUNNER_OS = "macOS"; }, state => { state.env.RUNNER_ARCH = "X64"; },
    state => { delete state.env.INSTAFY_CI_JOB_ISOLATION; }, state => { state.env.INSTAFY_CI_JOB_ISOLATION = "persistent"; },
    state => { state.env.INSTAFY_ENV_DIR = "inert-disallowed-directory"; },
  ]) assert.throws(() => preflight(job, mutate));
});

test("removing only the two selectors and exact first preflights reconstructs complete protected-main workflows", () => {
  for (const job of jobs) {
    const source = read(job.file), selected = selector(job)[0], expected = expectedPreflight(job);
    assert.equal(source.split(selected).length, 2);
    assert.equal(source.split(expected).length, 2);
    const normalized = source.replace(selected, "    runs-on: ubuntu-24.04\n").replace(expected, "");
    assert.equal(createHash("sha256").update(normalized).digest("hex"), job.baseline,
      "all original jobs, commands, permissions, triggers, timeouts, outputs and publication gates must remain exact");
    assert.match(section(job), new RegExp(`^    name: ${job.name}$`, "mu"));
    assert.match(section(job), new RegExp(`^    timeout-minutes: ${job.minutes}$`, "mu"));
  }
});

test("only these two jobs use the separate control switch and release regressions include this file", () => {
  for (const file of fs.readdirSync(path.join(root, ".github/workflows")).filter(file => /\.ya?ml$/u.test(file))) {
    assert.equal((read(file).match(/vars\.CI_PUBLIC_CONTROL_SELF_HOSTED/g) ?? []).length, jobs.filter(job => job.file === file).length);
  }
  assert.match(fs.readFileSync(path.join(root, "scripts/check-public-release-workflows.test.mjs"), "utf8"), /import "\.\/check-public-control-ci\.test\.mjs";/u);
});
