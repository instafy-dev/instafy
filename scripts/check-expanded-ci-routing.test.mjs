import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = name => fs.readFileSync(path.join(root, ".github/workflows", name), "utf8");
const jobs = [
  { file: "build.yml", key: "secret-scan", label: "public-secret-scan", name: "Secret scan", minutes: 10, hosted: "ubuntu-latest", events: ["push"] },
  { file: "build.yml", key: "go", label: "public-go", name: "Go packages", minutes: 20, hosted: "ubuntu-latest", events: ["pull_request", "push"] },
  { file: "npm-release.yml", key: "pull-request-policy", label: "public-npm-policy", name: "Require reviewed Changeset release intent", minutes: 15, hosted: "ubuntu-24.04", events: ["pull_request"] },
  { file: "build.yml", key: "rust-fmt", label: "public-rust-fmt", name: "Rust formatting", minutes: 10, hosted: "ubuntu-latest", events: ["pull_request", "push"] },
];

function section(file, key) {
  const source = read(file);
  const start = source.indexOf(`\n  ${key}:\n`);
  assert.ok(start >= 0, `missing ${file}/${key}`);
  return source.slice(start + 1).split(/\n  [\w-]+:\n/u)[0];
}

function select(job, github, toggle = "true") {
  const match = section(job.file, job.key).match(/^    runs-on: >-\n((?:      .*\n)+)/mu);
  assert.ok(match, `missing expanded selector: ${job.key}`);
  const expression = match[1].trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
  assert.doesNotMatch(expression, /github\.job\b|matrix\.|inputs\./u);
  const selected = vm.runInNewContext(expression, {
    github,
    vars: { CI_EXPANDED_SELF_HOSTED: toggle, CI_BOOTSTRAP_SELF_HOSTED: "true", CI_RUNNER_MODE: "self-hosted", CI_TRUSTED_PR_SELF_HOSTED: "true" },
    fromJSON: JSON.parse,
    format: (template, ...values) => template.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match, index) => match === "{{" ? "{" : match === "}}" ? "}" : String(values[index])),
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(selected));
}

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

test("expanded routing is independently default-off for all four literal jobs", () => {
  for (const job of jobs) for (const event of job.events) {
    for (const toggle of [undefined, "", "false", "0", "github-hosted", "unknown"]) {
      assert.equal(select(job, context(event), toggle ?? ""), job.hosted);
    }
  }
});

test("eligible jobs bind the exact group, trust and per-job run-attempt label", () => {
  const labels = new Set();
  for (const job of jobs) for (const event of job.events) {
    const github = context(event), trust = event === "pull_request" ? "pr" : "main";
    const runner = select(job, github);
    assert.deepEqual(runner, {
      group: `org/instafy-ci-${trust}`,
      labels: ["self-hosted", "Linux", "ARM64", `instafy-ci-bootstrap-1001-2002-1-${job.label}`, `instafy-ci-trust-${trust}`],
    });
    assert.ok(!runner.labels.some(label => /^instafy-ci-(?:control|linux-arm64|build)$/u.test(label)));
    labels.add(runner.labels[3]);
    for (const key of ["repository_id", "run_id", "run_attempt"]) {
      const other = structuredClone(github); other[key] = "9009";
      assert.notEqual(select(job, other).labels[3], runner.labels[3]);
    }
  }
  assert.equal(labels.size, 4);
});

test("public visibility, other repositories and unsupported events always stay hosted", () => {
  for (const job of jobs) {
    for (const event of job.events) {
      for (const mutate of [github => { github.event.repository.private = false; }, github => { github.repository = "someone/instafy"; }]) {
        const github = context(event); mutate(github);
        assert.equal(select(job, github), job.hosted);
      }
    }
    for (const event of ["pull_request", "push", "pull_request_target", "workflow_dispatch", "schedule", "merge_group", "release", "workflow_run"]) {
      if (!job.events.includes(event)) assert.equal(select(job, context(event)), job.hosted);
    }
  }
});

