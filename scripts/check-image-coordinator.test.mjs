import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(new URL("../.github/workflows/continuous-image-publication.yml", import.meta.url), "utf8");
const sha = "a".repeat(40);
const repo = "instafy-dev/instafy";
const prefix = `repos/${repo}/actions/`;
const ciPath = `${prefix}workflows/build.yml/runs?head_sha=${sha}&per_page=100`;
const buildRunPath = `${prefix}runs/77`;
const servicePath = `${prefix}workflows/publish-production-services.yml/runs`;
const runtimePath = `${prefix}workflows/publish-runtime-agent.yml/runs`;
const steps = {
  source: "Authorize the exact current protected-main commit",
  ci: "Inspect exact protected-main CI without waiting",
  manifests: "Reconcile exact publishers and manifest freshness",
  dispatch: "Dispatch missing immutable image publishers without waiting",
};

function body(name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1);
  const next = source.indexOf("\n      - name:", start + 1);
  const step = source.slice(start, next < 0 ? undefined : next);
  const script = step.slice(step.indexOf("        run: |\n") + 15);
  return script.split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

function run(name, responses, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-coordinator-test-"));
  try {
    const fixture = path.join(dir, "responses.json");
    const calls = path.join(dir, "calls.jsonl");
    const output = path.join(dir, "output");
    const summary = path.join(dir, "summary");
    fs.writeFileSync(fixture, JSON.stringify(responses));
    fs.writeFileSync(calls, "");
    fs.writeFileSync(output, "");
    fs.writeFileSync(summary, "");
    // Every gh invocation is inert and exact-endpoint matched. No real gh or token
    // is inherited; unexpected reads or writes fail instead of reaching GitHub.
    fs.writeFileSync(path.join(dir, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const endpoint = args.find(value => value.startsWith('repos/'));
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
const input = method === 'POST' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.CALLS, JSON.stringify({ method, endpoint, args, input }) + '\\n');
const responses = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
if (!Object.hasOwn(responses, endpoint) || responses[endpoint]?.error) process.exit(19);
const value = responses[endpoint];
process.stdout.write(typeof value === 'string' ? value + '\\n' : JSON.stringify(value));
`, { mode: 0o700 });
    // GNU date's two used forms, implemented portably for this offline fixture.
    fs.writeFileSync(path.join(dir, "date"), `#!${process.execPath}
const args = process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(['-u', '+%s'])) process.stdout.write('1789012800\\n');
else if (args.length === 4 && args[0] === '-u' && args[1] === '-d' && args[3] === '+%s' && Number.isFinite(Date.parse(args[2]))) process.stdout.write(String(Date.parse(args[2]) / 1000) + '\\n');
else process.exit(17);
`, { mode: 0o700 });
    const result = spawnSync("/bin/bash", ["-c", body(name)], {
      encoding: "utf8", timeout: 10_000,
      env: {
        PATH: `${dir}:/opt/homebrew/bin:/usr/bin:/bin`, GH_TOKEN: "inert-fixture",
        FIXTURE: fixture, CALLS: calls, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: repo, RELEASE_COMMIT: sha, ...extraEnv,
      },
    });
    return { ...result, output: fs.readFileSync(output, "utf8"), summary: fs.readFileSync(summary, "utf8"),
      calls: fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function workflowRun(id, workflow, status = "completed", conclusion = "success") {
  return { id, repository: { full_name: repo }, path: `.github/workflows/${workflow}`,
    event: workflow === "build.yml" ? "push" : "workflow_dispatch", head_sha: sha,
    head_branch: "main", status, conclusion: status === "completed" ? conclusion : null };
}
function inventory(...workflow_runs) { return { total_count: workflow_runs.length, workflow_runs }; }
function manifests(overrides = {}) { return { [servicePath]: inventory(), [runtimePath]: inventory(), ...overrides }; }
function artifact(name, changes = {}) {
  return { name, expired: false, digest: `sha256:${"b".repeat(64)}`, expires_at: "2035-01-01T00:00:00Z", ...changes };
}
function artifacts(...items) { return { total_count: items.length, artifacts: items }; }
function passed(result) { assert.equal(result.status, 0, result.stderr + result.stdout); }

test("coordinator's real Bash is syntactically valid and contains no polling", () => {
  for (const name of Object.values(steps)) {
    const result = spawnSync("/bin/bash", ["-n"], { input: body(name), encoding: "utf8" });
    passed(result);
    assert.doesNotMatch(body(name), /\bsleep\b|\bdeadline\b|while\s*\(\(/u);
  }
});

for (const status of ["absent", "queued", "in_progress", "waiting", "pending", "requested"]) {
  test(`exact Build ${status} defers in one read without dispatch`, () => {
    const result = run(steps.ci, { [ciPath]: status === "absent" ? inventory() : inventory(workflowRun(1, "build.yml", status)) });
    passed(result); assert.equal(result.output, "ready=false\n");
    assert.match(result.summary, /deferred/u); assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].method, "GET");
  });
}
test("only completed successful exact Build opens publication", () => {
  const result = run(steps.ci, { [ciPath]: inventory(workflowRun(1, "build.yml")) });
  passed(result); assert.equal(result.output, "ready=true\n");
  const mixed = run(steps.ci, { [ciPath]: inventory(workflowRun(1, "build.yml"), workflowRun(2, "build.yml", "queued")) });
  passed(mixed); assert.equal(mixed.output, "ready=false\n");
});
for (const change of [{ conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: "skipped" },
  { head_sha: "b".repeat(40) },
  { head_branch: "other" }, { path: ".github/workflows/other.yml" }, { repository: { full_name: "other/repo" } }, { status: "unknown" }]) {
  test(`Build refuses ${JSON.stringify(change)}`, () => {
    const result = run(steps.ci, { [ciPath]: inventory({ ...workflowRun(1, "build.yml"), ...change }) });
    assert.notEqual(result.status, 0); assert.equal(result.output, "");
  });
}
test("the Build listing never uses the stale event-filtered index and ignores non-push Builds", () => {
  const result = run(steps.ci, { [ciPath]: inventory(workflowRun(1, "build.yml")) });
  passed(result);
  assert.equal(result.calls.length, 1);
  assert.doesNotMatch(result.calls[0].endpoint, /event=/u);
  for (const event of ["pull_request", "workflow_dispatch"]) {
    const ignored = run(steps.ci, { [ciPath]: inventory({ ...workflowRun(1, "build.yml"), event }) });
    passed(ignored); assert.equal(ignored.output, "ready=false\n");
    const mixed = run(steps.ci, { [ciPath]: inventory({ ...workflowRun(1, "build.yml"), event }, workflowRun(2, "build.yml")) });
    passed(mixed); assert.equal(mixed.output, "ready=true\n");
  }
});
test("a Build completion is decided by reading that exact Build run, not a listing", () => {
  const env = { BUILD_RUN_ID: "77" };
  const ok = run(steps.ci, { [buildRunPath]: { ...workflowRun(77, "build.yml") } }, env);
  passed(ok); assert.equal(ok.output, "ready=true\n");
  assert.deepEqual(ok.calls.map(({ endpoint }) => endpoint), [buildRunPath]);
  const stale = run(steps.ci, { [buildRunPath]: workflowRun(77, "build.yml", "in_progress") }, env);
  passed(stale); assert.equal(stale.output, "ready=false\n"); assert.match(stale.summary, /deferred/u);
  for (const change of [{ conclusion: "failure" }, { head_sha: "b".repeat(40) }, { event: "pull_request" },
    { head_branch: "other" }, { path: ".github/workflows/other.yml" }, { repository: { full_name: "other/repo" } }]) {
    const refused = run(steps.ci, { [buildRunPath]: { ...workflowRun(77, "build.yml"), ...change } }, env);
    assert.notEqual(refused.status, 0, JSON.stringify(change)); assert.equal(refused.output, "");
  }
  for (const id of ["0", "12a", "-1"]) {
    assert.notEqual(run(steps.ci, { [buildRunPath]: workflowRun(77, "build.yml") }, { BUILD_RUN_ID: id }).status, 0);
  }
});
test("a Build completion for a commit main has moved past yields without error", () => {
  const moved = run(steps.source, {}, {
    GITHUB_EVENT_NAME: "workflow_run", REQUESTED_COMMIT: sha, GITHUB_SHA: "b".repeat(40) });
  passed(moved); assert.equal(moved.output, "current=false\n"); assert.equal(moved.calls.length, 0);
  const current = run(steps.source, { [`repos/${repo}/commits/main`]: sha }, {
    GITHUB_EVENT_NAME: "workflow_run", REQUESTED_COMMIT: sha, GITHUB_SHA: sha });
  passed(current); assert.equal(current.output, `current=true\ncommit_sha=${sha}\n`);
  const manual = run(steps.source, {}, {
    GITHUB_EVENT_NAME: "workflow_dispatch", REQUESTED_COMMIT: sha, GITHUB_SHA: "b".repeat(40) });
  assert.notEqual(manual.status, 0);
});
test("only the exact successful protected-main push Build of this repository can start a pass", () => {
  const trigger = source.slice(source.indexOf("on:\n"), source.indexOf("\npermissions:"));
  assert.match(trigger, /  workflow_run:\n    workflows: \[Public Build\]\n    types: \[completed\]\n    branches: \[main\]\n/u);
  const guard = source.slice(source.indexOf("    if: >-\n"), source.indexOf("    runs-on:"));
  for (const clause of [
    "github.repository == 'instafy-dev/instafy'",
    "github.ref == 'refs/heads/main'",
    "github.event_name != 'workflow_run' || (",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.path == '.github/workflows/build.yml'",
    "github.event.workflow_run.repository.full_name == 'instafy-dev/instafy'",
    "github.event.workflow_run.head_repository.full_name == 'instafy-dev/instafy'",
  ]) assert.ok(guard.includes(clause), clause);
  // A Build completion never selects a self-hosted runner or gains inputs.
  const runsOn = source.slice(source.indexOf("    runs-on:"), source.indexOf("    timeout-minutes:"));
  assert.doesNotMatch(runsOn, /workflow_run/u);
  assert.match(source, /REQUESTED_COMMIT: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.commit_sha \|\| github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/u);
  assert.match(source, /BUILD_RUN_ID: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.id \|\| '' \}\}/u);
  assert.doesNotMatch(source, /event=workflow_dispatch|event=push/u);
});
test("Build API failure or incomplete inventory cannot dispatch", () => {
  for (const value of [{ error: true }, { total_count: 101, workflow_runs: [] }, { total_count: 1, workflow_runs: [] }]) {
    assert.notEqual(run(steps.ci, { [ciPath]: value }).status, 0);
  }
});
test("two missing publishers are eligible, with exactly two bounded history reads", () => {
  const result = run(steps.manifests, manifests()); passed(result);
  assert.equal(result.output, "services_publish=true\nruntime_publish=true\npending=false\npublish=true\n");
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every(({ method, args }) => method === "GET" && !args.includes("status=success")));
});
for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
  test(`an exact ${status} publisher defers without a duplicate`, () => {
    const result = run(steps.manifests, manifests({ [servicePath]: inventory(workflowRun(2, "publish-production-services.yml", status)) }));
    passed(result); assert.match(result.output, /pending=true\npublish=false/u);
    assert.match(result.summary, /no duplicate/u); assert.equal(result.calls.length, 2);
  });
}
test("two fresh sealed exact manifests are verified without dispatch", () => {
  const result = run(steps.manifests, manifests({
    [servicePath]: inventory(workflowRun(2, "publish-production-services.yml")),
    [runtimePath]: inventory(workflowRun(3, "publish-runtime-agent.yml")),
    [`${prefix}runs/2/artifacts`]: artifacts(artifact("production-service-release-manifest")),
    [`${prefix}runs/3/artifacts`]: artifacts(artifact("runtime-agent-release-manifest")),
  })); passed(result);
  assert.equal(result.output, "services_publish=false\nruntime_publish=false\npending=false\npublish=false\n");
  assert.equal(result.calls.length, 4);
});
for (const value of [artifacts(), artifacts(artifact("production-service-release-manifest", { expires_at: "2020-01-01T00:00:00Z" })),
  artifacts(artifact("production-service-release-manifest", { expired: true })),
  artifacts(artifact("production-service-release-manifest", { digest: "bad" })),
  artifacts(artifact("production-service-release-manifest"), artifact("production-service-release-manifest")),
  { total_count: 1, artifacts: [] }]) {
  test(`sealed publisher refuses missing/stale/invalid artifact ${JSON.stringify(value)}`, () => {
    const result = run(steps.manifests, manifests({
      [servicePath]: inventory(workflowRun(2, "publish-production-services.yml")), [`${prefix}runs/2/artifacts`]: value,
    })); assert.notEqual(result.status, 0); assert.equal(result.output, "");
  });
}
test("publisher history refuses foreign provenance, duplicate IDs and truncation", () => {
  for (const value of [inventory({ ...workflowRun(2, "publish-production-services.yml"), head_sha: "b".repeat(40) }),
    inventory(workflowRun(2, "publish-production-services.yml"), workflowRun(2, "publish-production-services.yml")),
    { total_count: 101, workflow_runs: [] }, { total_count: 1, workflow_runs: [] }]) {
    assert.notEqual(run(steps.manifests, manifests({ [servicePath]: value })).status, 0);
  }
});
test("failed unsealed publisher can be dispatched afresh without certifying success", () => {
  const result = run(steps.manifests, manifests({ [servicePath]: inventory(workflowRun(2, "publish-production-services.yml", "completed", "failure")) }));
  passed(result); assert.match(result.output, /services_publish=true/u);
});
test("dispatch performs one source read and exactly two fixed requests, without child polling", () => {
  const result = run(steps.dispatch, {
    [`repos/${repo}/commits/main`]: sha,
    [`${prefix}workflows/publish-production-services.yml/dispatches`]: { workflow_run_id: 4, html_url: "https://github.com/instafy-dev/instafy/actions/runs/4" },
    [`${prefix}workflows/publish-runtime-agent.yml/dispatches`]: { workflow_run_id: 5, html_url: "https://github.com/instafy-dev/instafy/actions/runs/5" },
  }, { PUBLISH_SERVICES: "true", PUBLISH_RUNTIME: "true" }); passed(result);
  assert.deepEqual(result.calls.map(({ method }) => method), ["GET", "POST", "POST"]);
  assert.deepEqual(JSON.parse(result.calls[1].input), { ref: "main", inputs: { commit_sha: sha } });
  assert.deepEqual(JSON.parse(result.calls[2].input), { ref: "main", inputs: { commit_sha: sha, update_channel_tags: false } });
  assert.match(result.output, /dispatched=true/u);
  assert.doesNotMatch(result.output + result.summary, /images published/u);
});
test("dispatch skips a retained lane and refuses to dispatch after main advances", () => {
  const one = run(steps.dispatch, {
    [`repos/${repo}/commits/main`]: sha,
    [`${prefix}workflows/publish-runtime-agent.yml/dispatches`]: { workflow_run_id: 5, html_url: "https://github.com/instafy-dev/instafy/actions/runs/5" },
  }, { PUBLISH_SERVICES: "false", PUBLISH_RUNTIME: "true" }); passed(one); assert.equal(one.calls.length, 2);
  const advanced = run(steps.dispatch, { [`repos/${repo}/commits/main`]: "b".repeat(40) }, { PUBLISH_SERVICES: "true", PUBLISH_RUNTIME: "true" });
  passed(advanced); assert.equal(advanced.calls.length, 1); assert.equal(advanced.output, "");
  assert.match(advanced.summary, /advanced/u);
});

test("failed or ambiguous dispatch receipts never report dispatched", () => {
  for (const service of [{ error: true }, { workflow_run_id: "invalid", html_url: "https://example.invalid" },
    { workflow_run_id: 5, html_url: "https://github.com/instafy-dev/instafy/actions/runs/5" }]) {
    const result = run(steps.dispatch, {
      [`repos/${repo}/commits/main`]: sha,
      [`${prefix}workflows/publish-production-services.yml/dispatches`]: service,
      [`${prefix}workflows/publish-runtime-agent.yml/dispatches`]: { workflow_run_id: 5, html_url: "https://github.com/instafy-dev/instafy/actions/runs/5" },
    }, { PUBLISH_SERVICES: "true", PUBLISH_RUNTIME: "true" });
    assert.notEqual(result.status, 0); assert.equal(result.output, "");
  }
});
