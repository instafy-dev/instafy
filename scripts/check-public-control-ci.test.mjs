import { withoutManualCiRouting } from "./lib/manualCiRoutingTestBaseline.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { withoutImageBuildRouting } from "./lib/imageBuildRoutingTestBaseline.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = file => withoutImageBuildRouting(file, withoutManualCiRouting(file, fs.readFileSync(path.join(root, ".github/workflows", file), "utf8")));
const jobs = [
  { file: "npm-release.yml", key: "select", label: "public-npm-select", name: "Select version or publish mode", minutes: 15,
    tools: ["bash", "git", "curl", "tar", "sha256sum", "unzip", "gh"],
    baseline: "cc6e1f9c78e8ce69b7d34a816d785c71c20febc1c7b7fbc92b95c440a6c78670" },
  { file: "continuous-image-publication.yml", key: "publish", label: "public-image-coordinator", name: "Publish exact protected-main images after CI", minutes: 5,
    tools: ["bash", "gh", "jq", "date"],
    baseline: "3838d5ccfed0f56540dd42251203a5472845aa8abe234e8122b8c2587d7abe6d" },
  { file: "npm-release.yml", key: "pack", label: "public-npm-pack", name: "Test and pack exact npm artifacts", minutes: 25,
    tools: ["bash", "git", "curl", "tar", "sha256sum", "unzip"],
    baseline: "cc6e1f9c78e8ce69b7d34a816d785c71c20febc1c7b7fbc92b95c440a6c78670" },
  { file: "npm-release.yml", key: "version", label: "public-npm-version", name: "Create or update the signed version pull request", minutes: 15,
    tools: ["bash", "git", "curl", "tar", "sha256sum", "unzip", "gh"],
    baseline: "cc6e1f9c78e8ce69b7d34a816d785c71c20febc1c7b7fbc92b95c440a6c78670" },
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

const versionGuard = `      - name: Require exact current protected main before bot authorization
        if: runner.environment == 'self-hosted'
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          current_sha="$(gh api --method GET "repos/instafy-dev/instafy/branches/main" --jq 'select(.name == "main" and .protected == true) | .commit.sha')"
          test "$current_sha" = "$GITHUB_SHA"
          checkout_sha="$(git rev-parse HEAD)"
          test "$checkout_sha" = "$GITHUB_SHA"

`;

function withoutVersionRouting(source) {
  const job = jobs.find(value => value.key === "version"), original = section(job);
  assert.equal(source.split(original).length, 2);
  assert.equal(original.split(versionGuard).length, 2);
  const normalized = original.replace(selector(job)[0], "    runs-on: ubuntu-24.04\n")
    .replace(expectedPreflight(job), "").replace(versionGuard, "");
  return source.replace(original, normalized);
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
    github => { github.workflow_ref = workflowRef(jobs.find(other => other.file !== job.file)); },
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

test("all four routed preflights check exact source identity and baseline tools before any existing step", () => {
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

test("removing only reviewed routing and version freshness guards reconstructs complete original workflows", () => {
  for (const job of jobs) {
    let normalized = job.file === "npm-release.yml" ? withoutVersionRouting(read(job.file)) : read(job.file);
    for (const sibling of jobs.filter(value => value.file === job.file && value.key !== "version")) {
      const selected = selector(sibling)[0], expected = expectedPreflight(sibling);
      assert.equal(normalized.split(selected).length, 2);
      assert.equal(normalized.split(expected).length, 2);
      normalized = normalized.replace(selected, "    runs-on: ubuntu-24.04\n").replace(expected, "");
    }
    assert.equal(createHash("sha256").update(normalized).digest("hex"), job.baseline,
      "all original jobs, commands, permissions, triggers, timeouts, outputs and publication gates must remain exact");
    assert.match(section(job), new RegExp(`^    name: ${job.name}$`, "mu"));
    assert.match(section(job), new RegExp(`^    timeout-minutes: ${job.minutes}$`, "mu"));
  }
});

test("only these four jobs use the separate control switch and release regressions include this file", () => {
  for (const file of fs.readdirSync(path.join(root, ".github/workflows")).filter(file => /\.ya?ml$/u.test(file))) {
    assert.equal((read(file).match(/vars\.CI_PUBLIC_CONTROL_SELF_HOSTED/g) ?? []).length, jobs.filter(job => job.file === file).length);
  }
  assert.match(fs.readFileSync(path.join(root, "scripts/check-public-release-workflows.test.mjs"), "utf8"), /import "\.\/check-public-control-ci\.test\.mjs";/u);
});

test("removing only pack routing reconstructs the exact reviewed control-routing model", () => {
  const job = jobs.find(value => value.key === "pack");
  const normalized = withoutVersionRouting(read(job.file)).replace(selector(job)[0], "    runs-on: ubuntu-24.04\n").replace(expectedPreflight(job), "");
  assert.equal(createHash("sha256").update(normalized).digest("hex"), "f6dee10687239c28d710e8797b09193077ad7a764a9c959b69b25dcc5479db57",
    "all other selectors, permissions, commands, dependencies, artifacts and OIDC publication remain exact to reviewed f2af source");
  const pack = section(job);
  assert.match(pack, /^    needs: select$/mu);
  assert.match(pack, /^    if: \$\{\{ needs\.select\.outputs\.mode == 'publish' \}\}$/mu);
  assert.match(pack, /permissions:\n      actions: read\n      contents: read/u);
  assert.doesNotMatch(pack, /secrets\.|id-token:|environment:|contents: write|actions: write|cache:|pnpm changeset publish/u);
  assert.match(section({ file: job.file, key: "publish" }), /^    runs-on: ubuntu-24\.04$/mu);
  assert.match(section({ file: job.file, key: "publish" }), /environment: npm-release[\s\S]*id-token: write/u);
});

test("version-only additions reconstruct the entire frozen pack workflow and retain the two exact bot-secret uses", () => {
  const source = read("npm-release.yml"), job = jobs.find(value => value.key === "version"), version = section(job);
  assert.equal(createHash("sha256").update(withoutVersionRouting(source)).digest("hex"),
    "a219fe5e3ba2e0ca1f533465ae34caca3e0b1d6d14d1cb258033f6b7948b9523");
  assert.match(version, /^    needs: select\n    if: \$\{\{ needs\.select\.outputs\.mode == 'version' \}\}$/mu);
  assert.match(version, /permissions:\n      contents: read\n\n    steps:/u);
  assert.doesNotMatch(version, /id-token:|environment:|contents: write|actions: write|NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_ENV/u);
  assert.equal((source.match(/secrets\.INSTAFY_BOT_TOKEN/gu) ?? []).length, 2);
  assert.equal((version.match(/secrets\.INSTAFY_BOT_TOKEN/gu) ?? []).length, 2);
  assert.ok(version.includes(versionGuard + "      - name: Require the dedicated instafy-bot credential\n"));
  assert.doesNotMatch(version.slice(0, version.indexOf("      - name: Require the dedicated instafy-bot credential\n")), /secrets\./u);
  assert.ok(version.indexOf(versionGuard) > version.indexOf("run: pnpm install --frozen-lockfile --ignore-scripts"));
  assert.ok(version.indexOf("      - name: Create or update the Changesets version pull request\n") >
    version.indexOf("      - name: Require the dedicated instafy-bot credential\n"));
});

function runVersionGuard({ current = "a".repeat(40), checkout = "a".repeat(40), apiStatus = "0", gitStatus = "0" } = {}) {
  const version = section(jobs.find(value => value.key === "version"));
  assert.ok(version.includes(versionGuard));
  const body = versionGuard.split("        run: |\n")[1].replace(/^          /gmu, "");
  const fixture = `gh() {
  test "$#" = 6 && test "$1" = api && test "$2" = --method && test "$3" = GET &&
    test "$4" = repos/instafy-dev/instafy/branches/main && test "$5" = --jq &&
    test "$6" = 'select(.name == "main" and .protected == true) | .commit.sha' || return 99
  test "$GH_TOKEN" = inert-read-token || return 99
  test -z "\${INSTAFY_BOT_TOKEN+x}" || return 99
  printf '%s\\n' "$INERT_CURRENT"
  return "$INERT_API_STATUS"
}
git() {
  test "$#" = 2 && test "$1" = rev-parse && test "$2" = HEAD || return 99
  printf '%s\\n' "$INERT_CHECKOUT"
  return "$INERT_GIT_STATUS"
}
`;
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", fixture + body + "printf '%s\\n' bot-step-reached\n"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 8192,
    env: { PATH: "/usr/bin:/bin", GITHUB_SHA: "a".repeat(40), GH_TOKEN: "inert-read-token",
      INERT_CURRENT: current, INERT_CHECKOUT: checkout, INERT_API_STATUS: apiStatus, INERT_GIT_STATUS: gitStatus },
  });
}

test("actual version freshness Bash permits only exact current protected-source and checkout before bot exposure", () => {
  const result = runVersionGuard();
  assert.equal(result.status, 0); assert.equal(result.stdout, "bot-step-reached\n"); assert.equal(result.stderr, "");
});

test("actual version freshness Bash refuses missing, stale, malformed, failed API or checkout without reaching bot exposure", () => {
  for (const options of [
    { current: "" }, { current: "null" }, { current: "b".repeat(40) }, { current: "A".repeat(40) },
    { current: "INERT_UNTRUSTED_RESPONSE" }, { current: "a".repeat(40) + "\n" + "a".repeat(40) },
    { apiStatus: "1" }, { apiStatus: "124" }, { checkout: "" }, { checkout: "b".repeat(40) }, { gitStatus: "1" },
  ]) {
    const result = runVersionGuard(options);
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});

test("the exact offline jq projection rejects wrong branch, unprotected and missing or ambiguous SHA responses", () => {
  const filter = versionGuard.match(/--jq '([^']+)'/u)[1];
  for (const [response, allowed] of [
    [{ name: "main", protected: true, commit: { sha: "a".repeat(40) } }, true],
    [{ name: "main", protected: false, commit: { sha: "a".repeat(40) } }, false],
    [{ name: "topic", protected: true, commit: { sha: "a".repeat(40) } }, false],
    [{ name: "main", protected: "true", commit: { sha: "a".repeat(40) } }, false],
    [{ name: "main", commit: { sha: "a".repeat(40) } }, false],
    [{ name: "main", protected: true }, false],
    [{ name: "main", protected: true, commit: { sha: null } }, false],
    [{ name: "main", protected: true, commit: { sha: ["a".repeat(40), "b".repeat(40)] } }, false],
    [{ name: "main", protected: true, commit: { sha: { unexpected: "a".repeat(40) } } }, false],
  ]) {
    const projection = spawnSync("jq", ["-r", filter], { input: JSON.stringify(response), encoding: "utf8",
      timeout: 1000, maxBuffer: 8192, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin" } });
    assert.equal(projection.error, undefined, "offline jq is required; a missing test dependency is not a pass");
    assert.equal(projection.status, 0); assert.equal(projection.stderr, "");
    const result = runVersionGuard({ current: projection.stdout.trimEnd() });
    assert.equal(result.status === 0, allowed);
    assert.equal(result.stdout, allowed ? "bot-step-reached\n" : "");
    assert.equal(result.stderr, "");
  }
});