test("PR routing requires same-repository non-fork heads and a main base", () => {
  for (const job of jobs.filter(job => job.events.includes("pull_request"))) {
    for (const mutate of [
      github => { github.event.pull_request.base.ref = "topic"; },
      github => { github.event.pull_request.base.repo.full_name = "someone/instafy"; },
      github => { github.event.pull_request.head.repo.full_name = "someone/instafy"; },
      github => { github.event.pull_request.head.repo.fork = true; },
    ]) {
      const github = context("pull_request"); mutate(github);
      assert.equal(select(job, github), job.hosted);
    }
    // A main-shaped event ref cannot select the main group for a PR.
    const github = context("pull_request"); github.ref = "refs/heads/main"; github.ref_protected = true;
    assert.equal(select(job, github).group, "org/instafy-ci-pr");
  }
});

test("push routing requires protected main, without accessing PR payload fields", () => {
  for (const job of jobs.filter(job => job.events.includes("push"))) {
    for (const mutate of [
      github => { github.ref = "refs/heads/topic"; },
      github => { github.ref = "refs/tags/v1"; },
      github => { github.ref_protected = false; },
    ]) {
      const github = context("push"); mutate(github);
      assert.equal(select(job, github), job.hosted);
    }
    assert.equal(select(job, context("push")).group, "org/instafy-ci-main");
  }
});

test("only the four short jobs use the expanded switch and existing identities stay intact", () => {
  for (const file of fs.readdirSync(path.join(root, ".github/workflows")).filter(file => /\.ya?ml$/u.test(file))) {
    assert.equal((read(file).match(/vars\.CI_EXPANDED_SELF_HOSTED/g) ?? []).length, jobs.filter(job => job.file === file).length);
  }
  for (const job of jobs) {
    const source = section(job.file, job.key);
    assert.ok(source.startsWith(`  ${job.key}:\n`));
    assert.ok(source.includes(`    name: ${job.name}\n`));
    assert.ok(source.includes(`    timeout-minutes: ${job.minutes}\n`));
    assert.doesNotMatch(source, /secrets\.|environment:|continue-on-error:|permissions:\s*write-all|CI_BOOTSTRAP_SELF_HOSTED/u);
  }
  for (const key of ["rust", "rust-tests"]) {
    assert.match(section("build.yml", key), /vars\.CI_RUST_SELF_HOSTED == 'true'/u);
    assert.doesNotMatch(section("build.yml", key), /CI_EXPANDED_SELF_HOSTED/u);
  }
  assert.match(section("build.yml", "javascript"), /vars\.CI_JAVASCRIPT_SELF_HOSTED == 'true'/u);
  assert.doesNotMatch(section("build.yml", "javascript"), /CI_EXPANDED_SELF_HOSTED/u);
  for (const key of ["version", "publish"]) assert.match(section("npm-release.yml", key), /^    runs-on: ubuntu-24\.04$/mu);
  for (const key of ["select", "pack"]) {
    assert.match(section("npm-release.yml", key), /vars\.CI_PUBLIC_CONTROL_SELF_HOSTED == 'true'/u);
    assert.doesNotMatch(section("npm-release.yml", key), /CI_EXPANDED_SELF_HOSTED/u);
  }
  assert.match(read("public-boundary.yml"), /vars\.CI_BOOTSTRAP_SELF_HOSTED == 'true'/u);
  assert.doesNotMatch(read("public-boundary.yml"), /CI_EXPANDED_SELF_HOSTED|public-secret-scan|public-go|public-npm-policy|public-rust-fmt/u);
  assert.doesNotMatch(read("browser-e2e.yml"), /CI_EXPANDED_SELF_HOSTED/u);
  assert.equal((read("browser-e2e.yml").match(/vars\.CI_BROWSER_SELF_HOSTED/g) ?? []).length, 2);
});

