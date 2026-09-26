import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { coordinatorBuildPreflight, withoutImageBuildRouting } from "./lib/imageBuildRoutingTestBaseline.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = file => fs.readFileSync(path.join(root, ".github/workflows", file), "utf8");
const files = ["publish-production-services.yml", "publish-runtime-agent.yml", "continuous-image-publication.yml"];
const builds = { group: "org/instafy-trusted-build", labels: ["self-hosted", "Linux", "X64", "instafy-build"] };
const ref = file => `instafy-dev/instafy/.github/workflows/${file}@refs/heads/main`;
const context = (file, event = "workflow_dispatch") => ({ repository: "instafy-dev/instafy", repository_id: "1309636737",
  event: { repository: { private: true } }, event_name: event, ref: "refs/heads/main", ref_protected: true,
  workflow_ref: ref(file), workflow_sha: "a".repeat(40), sha: "a".repeat(40), run_id: "2002", run_attempt: "1" });
const sections = file => [...read(file).matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gmu)]
  .map(match => ({ file, key: match[1], source: match[0] })).filter(job => /^    runs-on:/mu.test(job.source));
const jobs = files.flatMap(sections);
function expression(source, values) {
  // Actions literal string comparisons are case-insensitive. Other fixture
  // fields are exact typed values; no general expression evaluator is claimed.
  const js = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(/((?:vars|github|runner)\.[\w.]+) == ('[^']*'|true)/gu, "actionsEqual($1, $2)");
  return vm.runInNewContext(js, { ...values, fromJSON: JSON.parse,
    actionsEqual: (a, b) => typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b,
    format: (template, ...args) => template.replace(/\{\{|\}\}|\{(\d+)\}/gu,
      (match, index) => match === "{{" ? "{" : match === "}}" ? "}" : String(args[index])),
  }, { timeout: 1000 });
}
function select(job, github = context(job.file), mode = "self-hosted", extra = {}) {
  const source = job.source.match(/^    runs-on: >-\n((?:      .*\n)+)/mu)?.[1];
  assert.ok(source);
  const value = expression(source, { github, inputs: { commit_sha: "a".repeat(40) }, matrix: { runner: "ubuntu-24.04-arm" },
    vars: { TRUSTED_AMD64_BUILD_RUNNER_MODE: mode, CI_PUBLIC_CONTROL_SELF_HOSTED: "false",
      TRUSTED_BUILD_RUNNER_MODE: "self-hosted", CI_RUNNER_MODE: "self-hosted" }, ...extra });
  return JSON.parse(JSON.stringify(value));
}
const hosted = job => job.file === files[2] ? "ubuntu-24.04" : job.key === "build-scan-push" ? "ubuntu-24.04-arm" : "ubuntu-latest";

test("exactly nine image jobs use the independent trusted BUILD route", () => {
  assert.deepEqual(jobs.map(job => [job.file, job.key]), [
    ...["authorize", "release-approval", "publish", "manifest"].map(key => [files[0], key]),
    ...["authorize", "release-approval", "build-scan-push", "assemble-release-manifest"].map(key => [files[1], key]),
    [files[2], "publish"],
  ]);
  for (const job of jobs) {
    assert.deepEqual(select(job), builds);
    assert.equal(select(job, undefined, "self-hosted", { vars: {} }), hosted(job));
    for (const mode of ["", "false", "tinycow", "github-hosted", "unknown", null]) assert.equal(select(job, undefined, mode), hosted(job));
    assert.deepEqual(select(job, undefined, "SELF-HOSTED"), builds);
  }
});

test("new routes refuse public visibility, PRs, wrong identity, unprotected refs and mismatched source", () => {
  for (const job of jobs) for (const mutate of [
    g => { g.repository = "someone/instafy"; }, g => { g.repository_id = "1309636738"; },
    g => { delete g.repository_id; }, g => { g.event.repository.private = false; }, g => { delete g.event.repository.private; },
    g => { g.event_name = "pull_request"; }, g => { g.event_name = "pull_request_target"; },
    g => { g.event_name = "workflow_run"; }, g => { g.event_name = "repository_dispatch"; },
    g => { g.ref = "refs/heads/topic"; }, g => { g.ref = "refs/tags/release"; },
    g => { g.ref_protected = false; }, g => { delete g.ref_protected; },
    g => { g.workflow_ref = ref(job.file).replace("@refs/heads/main", "@refs/heads/topic"); },
    g => { g.workflow_ref = ref(job.file === files[0] ? files[1] : files[0]); },
    g => { g.workflow_sha = "b".repeat(40); }, g => { g.sha = "b".repeat(40); },
  ]) {
    const github = context(job.file); mutate(github);
    assert.equal(select(job, github), hosted(job), `${job.file}/${job.key}`);
  }
  for (const job of jobs) assert.equal(select(job, undefined, "self-hosted", { inputs: { commit_sha: "b".repeat(40) } }), hosted(job));
});

test("only reconciliation admits schedules; its existing isolated push route stays first and exact", () => {
  for (const job of jobs) {
    assert.equal(select(job, context(job.file, "push")), hosted(job));
    const value = select(job, context(job.file, "schedule"));
    if (job.file === files[2]) assert.deepEqual(value, builds); else assert.equal(value, hosted(job));
  }
  const job = jobs.at(-1);
  const vars = { TRUSTED_AMD64_BUILD_RUNNER_MODE: "self-hosted", CI_PUBLIC_CONTROL_SELF_HOSTED: "true" };
  assert.deepEqual(select(job, context(job.file, "push"), "self-hosted", { vars }), {
    group: "org/instafy-ci-main", labels: ["self-hosted", "Linux", "ARM64",
      "instafy-ci-bootstrap-1309636737-2002-1-public-image-coordinator", "instafy-ci-trust-main"],
  });
  assert.deepEqual(select(job, context(job.file, "schedule"), "self-hosted", { vars }), builds);
});

function runPreflight(mutate = () => {}, missingTool, dateOutput = "0\n") {
  assert.ok(read(files[2]).includes(coordinatorBuildPreflight));
  const program = coordinatorBuildPreflight.match(/          node <<'NODE'\n([\s\S]*?)          NODE\n/u)[1].replace(/^          /gmu, "");
  const state = { platform: "linux", arch: "x64", getuid: () => 1000, versions: { node: "22.23.2" }, env: {
    GITHUB_REPOSITORY: "instafy-dev/instafy", GITHUB_REPOSITORY_ID: "1309636737", GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", GITHUB_WORKFLOW_REF: ref(files[2]),
    GITHUB_SHA: "a".repeat(40), GITHUB_WORKFLOW_SHA: "a".repeat(40), RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
  } };
  mutate(state);
  const tools = [];
  vm.runInNewContext(program, { process: state, require(name) {
    if (name === "node:assert/strict") return assert;
    assert.equal(name, "node:child_process");
    return { execFileSync(file, args, options) {
      assert.equal(options.timeout, 1000);
      if (file === "date") {
        assert.deepEqual(Array.from(args), ["-u", "-d", "1970-01-01T00:00:00Z", "+%s"]);
        assert.equal(options.encoding, "utf8"); return dateOutput;
      }
      assert.equal(file, "/bin/bash"); assert.equal(options.stdio, "ignore");
      assert.deepEqual(Array.from(args.slice(0, 3)), ["-c", 'command -v "$1" >/dev/null', "public-image-build-preflight"]);
      if (args[3] === missingTool) throw new Error("missing tool");
      tools.push(args[3]);
    } };
  } }, { timeout: 1000 });
  return tools;
}

test("actual reconciliation preflight accepts trusted X64 schedule/manual without claiming the isolated ARM profile", () => {
  assert.deepEqual(runPreflight(), ["bash", "gh", "jq", "date"]);
  assert.deepEqual(runPreflight(s => { s.env.GITHUB_EVENT_NAME = "workflow_dispatch"; }), ["bash", "gh", "jq", "date"]);
  assert.doesNotMatch(coordinatorBuildPreflight, /INSTAFY_CI_JOB_ISOLATION|secrets\.|GH_TOKEN|GITHUB_TOKEN/u);
  const workflow = read(files[2]);
  assert.ok(workflow.indexOf(coordinatorBuildPreflight) < workflow.indexOf("      - name: Authorize the exact current protected-main commit\n"));
  assert.match(coordinatorBuildPreflight, /if: runner\.environment == 'self-hosted' && \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)/u);
});

