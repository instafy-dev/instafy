import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const directory = path.join(root, ".github", "workflows");
const read = (file) => fs.readFileSync(path.join(directory, file), "utf8");

// Inventory the existing runnable lanes, not a reduced replacement CI graph.
// [job, hosted fallback, self-hosted role, PR event (if allowed)]
const inventory = {
  "auth-email.yml": [["auth-email", "ubuntu-latest", "linux-arm64", "pull_request"]],
  "browser-e2e.yml": [
    ["personal", "ubuntu-24.04", "linux-arm64", "pull_request"],
    ["browser-ui", "ubuntu-24.04", "linux-arm64", "pull_request"],
    ["shared-profile", "ubuntu-24.04", "linux-arm64", "pull_request"],
  ],
  "build.yml": [
    ["secret-scan", "ubuntu-latest", "control"],
    ["javascript", "ubuntu-latest", "linux-arm64", "pull_request"],
    ["go", "ubuntu-latest", "linux-arm64", "pull_request"],
    ["rust", "ubuntu-latest", "linux-arm64", "pull_request"],
    ["rust-fmt", "ubuntu-latest", "linux-arm64", "pull_request"],
    ["rust-tests", "ubuntu-latest", "linux-arm64", "pull_request"],
  ],
  "continuous-image-publication.yml": [["publish", "ubuntu-24.04", "coordinator"]],
  "controller-db-tests.yml": [["controller-db-tests", "ubuntu-latest", "linux-arm64", "pull_request"]],
  "git-conflict-canary.yml": [["deterministic-conflict", "ubuntu-latest", "control", "pull_request"]],
  "npm-release.yml": [
    ["pull-request-policy", "ubuntu-24.04", "control", "pull_request"],
    ["select", "ubuntu-24.04", "control"],
    ["version", "ubuntu-24.04", "control"],
    ["pack", "ubuntu-24.04", null],
    ["publish", "ubuntu-24.04", null],
  ],
  "public-boundary.yml": [["boundary", "ubuntu-latest", "control", "pull_request_target"]],
  "publish-production-services.yml": [
    ["authorize", "ubuntu-latest", "control"],
    ["release-approval", "ubuntu-latest", "control"],
    ["publish", "ubuntu-latest", "linux-x64"],
    ["manifest", "ubuntu-latest", "control"],
  ],
  "publish-runtime-agent.yml": [
    ["authorize", "ubuntu-latest", "control"],
    ["release-approval", "ubuntu-latest", "control"],
    ["build-scan-push", "ubuntu-24.04", "matrix"],
    ["assemble-release-manifest", "ubuntu-latest", "control"],
  ],
};

function job(file, name) {
  const workflow = read(file);
  const jobsStart = workflow.indexOf("\njobs:\n");
  assert.notEqual(jobsStart, -1, `${file} has a jobs mapping`);
  const sections = [...workflow.slice(jobsStart + 7).matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)];
  const found = sections.find((match) => match[1] === name);
  assert.ok(found, `${file}/${name} still exists`);
  return found[0];
}