test("the main scanner preserves the boundary's pinned x64 and ARM64 installer", () => {
  const source = section("build.yml", "secret-scan"), boundary = read("public-boundary.yml");
  for (const key of ["GITLEAKS_VERSION", "GITLEAKS_LINUX_X64_SHA256", "GITLEAKS_LINUX_ARM64_SHA256"]) {
    const pattern = new RegExp(`${key}: "([^"]+)"`, "u");
    assert.equal(source.match(pattern)?.[1], boundary.match(pattern)?.[1]);
    assert.ok(source.match(pattern)?.[1]);
  }
  const architectureCase = /case "\$\(uname -m\)" in[\s\S]*?\n\s+esac/u;
  assert.equal(source.match(architectureCase)?.[0], boundary.match(architectureCase)?.[0]);
  assert.match(source, /gitleaks_\$\{GITLEAKS_VERSION\}_\$\{asset\}\.tar\.gz/u);
  assert.match(source, /"\$checksum" "\$archive" \| sha256sum --check --status/u);
  assert.match(source, /test "\$\(gitleaks version\)" = "\$GITLEAKS_VERSION"/u);
});

test("expanded routing regressions execute in the main scanner and PR policy", () => {
  for (const [file, key] of [["build.yml", "secret-scan"], ["npm-release.yml", "pull-request-policy"]]) {
    assert.match(section(file, key), /scripts\/check-expanded-ci-routing\.test\.mjs/u);
  }
  assert.match(section("npm-release.yml", "pull-request-policy"), /pnpm install --frozen-lockfile --ignore-scripts/u);
});

function preflight(job, mutate = () => {}, missingTool) {
  const source = section(job.file, job.key);
  assert.match(source, /    steps:\n      - name: Qualify isolated expanded CI runner\n        if: runner\.environment == 'self-hosted'\n        shell: bash\n        run: \|/u);
  const match = source.match(/          node <<'NODE'\n([\s\S]*?)          NODE\n/u);
  assert.ok(match);
  assert.ok(source.indexOf(match[0]) < source.indexOf("uses: actions/checkout@"));
  const state = {
    platform: "linux", arch: "arm64", getuid: () => 503, versions: { node: "22.23.2" },
    env: { RUNNER_OS: "Linux", RUNNER_ARCH: "ARM64", INSTAFY_CI_JOB_ISOLATION: "ephemeral" },
  };
  mutate(state);
  const observed = [];
  const program = match[1].replace(/^          /gmu, "");
  vm.runInNewContext(program, { process: state, require(name) {
    if (name === "node:assert/strict") return assert;
    assert.equal(name, "node:child_process");
    return { execFileSync(file, args, options) {
      assert.equal(file, "/bin/bash");
      assert.deepEqual(Array.from(args.slice(0, 3)), ["-c", 'command -v "$1" >/dev/null', "expanded-ci-preflight"]);
      assert.equal(options.timeout, 1000);
      assert.equal(options.stdio, "ignore");
      const tool = args[3];
      if (tool === missingTool) throw new Error("missing required tool");
      observed.push(tool);
    } };
  } }, { timeout: 1000 });
  return observed;
}

test("each expanded job checks actual isolated guest prerequisites before checkout", () => {
  for (const job of jobs) {
    const expected = ["bash", "git", "curl", "tar", "sha256sum", "unzip"];
    if (job.key === "secret-scan") expected.push("sudo", "install");
    if (job.key === "rust-fmt") expected.push("rustup");
    assert.deepEqual(preflight(job), expected);
    for (const tool of expected) assert.throws(() => preflight(job, undefined, tool), /missing required tool/u);
  }
});

test("expanded preflight rejects wrong platform, architecture, UID, runtime and environment", () => {
  const mutations = [
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
  ];
  for (const job of jobs) for (const mutate of mutations) assert.throws(() => preflight(job, mutate));
});