test("actual reconciliation preflight rejects incorrect source, runtime, UID and missing tools", () => {
  for (const key of ["GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_EVENT_NAME", "GITHUB_REF",
    "GITHUB_REF_PROTECTED", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "GITHUB_SHA", "RUNNER_OS", "RUNNER_ARCH"])
    for (const value of [undefined, "wrong", "TRUE"]) assert.throws(() => runPreflight(s => { s.env[key] = value; }));
  for (const mutate of [s => { s.platform = "darwin"; }, s => { s.arch = "arm64"; }, s => { s.getuid = () => 0; },
    s => { s.getuid = () => undefined; }, s => { s.versions.node = "20.20.2"; }, s => { s.versions.node = "24.13.1"; },
    s => { s.env.INSTAFY_ENV_DIR = "/inert/private"; }, s => { s.env.GITHUB_EVENT_NAME = "push"; },
  ]) assert.throws(() => runPreflight(mutate));
  for (const tool of ["bash", "gh", "jq", "date"]) assert.throws(() => runPreflight(undefined, tool), /missing tool/u);
  for (const value of ["", "1\n", "invalid date"]) assert.throws(() => runPreflight(undefined, undefined, value));
});

test("Trivy follows the actual BUILD runner while both hosted matrix binaries and target platforms remain intact", () => {
  const source = read(files[1]);
  const env = source.slice(source.indexOf("      - name: Install pinned Trivy\n"));
  for (const [environment, architecture] of [["self-hosted", "amd64"], ["self-hosted", "arm64"], ["github-hosted", "amd64"], ["github-hosted", "arm64"]]) {
    const x64 = environment === "self-hosted" || architecture === "amd64";
    const matrix = { trivy_asset: architecture === "amd64" ? "Linux-64bit" : "Linux-ARM64",
      trivy_sha256: architecture === "amd64" ? "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea" : "2ca2c023109c2db6b2b77366b6717291452d4531167377d95c79547f0c8e3467" };
    const values = { runner: { environment }, matrix };
    assert.equal(expression(env.match(/^          TRIVY_ASSET: (.+)$/mu)[1], values), x64 ? "Linux-64bit" : "Linux-ARM64");
    assert.equal(expression(env.match(/^          TRIVY_SHA256: (.+)$/mu)[1], values), x64
      ? "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea" : "2ca2c023109c2db6b2b77366b6717291452d4531167377d95c79547f0c8e3467");
  }
  assert.equal((source.match(/platform: linux\/amd64/gu) ?? []).length, 2);
  assert.equal((source.match(/platform: linux\/arm64/gu) ?? []).length, 2);
  assert.match(source, /platforms: \$\{\{ matrix\.platform \}\}/u);
});