function route(source, { variables = {}, event = "push", ref = "refs/heads/main", privateRepository = true, headRepository = "example/project", matrix = {} } = {}) {
  const folded = source.match(/^    runs-on: >-\n((?:      .*\n)+)/m);
  if (!folded) return [source.match(/^    runs-on: ([a-z0-9.-]+)$/m)?.[1]];
  const expression = folded[1].trim().match(/^\$\{\{([\s\S]+)\}\}$/)?.[1];
  assert.ok(expression, "runner selection is a bounded folded Actions expression");
  // These expressions intentionally use only the common boolean/comparison subset
  // of Actions expressions, plus fromJSON/format. Evaluate the actual workflow bytes,
  // not a duplicate hand-maintained implementation of the routing decision.
  assert.doesNotMatch(expression, /[;`]|\b(?:inputs|needs|secrets|env)\./);
  const value = vm.runInNewContext(expression, {
    fromJSON: JSON.parse,
    format: (template, value) => template.replace("{0}", value),
    vars: { CI_RUNNER_MODE: "", CI_TRUSTED_PR_SELF_HOSTED: "", CI_LINUX_X64_SELF_HOSTED: "", ...variables },
    github: {
      event_name: event, ref, repository: "example/project",
      event: { repository: { private: privateRepository }, pull_request: { head: { repo: { full_name: headRepository } } } },
    },
    matrix: { architecture: "amd64", runner: "ubuntu-24.04", ...matrix },
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(value));
}

const enabled = { CI_RUNNER_MODE: "self-hosted", CI_LINUX_X64_SELF_HOSTED: "true" };
const expected = (role) => ["self-hosted", "Linux", role === "linux-x64" ? "X64" : "ARM64", `instafy-ci-${role}`];

test("every runnable public Linux job is inventoried, with only the two npm hosted exceptions", () => {
  assert.deepEqual(fs.readdirSync(directory).filter((name) => /\.ya?ml$/.test(name)).sort(), Object.keys(inventory).sort());
  let count = 0;
  for (const [file, lanes] of Object.entries(inventory)) {
    assert.equal([...read(file).matchAll(/^    runs-on:/gm)].length, lanes.length, file);
    for (const [name, fallback, role] of lanes) {
      const source = job(file, name);
      count += 1;
      for (const mode of ["", "github-hosted", "unknown", "false"]) {
        assert.deepEqual(route(source, { variables: { ...enabled, CI_RUNNER_MODE: mode } }), [fallback], `${file}/${name}: ${mode || "unset"}`);
      }
      assert.deepEqual(route(source, { variables: enabled }), role ? expected(role === "matrix" ? "linux-x64" : role) : [fallback]);
      if (!role) assert.doesNotMatch(source, /CI_RUNNER_MODE|^    runs-on: >-/m);
    }
  }
  assert.equal(count, 27);
});

test("only protected-main event shapes opt into self-hosting without a PR trust decision", () => {
  for (const [file, lanes] of Object.entries(inventory)) {
    for (const [name, fallback, role] of lanes) {
      const source = job(file, name);
      for (const event of ["push", "schedule", "workflow_dispatch"]) {
        assert.deepEqual(route(source, { variables: enabled, event }), role ? expected(role === "matrix" ? "linux-x64" : role) : [fallback]);
        assert.deepEqual(route(source, { variables: enabled, event, ref: "refs/heads/topic" }), [fallback]);
        assert.deepEqual(route(source, { variables: enabled, event, ref: "refs/tags/v1" }), [fallback]);
      }
      for (const event of ["workflow_run", "merge_group", "issue_comment", "pull_request", "pull_request_target"]) {
        assert.deepEqual(route(source, { variables: enabled, event }), [fallback], `${file}/${name}: ${event}`);
      }
    }
  }
});

test("temporary PR selection requires all of mode, opt-in, private visibility, same repository and matching event", () => {
  const variables = { ...enabled, CI_TRUSTED_PR_SELF_HOSTED: "true" };
  for (const [file, lanes] of Object.entries(inventory)) {
    for (const [name, fallback, role, prEvent] of lanes) {
      const source = job(file, name);
      for (const event of ["pull_request", "pull_request_target"]) {
        const context = { variables, event, ref: "refs/pull/42/merge" };
        assert.deepEqual(route(source, context), event === prEvent ? expected(role) : [fallback]);
        for (const denied of [
          { privateRepository: false },
          { headRepository: "contributor/fork" },
          { headRepository: "" },
          { variables: { ...variables, CI_TRUSTED_PR_SELF_HOSTED: "" } },
          { variables: { ...variables, CI_TRUSTED_PR_SELF_HOSTED: "false" } },
          { variables: { ...variables, CI_RUNNER_MODE: "github-hosted" } },
        ]) assert.deepEqual(route(source, { ...context, ...denied }), [fallback], `${file}/${name}: rejects incomplete PR trust`);
      }
      if (prEvent) {
        assert.doesNotMatch(source, /\bsecrets\.|\bsecrets:|^    environment:|^      [a-z-]+: write$/m);
        assert.match(read(file), /contents: read/);
      }
    }
  }
});

test("native image architecture is never inferred from ARM capacity or reduced matrix coverage", () => {
  const runtime = job("publish-runtime-agent.yml", "build-scan-push");
  assert.equal((runtime.match(/architecture: amd64/g) ?? []).length, 2);
  assert.equal((runtime.match(/architecture: arm64/g) ?? []).length, 2);
  for (const architecture of ["amd64", "arm64"]) {
    const matrix = { architecture, runner: architecture === "arm64" ? "ubuntu-24.04-arm" : "ubuntu-24.04" };
    assert.deepEqual(route(runtime, { matrix }), [matrix.runner]);
    assert.deepEqual(route(runtime, { variables: { CI_RUNNER_MODE: "self-hosted" }, matrix }), architecture === "arm64" ? expected("linux-arm64") : [matrix.runner]);
    assert.deepEqual(route(runtime, { variables: enabled, matrix }), expected(architecture === "arm64" ? "linux-arm64" : "linux-x64"));
    assert.deepEqual(route(runtime, { variables: { ...enabled, CI_LINUX_X64_SELF_HOSTED: "false" }, matrix }), architecture === "arm64" ? expected("linux-arm64") : [matrix.runner]);
  }
  const services = job("publish-production-services.yml", "publish");
  assert.deepEqual(route(services, { variables: { CI_RUNNER_MODE: "self-hosted" } }), ["ubuntu-latest"]);
  assert.match(services, /--platform linux\/amd64/);
  assert.equal((services.match(/^          - key:/gm) ?? []).length, 7);
  assert.doesNotMatch(runtime + services, /setup-qemu|binfmt/);
});

test("waiting coordinator has a separate role from short authorizers, manifests and build workers", () => {
  const coordinator = route(job("continuous-image-publication.yml", "publish"), { variables: enabled });
  assert.deepEqual(coordinator, expected("coordinator"));
  for (const file of ["publish-runtime-agent.yml", "publish-production-services.yml"]) {
    for (const [name] of inventory[file]) assert.notDeepEqual(route(job(file, name), { variables: enabled }), coordinator);
  }
  assert.deepEqual(route(job("publish-runtime-agent.yml", "authorize"), { variables: enabled }), expected("control"));
  assert.notDeepEqual(expected("control"), expected("linux-arm64"));
});

test("architecture-specific native caches cannot restore the former cross-architecture namespace", () => {
  for (const file of ["build.yml", "browser-e2e.yml"]) {
    const source = read(file);
    assert.match(source, /key: supabase-postgres-image-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ hashFiles/);
    assert.doesNotMatch(source, /key: supabase-postgres-image-\$\{\{ hashFiles/);
  }
  const rust = job("build.yml", "rust-tests");
  assert.match(rust, /key: rust-tests-v3-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-/);
  assert.match(rust, /restore-keys: \|\n            rust-tests-v3-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\n/);
});

test("both native scanner downloads are checksum pinned and unsupported architectures fail closed", () => {
  for (const file of ["build.yml", "public-boundary.yml"]) {
    const source = read(file);
    assert.match(source, /GITLEAKS_LINUX_X64_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"/);
    assert.match(source, /GITLEAKS_LINUX_ARM64_SHA256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"/);
    assert.match(source, /x86_64\) asset=linux_x64; checksum="\$GITLEAKS_LINUX_X64_SHA256"/);
    assert.match(source, /aarch64\) asset=linux_arm64; checksum="\$GITLEAKS_LINUX_ARM64_SHA256"/);
    assert.match(source, /Unsupported Linux scanner architecture\."; exit 1/);
    assert.match(source, /"\$checksum" "\$archive" \| sha256sum --check --status/);
  }
});

test("checkouts never persist credentials and only hosted machines run hosted SDK deletion", () => {
  for (const file of Object.keys(inventory)) {
    const source = read(file);
    for (const match of source.matchAll(/^        uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=^      - |$(?![\s\S]))/gm)) {
      assert.match(match[1], /persist-credentials: false/, file);
    }
  }
  assert.match(read("build.yml"), /name: Free runner disk space\n        if: runner\.environment == 'github-hosted'/);
  assert.match(read("browser-e2e.yml"), /name: Free space on the disposable hosted runner\n        if: runner\.environment == 'github-hosted'/);
  assert.match(read("publish-runtime-agent.yml"), /if \[\[ "\$RUNNER_ENVIRONMENT" == "github-hosted" \]\]; then\n            sudo rm -rf --/);
  assert.match(read("build.yml"), /scripts\/check-ci-runner-routing\.test\.mjs/);
});
