import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../.github/workflows/continuous-image-publication.yml", import.meta.url), "utf8");
const sha = "a".repeat(40);
const repo = "instafy-dev/instafy";
const prefix = `repos/${repo}/actions/`;
const ciPath = `${prefix}workflows/build.yml/runs?head_sha=${sha}&per_page=100`;
const buildRunPath = `${prefix}runs/77`;
const servicePath = `${prefix}workflows/publish-production-services.yml/runs`;
const runtimePath = `${prefix}workflows/publish-runtime-agent.yml/runs`;
const multiarchPath = `${prefix}workflows/publish-runtime-agent-multiarch.yml/runs`;
const multiarchDispatchPath = `${prefix}workflows/publish-runtime-agent-multiarch.yml/dispatches`;
const mainPath = `repos/${repo}/commits/main`;
const steps = {
  source: "Authorize the exact current protected-main commit",
  ci: "Inspect exact protected-main CI without waiting",
  manifests: "Reconcile exact publishers and manifest freshness",
  dispatch: "Dispatch missing immutable image publishers without waiting",
  multiarch: "Reconcile the best-effort arm64 lane without blocking production",
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
// Evaluates a workflow expression the way Actions does for these operators:
// literal string comparisons are case-insensitive. No general evaluator is
// claimed; the expressions under test use only ==, !=, &&, ||, ! and format().
function evaluate(expression, github) {
  const equal = (a, b) => typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const js = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(/(github\.[\w.]+) (==|!=) ('[^']*')/gu, (_, left, op, right) => `${op === "!=" ? "!" : ""}actionsEqual(${left}, ${right})`);
  assert.doesNotMatch(js, /[!=]=/u);
  return vm.runInNewContext(js, { github, actionsEqual: equal,
    format: (template, ...values) => template.replace(/\{(\d+)\}/gu, (_, index) => String(values[index])) }, { timeout: 1000 });
}
function folded(block) { return block.split("\n").map((line) => line.trim()).join(" "); }
const jobGuard = folded(source.slice(source.indexOf("    if: >-\n") + 11, source.indexOf("    runs-on:")));
const groupExpression = folded(source.slice(source.indexOf("  group: >-\n") + 12, source.indexOf("  cancel-in-progress: false")));
const qualifying = { event: "push", conclusion: "success", head_branch: "main", path: ".github/workflows/build.yml",
  repository: { full_name: "instafy-dev/instafy" }, head_repository: { full_name: "instafy-dev/instafy" } };
const completion = (changes = {}) => ({ repository: "instafy-dev/instafy", ref: "refs/heads/main", run_id: "9",
  event_name: "workflow_run", event: { workflow_run: { ...qualifying, ...changes } } });
const disqualified = {
  "fork pull request from a branch named main": { event: "pull_request", head_repository: { full_name: "attacker/instafy" } },
  "same-repository pull request Build": { event: "pull_request" },
  "failed Build": { conclusion: "failure" },
  "cancelled Build": { conclusion: "cancelled" },
  "manually dispatched Build": { event: "workflow_dispatch" },
  "Build of another branch": { head_branch: "release" },
  "another workflow": { path: ".github/workflows/other.yml" },
  "foreign head repository": { head_repository: { full_name: "attacker/instafy" } },
  "foreign repository": { repository: { full_name: "attacker/instafy" } },
};
test("the job guard admits only the exact successful protected-main push Build, evaluated", () => {
  assert.equal(evaluate(jobGuard, completion()), true);
  for (const [label, changes] of Object.entries(disqualified)) {
    assert.equal(evaluate(jobGuard, completion(changes)), false, label);
  }
  for (const event_name of ["push", "schedule", "workflow_dispatch"]) {
    assert.equal(evaluate(jobGuard, { repository: "instafy-dev/instafy", ref: "refs/heads/main", event_name, event: {} }), true, event_name);
  }
  assert.equal(evaluate(jobGuard, { ...completion(), ref: "refs/heads/other" }), false);
});
test("a skipped Build completion never joins the shared group, so it cannot cancel a pending pass", () => {
  assert.equal(evaluate(groupExpression, completion()), "continuous-production-images");
  for (const [label, changes] of Object.entries(disqualified)) {
    assert.equal(evaluate(groupExpression, completion(changes)), "continuous-production-images-ignored-9", label);
  }
  for (const event_name of ["push", "schedule", "workflow_dispatch"]) {
    assert.equal(evaluate(groupExpression, { run_id: "9", event_name, event: {} }), "continuous-production-images", event_name);
  }
});
test("the group isolates exactly the Build completions the job guard skips", () => {
  // The two lists are separate text; if a condition is ever added to the guard
  // only, a completion failing just that condition would rejoin the shared group.
  const conditions = (expression) => [...expression.matchAll(/github\.event\.workflow_run\.[\w.]+ == '[^']*'/gu)].map(([match]) => match);
  assert.deepEqual(conditions(groupExpression), conditions(jobGuard));
  assert.equal(conditions(jobGuard).length, 6);
});
test("a Build read that errors or reports an unknown status never opens publication", () => {
  for (const response of [{ error: true }, { ...workflowRun(77, "build.yml"), status: "unknown" }]) {
    const result = run(steps.ci, { [buildRunPath]: response }, { BUILD_RUN_ID: "77" });
    assert.notEqual(result.status, 0); assert.equal(result.output, "");
  }
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
  assert.equal(result.output, "services_publish=true\nruntime_publish=true\nruntime_fresh=false\npending=false\npublish=true\n");
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
  assert.equal(result.output, "services_publish=false\nruntime_publish=false\nruntime_fresh=true\npending=false\npublish=false\n");
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
  // The amd64 production publisher no longer moves channel tags, so its payload
  // carries only the commit; the multi-arch lane is never dispatched here.
  assert.deepEqual(JSON.parse(result.calls[2].input), { ref: "main", inputs: { commit_sha: sha } });
  assert.ok(result.calls.every(({ endpoint }) => !endpoint.includes("multiarch")));
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

// The best-effort arm64 lane (publish-runtime-agent-multiarch.yml). It may only
// warn: whatever its inventory, receipts or errors, the step exits 0, never
// writes a production output and never dispatches a production publisher.
const laneRun = (id, status = "completed", conclusion = "success") =>
  workflowRun(id, "publish-runtime-agent-multiarch.yml", status, conclusion);
const laneReceipt = (id) => ({ workflow_run_id: id, html_url: `https://github.com/instafy-dev/instafy/actions/runs/${id}` });
function outputs(text) {
  return Object.fromEntries(text.split("\n").filter(Boolean).map((line) => line.split(/=(.*)/su).slice(0, 2)));
}
function lane(responses, extraEnv = {}) {
  const result = run(steps.multiarch, { [mainPath]: sha, [multiarchDispatchPath]: laneReceipt(900), ...responses }, extraEnv);
  passed(result);
  assert.doesNotMatch(result.output, /^(?:services_publish|runtime_publish|runtime_fresh|pending|publish|dispatched|services_run_id|runtime_run_id)=/mu);
  assert.ok(result.calls.every(({ endpoint }) => !/publish-production-services|publish-runtime-agent\.yml/u.test(endpoint)));
  return { ...result, state: outputs(result.output).multiarch_state, posts: result.calls.filter(({ method }) => method === "POST") };
}

test("a missing arm64 lane is dispatched once, current-main only, with channel tags off", () => {
  const result = lane({ [multiarchPath]: inventory() });
  assert.equal(result.state, "dispatched");
  assert.equal(outputs(result.output).multiarch_run_id, "900");
  assert.deepEqual(result.calls.map(({ method, endpoint }) => `${method} ${endpoint}`),
    [`GET ${multiarchPath}`, `GET ${mainPath}`, `POST ${multiarchDispatchPath}`]);
  assert.ok(!result.calls[0].args.includes("event=workflow_dispatch") && !result.calls[0].args.includes("status=success"));
  assert.deepEqual(JSON.parse(result.posts[0].input), { ref: "main", inputs: { commit_sha: sha, update_channel_tags: false } });
  assert.match(result.summary, /Dispatched attempt 1 of 4: \[run 900\]/u);
  assert.doesNotMatch(result.stdout, /::warning::/u);
  const moved = lane({ [multiarchPath]: inventory(), [mainPath]: "b".repeat(40) });
  assert.equal(moved.state, "deferred"); assert.equal(moved.posts.length, 0);
});
for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
  test(`an exact ${status} arm64 run defers the lane without a duplicate`, () => {
    const result = lane({ [multiarchPath]: inventory(laneRun(7, "completed", "failure"), laneRun(8, status)) });
    assert.equal(result.state, "pending"); assert.equal(result.calls.length, 1); assert.equal(result.posts.length, 0);
  });
}
test("failed arm64 runs are dispatched again below the cap of four and never at or above it", () => {
  for (const failures of [1, 2, 3]) {
    const runs = Array.from({ length: failures }, (_, index) => laneRun(10 + index, "completed", index % 2 ? "cancelled" : "failure"));
    const result = lane({ [multiarchPath]: inventory(...runs) });
    assert.equal(result.state, "dispatched", `${failures} failures`);
    assert.equal(result.posts.length, 1);
    assert.match(result.summary, new RegExp(`Dispatched attempt ${failures + 1} of 4`, "u"));
  }
  for (const failures of [4, 5]) {
    const runs = Array.from({ length: failures }, (_, index) => laneRun(10 + index, "completed", "failure"));
    const result = lane({ [multiarchPath]: inventory(...runs) });
    assert.equal(result.state, "exhausted", `${failures} failures`);
    assert.equal(result.calls.length, 1, "no main read and no dispatch once exhausted");
    assert.match(result.stdout, new RegExp(`^::warning::arm64 lane exhausted for ${sha} after ${failures} failed runs \\(cap 4\\); production unaffected; dispatch publish-runtime-agent-multiarch\\.yml manually`, "mu"));
    assert.match(result.summary, new RegExp(`^- arm64 lane exhausted for \`${sha}\`; production unaffected; dispatch \`publish-runtime-agent-multiarch\\.yml\` manually\\.$`, "mu"));
  }
});
test("a sealed arm64 lane is verified without dispatch, and a stale seal only warns", () => {
  const fresh = lane({ [multiarchPath]: inventory(laneRun(10, "completed", "failure"), laneRun(11)),
    [`${prefix}runs/11/artifacts`]: artifacts(artifact("runtime-agent-multiarch-manifest")) });
  assert.equal(fresh.state, "fresh"); assert.equal(fresh.posts.length, 0);
  assert.doesNotMatch(fresh.stdout, /::warning::/u);
  for (const value of [artifacts(), artifacts(artifact("runtime-agent-release-manifest")),
    artifacts(artifact("runtime-agent-multiarch-manifest", { expires_at: "2020-01-01T00:00:00Z" })),
    artifacts(artifact("runtime-agent-multiarch-manifest", { expired: true })),
    artifacts(artifact("runtime-agent-multiarch-manifest", { digest: "bad" })),
    artifacts(artifact("runtime-agent-multiarch-manifest"), artifact("runtime-agent-multiarch-manifest"))]) {
    const stale = lane({ [multiarchPath]: inventory(laneRun(11)), [`${prefix}runs/11/artifacts`]: value });
    assert.equal(stale.state, "stale", JSON.stringify(value)); assert.equal(stale.posts.length, 0);
    assert.match(stale.stdout, /^::warning::A sealed publish-runtime-agent-multiarch\.yml run .* Production publication is unaffected\.$/mu);
  }
});
test("any broken arm64 inventory, read or receipt ends in a warning and status 0", () => {
  const cases = {
    "listing error": { [multiarchPath]: { error: true } },
    "truncated listing": { [multiarchPath]: { total_count: 101, workflow_runs: [] } },
    "incomplete listing": { [multiarchPath]: { total_count: 1, workflow_runs: [] } },
    "foreign commit": { [multiarchPath]: inventory({ ...laneRun(10, "completed", "failure"), head_sha: "b".repeat(40) }) },
    "foreign workflow": { [multiarchPath]: inventory({ ...laneRun(10, "completed", "failure"), path: ".github/workflows/publish-runtime-agent.yml" }) },
    "duplicate IDs": { [multiarchPath]: inventory(laneRun(10, "completed", "failure"), laneRun(10, "completed", "failure")) },
    "unknown status": { [multiarchPath]: inventory(laneRun(10, "unknown")) },
    "artifact read error": { [multiarchPath]: inventory(laneRun(11)), [`${prefix}runs/11/artifacts`]: { error: true } },
    "main read error": { [multiarchPath]: inventory(), [mainPath]: { error: true } },
    "dispatch rejected": { [multiarchPath]: inventory(), [multiarchDispatchPath]: { error: true } },
    "ambiguous receipt": { [multiarchPath]: inventory(), [multiarchDispatchPath]: { workflow_run_id: "1; true", html_url: "x" } },
  };
  for (const [label, responses] of Object.entries(cases)) {
    const result = lane(responses);
    assert.equal(result.state, "error", label);
    assert.match(result.stdout, /^::warning::The arm64 lane could not be reconciled in this pass \(status [1-9][0-9]*\)\. Production publication is unaffected/mu, label);
    assert.match(result.summary, /production publication is unaffected/u, label);
    assert.ok(result.posts.length <= 1, label);
  }
});
test("the arm64 lane runs last, only after a fresh production runtime manifest, and cannot exit non-zero", () => {
  const names = [...source.matchAll(/^      - name: (.+)$/gmu)].map((match) => match[1]);
  assert.equal(names.at(-1), steps.multiarch);
  const step = source.slice(source.indexOf(`      - name: ${steps.multiarch}\n`));
  assert.match(step, /^        if: >-\n          steps\.recheck\.outputs\.current == 'true' &&\n          steps\.freshness\.outputs\.runtime_fresh == 'true'\n        id: multiarch\n/mu);
  // Nothing before it can read its outputs, and it writes only its own.
  const before = source.slice(0, source.indexOf(step)).split("\n").filter((line) => !/^\s*#/u.test(line)).join("\n");
  assert.doesNotMatch(before, /steps\.multiarch|multiarch_/u);
  assert.deepEqual([...new Set([...step.matchAll(/echo "(\w+)=[^"]*" >> "\$GITHUB_OUTPUT"/gu)].map((match) => match[1]))].sort(),
    ["multiarch_run_id", "multiarch_state"]);
  // Only the subshell may fail fast; the outer shell disables errexit first,
  // records the subshell's status and always ends with exit 0.
  const script = body(steps.multiarch);
  const start = script.indexOf("\n(\n  set -euo pipefail\n");
  const end = script.indexOf("\n)\nstatus=$?\n");
  assert.ok(start > 0 && end > start);
  const outer = script.slice(0, start) + script.slice(end);
  assert.match(outer.split("\n").filter((line) => line && !line.startsWith("#"))[0], /^set \+e$/u);
  assert.match(outer, /\nexit 0\n?$/u);
  assert.doesNotMatch(outer, /exit "\$|exit [1-9]|return [1-9]|\bset -[a-z]*e/u);
  assert.equal([...script.matchAll(/^\(\n|^\)\n/gmu)].length, 2, "one subshell");
  assert.equal([...script.matchAll(/--method POST/gu)].length, 1);
  assert.match(script, /^retry_cap=4$/mu);
  assert.doesNotMatch(source, /continue-on-error/u);
});

// Runs one coordinator pass from the freshness step onward exactly as Actions
// would: each step's own `if:` is evaluated over the outputs earlier steps
// wrote, its `env:` is resolved from them, and a failing step stops the pass.
function stepSource(name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  const next = source.indexOf("\n      - name:", start + 1);
  return source.slice(start, next < 0 ? undefined : next + 1);
}
function stepCondition(step) {
  const folded = step.match(/^        if: >-\n((?: {10}.*\n)+)/mu);
  const expression = folded ? folded[1].split("\n").map((line) => line.trim()).join(" ") : step.match(/^        if: (.+)$/mu)?.[1];
  return expression?.trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
}
function holds(expression, state) {
  if (!expression) return true;
  const js = expression.replace(/steps\.([\w-]+)\.outputs\.([\w-]+) (==|!=) '([^']*)'/gu, (_, id, key, operator, value) =>
    `(${JSON.stringify(state[id]?.[key] ?? "")} ${operator === "==" ? "===" : "!=="} ${JSON.stringify(value)})`);
  assert.doesNotMatch(js, /steps\.|github\.|runner\.|inputs\./u, expression);
  return vm.runInNewContext(js, {}, { timeout: 1000 });
}
function pass(responses) {
  const state = { source: { current: "true", commit_sha: sha }, ci: { ready: "true" }, recheck: { current: "true" } };
  const names = [...source.matchAll(/^      - name: (.+)$/gmu)].map((match) => match[1]);
  const ran = [], calls = [], productionCalls = [];
  let summary = "", stdout = "";
  for (const name of names.slice(names.indexOf(steps.manifests))) {
    const step = stepSource(name);
    if (!holds(stepCondition(step), state)) continue;
    const env = {};
    for (const [, key, value] of (step.match(/^        env:\n((?: {10}[A-Z_]+: .*\n)+)/mu)?.[1] ?? "").matchAll(/^ {10}([A-Z_]+): (.*)$/gmu)) {
      env[key] = value === "${{ github.token }}" ? "inert-fixture"
        : value.replace(/^\$\{\{ steps\.([\w-]+)\.outputs\.([\w-]+) \}\}$/u, (_, id, output) => state[id]?.[output] ?? "");
      assert.doesNotMatch(env[key], /\$\{\{/u, `${name}: ${key}`);
    }
    const result = run(name, responses, env);
    ran.push(name); calls.push(...result.calls); summary += result.summary; stdout += result.stdout;
    if (name !== steps.multiarch) productionCalls.push(...result.calls.map(({ method, endpoint, input }) => `${method} ${endpoint} ${input}`));
    const id = step.match(/^        id: (\S+)$/mu)?.[1];
    if (id) state[id] = outputs(result.output);
    if (result.status !== 0) return { state, ran, calls, productionCalls, summary, stdout, failed: name };
  }
  return { state, ran, calls, productionCalls, summary, stdout };
}
const production = (state) => Object.fromEntries(["services_publish", "runtime_publish", "runtime_fresh", "pending", "publish"]
  .map((key) => [key, state.freshness?.[key]]));
function passFixture({ services = "sealed", runtime = "sealed", lane: runs = [], broken = false }) {
  const responses = { [mainPath]: sha,
    [`${prefix}workflows/publish-production-services.yml/dispatches`]: { workflow_run_id: 4, html_url: "https://github.com/instafy-dev/instafy/actions/runs/4" },
    [`${prefix}workflows/publish-runtime-agent.yml/dispatches`]: { workflow_run_id: 5, html_url: "https://github.com/instafy-dev/instafy/actions/runs/5" },
    [multiarchDispatchPath]: laneReceipt(900 + runs.length) };
  for (const [path, workflow, id, name, phase] of [
    [servicePath, "publish-production-services.yml", 2, "production-service-release-manifest", services],
    [runtimePath, "publish-runtime-agent.yml", 3, "runtime-agent-release-manifest", runtime]]) {
    responses[path] = phase === "missing" ? inventory() : inventory(workflowRun(id, workflow, phase === "running" ? "in_progress" : "completed"));
    if (phase === "sealed") responses[`${prefix}runs/${id}/artifacts`] = artifacts(artifact(name));
  }
  responses[multiarchPath] = broken ? { error: true } : inventory(...runs.map(([id, conclusion]) =>
    laneRun(id, conclusion === "running" ? "in_progress" : "completed", conclusion === "running" ? undefined : conclusion)));
  for (const [id, conclusion] of runs) {
    if (conclusion === "success") responses[`${prefix}runs/${id}/artifacts`] = artifacts(artifact("runtime-agent-multiarch-manifest"));
  }
  return responses;
}

test("Oct 1-2 replay: production seals and ships while arm64 fails three times, then the fourth arm64 run seals", () => {
  // Each pass is one coordinator run (push, Build completion or schedule) on
  // the same unchanged main. The base arm64 scan failed for hours on a Debian
  // ports lag while both amd64 images and webdev arm64 passed.
  const passes = [
    { label: "Build completion", fixture: { services: "missing", runtime: "missing" },
      production: { services_publish: "true", runtime_publish: "true", runtime_fresh: "false", pending: "false", publish: "true" }, lane: undefined },
    { label: "publishers running", fixture: { services: "running", runtime: "running" },
      production: { services_publish: "false", runtime_publish: "false", runtime_fresh: "false", pending: "true", publish: "false" }, lane: undefined },
    { label: "production sealed", fixture: { lane: [] }, lane: "dispatched", attempt: 1 },
    { label: "arm64 run 1 active", fixture: { lane: [[900, "running"]] }, lane: "pending" },
    { label: "arm64 run 1 failed", fixture: { lane: [[900, "failure"]] }, lane: "dispatched", attempt: 2 },
    { label: "arm64 run 2 failed", fixture: { lane: [[900, "failure"], [901, "failure"]] }, lane: "dispatched", attempt: 3 },
    { label: "arm64 run 3 failed", fixture: { lane: [[900, "failure"], [901, "failure"], [902, "failure"]] }, lane: "dispatched", attempt: 4 },
    { label: "arm64 run 4 sealed", fixture: { lane: [[900, "failure"], [901, "failure"], [902, "failure"], [903, "success"]] }, lane: "fresh" },
  ];
  const sealedProduction = { services_publish: "false", runtime_publish: "false", runtime_fresh: "true", pending: "false", publish: "false" };
  for (const expected of passes) {
    const result = pass(passFixture(expected.fixture));
    assert.equal(result.failed, undefined, `${expected.label}: ${result.stdout}`);
    assert.deepEqual(production(result.state), expected.production ?? sealedProduction, expected.label);
    assert.equal(result.state.multiarch?.multiarch_state, expected.lane, expected.label);
    const posts = result.calls.filter(({ method }) => method === "POST");
    assert.ok(posts.length <= 3, expected.label);
    // Production and arm64 publishers are never dispatched in the same pass.
    assert.ok(!(posts.some(({ endpoint }) => endpoint.includes("publish-runtime-agent.yml"))
      && posts.some(({ endpoint }) => endpoint.includes("multiarch"))), expected.label);
    const lanePosts = posts.filter(({ endpoint }) => endpoint === multiarchDispatchPath);
    assert.equal(lanePosts.length, expected.lane === "dispatched" ? 1 : 0, expected.label);
    if (expected.attempt) {
      assert.match(result.summary, new RegExp(`Dispatched attempt ${expected.attempt} of 4`, "u"), expected.label);
      assert.deepEqual(JSON.parse(lanePosts[0].input), { ref: "main", inputs: { commit_sha: sha, update_channel_tags: false } });
    }
    if (!expected.production) assert.match(result.summary, /Immutable production images are fresh/u, expected.label);
    assert.doesNotMatch(result.stdout, /::error::/u, expected.label);

    // The same pass with the arm64 lane's API broken: production decides and
    // dispatches exactly the same, and the pass still succeeds.
    const broken = pass(passFixture({ ...expected.fixture, broken: true }));
    assert.equal(broken.failed, undefined, expected.label);
    assert.deepEqual(production(broken.state), production(result.state), expected.label);
    assert.deepEqual(broken.productionCalls, result.productionCalls, expected.label);
    assert.ok(result.productionCalls.every((call) => !call.includes("multiarch")), expected.label);
    assert.deepEqual(broken.state.dispatch, result.state.dispatch, expected.label);
    if (expected.lane) assert.equal(broken.state.multiarch.multiarch_state, "error", expected.label);
  }
});

test("a fourth arm64 failure exhausts the lane: a warning and a summary line, production still fresh, no dispatch", () => {
  const result = pass(passFixture({ lane: [[900, "failure"], [901, "failure"], [902, "failure"], [903, "failure"]] }));
  assert.equal(result.failed, undefined);
  assert.equal(result.state.multiarch.multiarch_state, "exhausted");
  assert.deepEqual(production(result.state),
    { services_publish: "false", runtime_publish: "false", runtime_fresh: "true", pending: "false", publish: "false" });
  assert.equal(result.calls.filter(({ method }) => method === "POST").length, 0);
  assert.match(result.stdout, /^::warning::arm64 lane exhausted for a{40}/mu);
  assert.match(result.summary, /^- arm64 lane exhausted for `a{40}`; production unaffected; dispatch `publish-runtime-agent-multiarch\.yml` manually\.$/mu);
  // Services missing in the same pass: production still dispatches exactly its lane.
  const services = pass(passFixture({ services: "missing", lane: [[900, "failure"], [901, "failure"], [902, "failure"], [903, "failure"]] }));
  assert.equal(services.failed, undefined);
  assert.equal(services.state.freshness.services_publish, "true");
  assert.deepEqual(services.calls.filter(({ method }) => method === "POST").map(({ endpoint }) => endpoint),
    [`${prefix}workflows/publish-production-services.yml/dispatches`]);
});

test("a production runtime manifest that is missing, active or failed never starts the arm64 lane", () => {
  for (const runtime of ["missing", "running"]) {
    const result = pass(passFixture({ runtime }));
    assert.equal(result.failed, undefined, runtime);
    assert.ok(!result.ran.includes(steps.multiarch), runtime);
    assert.ok(result.calls.every(({ endpoint }) => !endpoint.includes("multiarch")), runtime);
  }
  const failed = manifests({ [servicePath]: inventory(workflowRun(2, "publish-production-services.yml")),
    [`${prefix}runs/2/artifacts`]: artifacts(artifact("production-service-release-manifest")),
    [runtimePath]: inventory(workflowRun(3, "publish-runtime-agent.yml", "completed", "failure")) });
  const result = pass({ ...failed, [mainPath]: sha, [`${prefix}workflows/publish-runtime-agent.yml/dispatches`]: { workflow_run_id: 5, html_url: "https://github.com/instafy-dev/instafy/actions/runs/5" } });
  assert.equal(result.failed, undefined);
  assert.equal(result.state.freshness.runtime_publish, "true");
  assert.ok(!result.ran.includes(steps.multiarch));
});
