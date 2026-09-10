import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, ".github/workflows/git-conflict-canary.yml"), "utf8");
const fixture = source.slice(source.indexOf("      - name: Verify conflict-resolution fixture\n"));
const tools = ["bash", "git", "curl", "tar", "sha256sum", "unzip", "grep", "mktemp", "rm"];

function context(eventName) {
  return {
    repository: "instafy-dev/instafy", repository_id: "1001", run_id: "2002", run_attempt: "1",
    event_name: eventName, ref: eventName === "pull_request" ? "refs/pull/3/merge" : "refs/heads/main",
    ref_protected: eventName !== "pull_request",
    event: { repository: { private: true }, ...(eventName === "pull_request" ? {
      pull_request: {
        base: { ref: "main", repo: { full_name: "instafy-dev/instafy" } },
        head: { repo: { full_name: "instafy-dev/instafy", fork: false } },
      },
    } : {}) },
  };
}

function select(github, toggle = "true") {
  const match = source.match(/^    runs-on: >-\n((?:      .*\n)+)/mu);
  assert.ok(match);
  const expression = match[1].trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
  assert.doesNotMatch(expression, /github\.job\b|matrix\.|inputs\./u);
  return vm.runInNewContext(expression, {
    github,
    vars: { CI_GIT_CONFLICT_SELF_HOSTED: toggle, CI_EXPANDED_SELF_HOSTED: "true", CI_RUNNER_MODE: "self-hosted" },
    fromJSON: JSON.parse,
    format: (template, ...values) => template.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match, index) => match === "{{" ? "{" : match === "}}" ? "}" : String(values[index])),
  }, { timeout: 1000 });
}

test("Git conflict routing is independently default-off", () => {
  for (const event of ["pull_request", "push"]) {
    for (const toggle of ["", "false", "0", "github-hosted", "unknown", null]) {
      assert.equal(select(context(event), toggle), "ubuntu-latest");
    }
  }
  assert.equal((source.match(/vars\.CI_GIT_CONFLICT_SELF_HOSTED/g) ?? []).length, 1);
  assert.doesNotMatch(source, /CI_EXPANDED_SELF_HOSTED|CI_RUNNER_MODE/u);
});

test("eligible PR and main jobs bind exact groups and repository/run/attempt labels", () => {
  for (const event of ["pull_request", "push"]) {
    const github = context(event), trust = event === "pull_request" ? "pr" : "main";
    const runner = select(github);
    assert.deepEqual(runner, {
      group: `org/instafy-ci-${trust}`,
      labels: ["self-hosted", "Linux", "ARM64", "instafy-ci-bootstrap-1001-2002-1-deterministic-conflict", `instafy-ci-trust-${trust}`],
    });
    for (const key of ["repository_id", "run_id", "run_attempt"]) {
      const other = structuredClone(github); other[key] = "9009";
      assert.notEqual(select(other).labels[3], runner.labels[3]);
    }
  }
});

test("public visibility, other repositories and unsupported events retain hosted runners", () => {
  for (const event of ["pull_request", "push"]) {
    for (const mutate of [
      github => { github.event.repository.private = false; },
      github => { github.repository = "someone/instafy"; },
    ]) {
      const github = context(event); mutate(github);
      assert.equal(select(github), "ubuntu-latest");
    }
  }
  for (const event of ["workflow_dispatch", "pull_request_target", "merge_group", "schedule", "workflow_run", "repository_dispatch", "release"]) {
    assert.equal(select(context(event)), "ubuntu-latest");
  }
});

test("PR routing requires a main base and a same-repository non-fork head", () => {
  for (const mutate of [
    github => { github.event.pull_request.base.ref = "topic"; },
    github => { github.event.pull_request.base.repo.full_name = "someone/instafy"; },
    github => { github.event.pull_request.head.repo.full_name = "someone/instafy"; },
    github => { github.event.pull_request.head.repo.fork = true; },
  ]) {
    const github = context("pull_request"); mutate(github);
    assert.equal(select(github), "ubuntu-latest");
  }
  const github = context("pull_request"); github.ref = "refs/heads/main"; github.ref_protected = true;
  assert.equal(select(github).group, "org/instafy-ci-pr");
});

test("push routing requires protected main without reading PR fields", () => {
  for (const mutate of [
    github => { github.ref = "refs/heads/topic"; },
    github => { github.ref = "refs/tags/v1"; },
    github => { github.ref_protected = false; },
  ]) {
    const github = context("push"); mutate(github);
    assert.equal(select(github), "ubuntu-latest");
  }
  assert.equal(select(context("push")).group, "org/instafy-ci-main");
});

function qualify(mutate = () => {}, missingTool) {
  assert.match(source, /    steps:\n      - name: Qualify isolated Git conflict runner\n        if: runner\.environment == 'self-hosted'\n        shell: bash\n        run: \|/u);
  const match = source.match(/          node <<'NODE'\n([\s\S]*?)          NODE\n/u);
  assert.ok(match);
  assert.ok(source.indexOf(match[0]) < source.indexOf("uses: actions/checkout@"));
  const state = {
    platform: "linux", arch: "arm64", getuid: () => 503, versions: { node: "22.23.2" },
    env: { RUNNER_OS: "Linux", RUNNER_ARCH: "ARM64", INSTAFY_CI_JOB_ISOLATION: "ephemeral" },
  };
  mutate(state);
  const observed = [];
  vm.runInNewContext(match[1].replace(/^          /gmu, ""), {
    process: state,
    require(name) {
      if (name === "node:assert/strict") return assert;
      assert.equal(name, "node:child_process");
      return { execFileSync(file, args, options) {
        assert.equal(file, "/bin/bash");
        assert.deepEqual(Array.from(args.slice(0, 3)), ["-c", 'command -v "$1" >/dev/null', "git-conflict-preflight"]);
        assert.equal(options.timeout, 1000);
        assert.equal(options.stdio, "ignore");
        if (args[3] === missingTool) throw new Error("missing required tool");
        observed.push(args[3]);
      } };
    },
  }, { timeout: 1000 });
  return observed;
}

test("self-hosted qualification checks every required tool before checkout", () => {
  assert.deepEqual(qualify(), tools);
  for (const tool of tools) assert.throws(() => qualify(undefined, tool), /missing required tool/u);
});

test("qualification refuses wrong platform, architecture, UID, Node or isolation environment", () => {
  for (const mutate of [
    state => { state.platform = "darwin"; },
    state => { state.arch = "x64"; },
    state => { state.getuid = () => 0; },
    state => { state.getuid = () => undefined; },
    state => { state.versions.node = "20.20.2"; },
    state => { state.versions.node = "24.13.1"; },
    state => { state.env.RUNNER_OS = "macOS"; },
    state => { state.env.RUNNER_ARCH = "X64"; },
    state => { delete state.env.INSTAFY_CI_JOB_ISOLATION; },
    state => { state.env.INSTAFY_CI_JOB_ISOLATION = "persistent"; },
    state => { state.env.INSTAFY_ENV_DIR = "inert-disallowed-configuration"; },
  ]) assert.throws(() => qualify(mutate));
});

test("the workflow retains its identity, bounds, triggers and read-only exact checkout", () => {
  assert.match(source, /^name: Public Git Conflict Contract$/mu);
  assert.match(source, /^  deterministic-conflict:\n    name: Deterministic conflict fixture\n/mu);
  assert.equal((source.match(/^  [\w-]+:\n    name:/gmu) ?? []).length, 1);
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