test("only self-hosted x86 image builds select the pinned x86 BuildKit instead of the ARM daemon's QEMU fallback", () => {
  const pinned = "image=moby/buildkit@sha256:040d34121c27906c4ff9ac152a30d52bf2c5d328d3bb748916bb3d2743c02528";
  for (const file of files.slice(0, 2)) {
    const options = [...read(file).matchAll(/^          driver-opts: (.+)$/gmu)];
    assert.equal(options.length, 1, "only the image-build job overrides BuildKit");
    const build = sections(file).find(job => job.key === (file === files[0] ? "publish" : "build-scan-push"));
    assert.ok(build.source.includes(options[0][0]));
    for (const environment of ["self-hosted", "github-hosted", "", undefined]) {
      for (const architecture of ["amd64", "arm64"]) {
        const value = expression(options[0][1], { runner: { environment }, matrix: { architecture } });
        const x86Build = file === files[0] || architecture === "amd64";
        assert.equal(value, environment === "self-hosted" && x86Build ? pinned : "");
      }
    }
    assert.throws(() => withoutImageBuildRouting(file, read(file).replace(pinned, "image=moby/buildkit:latest")));
  }
});

test("only self-hosted image cache exports are bounded and optional, without retaining builder volumes", () => {
  const services = read(files[0]);
  const runtime = read(files[1]);
  const serviceExpression = services.match(/^          CACHE_EXPORT_OPTIONS: (.+)$/mu)[1];
  const runtimeExpression = runtime.match(/^          cache-to: .*(\$\{\{ runner.environment .*\}\})$/mu)[1];
  for (const environment of ["self-hosted", "SELF-HOSTED", "github-hosted", "", undefined]) {
    const values = { runner: { environment } };
    const expected = environment?.toLowerCase() === "self-hosted" ? ",timeout=2m,ignore-error=true" : "";
    assert.equal(expression(serviceExpression, values), expected);
    assert.equal(expression(runtimeExpression, values), expected);
  }
  assert.ok(services.includes('--cache-to "type=gha,scope=production-${CACHE_KEY},mode=max${CACHE_EXPORT_OPTIONS}"'));
  for (const file of files.slice(0, 2)) {
    assert.doesNotMatch(read(file), /keep-state:|cleanup: false|continue-on-error:/u);
    assert.throws(() => withoutImageBuildRouting(file, read(file).replace("timeout=2m", "timeout=20m")));
    assert.notEqual(withoutImageBuildRouting(file, read(file).replace("--exit-code 1", "--exit-code 0")),
      withoutImageBuildRouting(file, read(file)), "the inverse must not erase a weakened security scan");
  }
});

test("removing only the finite routing, builder, cache and scanner-host delta reconstructs every original workflow byte", () => {
  const pins = ["bf62fdc525afaa581c15984a6aa1f5c93376b3df7809fd33ce846230a82bf7a5",
    "4e9a90476ec106fa63f9e3fbaa7324102bb4513e27d3aca59ecf18142d321e16", "c5584cf3c352c4188666235a80825ccd87e73ea33c08083d23ca7ee8f2847c4c"];
  for (const [index, file] of files.entries()) assert.equal(createHash("sha256").update(withoutImageBuildRouting(file, read(file))).digest("hex"), pins[index]);
  const enrolled = fs.readFileSync(path.join(root, "scripts/check-public-release-workflows.test.mjs"), "utf8");
  assert.match(enrolled, /import "\.\/check-image-build-routing\.test\.mjs";/u);
  assert.match(read("build.yml"), /scripts\/check-public-release-workflows\.test\.mjs/u);
  assert.doesNotMatch(read("npm-release.yml"), /TRUSTED_AMD64_BUILD_RUNNER_MODE/u);
});
