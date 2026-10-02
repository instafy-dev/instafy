import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  ISSUE_BODY_LIMIT,
  ISSUE_ROW_LIMIT,
  ISSUE_TITLE,
  cellMarkdown,
  cellResult,
  issueBody,
  issueComment,
  readResults,
  scanFindings,
} from "./image-scan-report.mjs";

// The nightly image scan must build and scan exactly what the publishers
// release, and must never write to a registry. Everything it shares with the
// publishers is read from their files here, so a publisher change that the
// scan does not follow fails this test instead of drifting silently.

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const scanSource = read(".github/workflows/image-scan.yml");
const runtimeSource = read(".github/workflows/publish-runtime-agent.yml");
const servicesSource = read(".github/workflows/publish-production-services.yml");

function job(source, key) {
  const marker = `\n  ${key}:\n`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0 && source.indexOf(marker, start + 1) < 0, `missing or repeated job ${key}`);
  return source.slice(start + 1).split(/\n  [\w-]+:\n/u)[0];
}

const scan = { runtime: job(scanSource, "runtime"), services: job(scanSource, "services"), report: job(scanSource, "report") };
const publisher = { runtime: job(runtimeSource, "build-scan-push"), services: job(servicesSource, "publish") };

function steps(section) {
  return section.split(/(?=^      - )/mu).slice(1);
}

function step(section, name) {
  const found = steps(section).filter((value) => value.startsWith(`      - name: ${name}\n`));
  assert.equal(found.length, 1, `exactly one step named ${name}`);
  return found[0];
}

function runBlock(text) {
  const match = text.match(/^        run: \|\n((?:(?: {10}.*)?\n)+)/mu);
  assert.ok(match, "step has a run block");
  return match[1].replace(/^ {10}/gmu, "").replace(/\n+$/u, "\n");
}

function runLine(text) {
  return text.match(/^        run: (?!\|)(.+)$/mu)?.[1];
}

function env(text) {
  const block = text.match(/^        env:\n((?: {10}[A-Z0-9_]+: .*\n)+)/mu)?.[1] ?? "";
  return Object.fromEntries(block.split("\n").filter(Boolean).map((line) => {
    const [, key, value] = line.match(/^ {10}([A-Z0-9_]+): (.*)$/u);
    return [key, value];
  }));
}

function withInputs(text) {
  const block = text.match(/^        with:\n((?: {10}.*\n)+)/mu)?.[1];
  assert.ok(block, "step has inputs");
  const inputs = {};
  let current;
  for (const line of block.split("\n").filter((value) => value && !/^\s+#/u.test(value))) {
    const scalar = line.match(/^ {10}([\w-]+): (.*)$/u);
    if (scalar) {
      current = scalar[1];
      inputs[current] = scalar[2] === "|" ? [] : scalar[2];
      continue;
    }
    assert.ok(Array.isArray(inputs[current]) && /^ {12}\S/u.test(line), line);
    inputs[current].push(line.trim());
  }
  return inputs;
}

function matrix(section) {
  const block = section.match(/^      matrix:\n        include:\n((?: {10}.*\n)+)/mu)?.[1];
  assert.ok(block, "job has a matrix include list");
  const cells = [];
  for (const line of block.split("\n").filter(Boolean)) {
    const match = line.match(/^ {10}(- | {2})([\w-]+): (.*)$/u);
    assert.ok(match, line);
    if (match[1] === "- ") cells.push({});
    cells.at(-1)[match[2]] = match[3].replace(/^"(.*)"$/u, "$1");
  }
  return cells;
}

function permissions(section) {
  if (/^    permissions: \{\}$/mu.test(section)) return {};
  const block = section.match(/^    permissions:\n((?: {6}[\w-]+: [\w-]+\n)+)/mu)?.[1];
  assert.ok(block, "job declares its permissions");
  return Object.fromEntries(block.split("\n").filter(Boolean).map((line) => line.trim().split(": ")));
}

function timeout(section) {
  const values = [...section.matchAll(/^    timeout-minutes: (\d+)$/gmu)].map((match) => Number(match[1]));
  assert.equal(values.length, 1);
  return values[0];
}

function strategy(section) {
  const block = section.match(/^    strategy:\n((?: {6}.*\n)+?)(?= {6}matrix:\n)/mu)?.[1];
  assert.ok(block, "job has a strategy");
  return block.split("\n").filter((line) => line && !/^\s+#/u.test(line));
}

// The source paths, relative to the repository, of every dependency manifest
// or lockfile a Dockerfile copies from its build context.
const dependencyManifest = /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum)$/u;
function copiedManifests(dockerfile, context) {
  const sources = [];
  for (const line of read(dockerfile).split("\n")) {
    if (!/^(?:COPY|ADD)\s/u.test(line) || /--from=/u.test(line)) continue;
    assert.doesNotMatch(line, /^\S+\s+\[/u, `${dockerfile}: JSON-form ${line} is not parsed here`);
    const words = line.split(/\s+/u).slice(1).filter((word) => !word.startsWith("--"));
    for (const source of words.slice(0, -1)) {
      const file = path.posix.join(context, source.replace(/\*$/u, ""));
      if (dependencyManifest.test(path.posix.basename(file))) sources.push(file);
    }
  }
  return sources;
}

// The trivy command with its image argument normalized; the rest is compared
// byte for byte.
function gate(text) {
  const lines = runBlock(text).trimEnd().split("\n");
  assert.match(lines.at(-1), /^ {2}"\$[A-Z_]+"$/u);
  lines[lines.length - 1] = '  "$IMAGE"';
  return `${lines.join("\n")}\n`;
}

function trivyFlags(run) {
  const command = run.slice(run.indexOf("trivy image \\\n"));
  return command.split("\n").slice(1).map((line) => line.trim().replace(/ \\$/u, ""))
    .filter((line) => line.startsWith("--"));
}

function triggers() {
  return scanSource.slice(scanSource.indexOf("\non:\n") + 1, scanSource.indexOf("\npermissions:"));
}

function pathFilter() {
  const block = triggers().match(/^ {2}pull_request:\n {4}paths:\n((?: {6}(?:- |# ).*\n)+)/mu)?.[1];
  assert.ok(block, "pull requests run only for image inputs");
  return block.split("\n").filter((line) => line && !line.startsWith("      #"))
    .map((line) => line.match(/^ {6}- "([^"]+)"$/u)[1]);
}

function glob(pattern) {
  const source = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*/gu, "\u0000").replace(/\*/gu, "[^/]*").replace(/\u0000/gu, ".*");
  return new RegExp(`^${source}$`, "u");
}

function filtered(file) {
  return pathFilter().some((pattern) => glob(pattern).test(file));
}

// Evaluates a job condition the way Actions does for the operators used here.
function evaluate(expression, github, cancelled = false) {
  const js = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(/(github\.[\w.]+) (==|!=) ('[^']*')/gu,
      (_, left, operator, right) => `${operator === "!=" ? "!" : ""}actionsEqual(${left}, ${right})`);
  assert.doesNotMatch(js, /[!=]=/u);
  return vm.runInNewContext(js, { github, cancelled: () => cancelled,
    actionsEqual: (a, b) => typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b,
  }, { timeout: 1000 });
}

function condition(section) {
  const folded = section.match(/^    if: >-\n((?: {6}.*\n)+)/mu);
  if (folded) return folded[1].split("\n").map((line) => line.trim()).join(" ").trim();
  return section.match(/^    if: (.+)$/mu)?.[1];
}

const context = (changes = {}) => ({ repository: "instafy-dev/instafy", ref: "refs/heads/main", event_name: "schedule", ...changes });

test("no step logs in, pushes, tags a registry reference, writes a cache or holds a secret", () => {
  assert.doesNotMatch(scanSource,
    /docker\/login-action|docker login|docker push|--push\b|push: true|cache-to|type=gha|imagetools|docker tag\b|--output[= ]type=(?:registry|image)|registry-auth|DOCKER_AUTH_CONFIG|packages:|write-all|secrets\./u);
  // The only registry reference is the anonymous read of the publisher's layer cache.
  const cacheFrom = withInputs(step(publisher.runtime, "Build audit image"))["cache-from"];
  assert.deepEqual(scanSource.split("\n").filter((line) => line.includes("ghcr.io")),
    [`          cache-from: ${cacheFrom}`]);
  // Images exist only in the runner's engine, under a local name with no registry or namespace.
  const build = withInputs(step(scan.runtime, "Build audit image"));
  assert.equal(build.push, "false");
  assert.equal(build.load, "true");
  assert.match(build.tags, /^instafy-image-scan:[\w${}. -]+$/u);
  const serviceBuild = runBlock(step(scan.services, "Build amd64 image"));
  assert.match(serviceBuild, /^scan_tag="instafy-image-scan:service-\$\{IMAGE_KEY\}"$/mu);
  assert.equal((scanSource.match(/instafy-image-scan:[^\s"]*/gu) ?? []).filter((name) => name.includes("/")).length, 0);
  // The workflow token reaches only the reporting job.
  assert.equal((scanSource.match(/github\.token/gu) ?? []).length, 1);
  assert.match(scan.report, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
});

test("permissions are read-only except one issue writer that pull requests never reach", () => {
  assert.match(scanSource, /^permissions: \{\}$/mu);
  // Exactly these three jobs, so no other job can carry a permission or a token.
  const jobKeys = [...scanSource.slice(scanSource.indexOf("\njobs:\n")).matchAll(/^ {2}([^\s#][^:]*):/gmu)].map((match) => match[1]);
  assert.deepEqual(jobKeys, ["runtime", "services", "report"]);
  assert.equal((scanSource.match(/:\s*write\b/gu) ?? []).length, 1, "issues: write is the only write scope");
  assert.deepEqual(permissions(scan.runtime), { contents: "read" });
  assert.deepEqual(permissions(scan.services), { contents: "read" });
  assert.deepEqual(permissions(scan.report), { actions: "read", contents: "read", issues: "write" });
  assert.equal((scanSource.match(/issues: write/gu) ?? []).length, 1);

  const report = condition(scan.report);
  assert.equal(evaluate(report, context()), true);
  assert.equal(evaluate(report, context({ event_name: "workflow_dispatch" })), true);
  for (const github of [
    context({ event_name: "pull_request", ref: "refs/pull/7/merge" }),
    context({ event_name: "pull_request" }),
    context({ event_name: "pull_request_target" }),
    context({ event_name: "push" }),
    context({ event_name: "workflow_dispatch", ref: "refs/heads/topic" }),
    context({ repository: "someone/instafy" }),
  ]) assert.equal(evaluate(report, github), false, JSON.stringify(github));
  assert.equal(evaluate(report, context(), true), false, "a cancelled run reports nothing");
  assert.match(scan.report, /^    needs:\n {6}- runtime\n {6}- services\n/mu);

  // Scans run for every pull request and dispatch; schedules only in this repository.
  for (const section of [scan.runtime, scan.services]) {
    const value = condition(section);
    assert.equal(evaluate(value, context({ event_name: "pull_request", ref: "refs/pull/7/merge" })), true);
    assert.equal(evaluate(value, context({ event_name: "workflow_dispatch", repository: "someone/instafy" })), true);
    assert.equal(evaluate(value, context()), true);
    assert.equal(evaluate(value, context({ repository: "someone/instafy" })), false);
  }
});

test("triggers are nightly, manual and pull requests that change image inputs", () => {
  const on = triggers();
  assert.match(on, /^ {2}schedule:\n {4}- cron: "17 3 \* \* \*"\n/mu);
  assert.match(on, /^ {2}workflow_dispatch: \{\}\n/mu);
  assert.doesNotMatch(on, /pull_request_target|workflow_run|push:|paths-ignore|branches/u);
  assert.match(scanSource, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);

  const paths = pathFilter();
  for (const required of ["docker/**", ".github/workflows/image-scan.yml", ".github/workflows/publish-runtime-agent.yml",
    ".github/workflows/publish-production-services.yml", "scripts/check-production-image-inputs.test.mjs",
    "scripts/check-image-scan-workflow.test.mjs"]) assert.ok(paths.includes(required), required);
  // Every published Dockerfile, every script a Dockerfile copies, and every
  // script this workflow runs is a pull-request input.
  const dockerfiles = ["docker/runtime/Dockerfile", ...matrix(publisher.services).map((cell) => cell.dockerfile)];
  for (const dockerfile of dockerfiles) {
    assert.ok(filtered(dockerfile), dockerfile);
    for (const match of read(dockerfile).matchAll(/^COPY (?!--from)(scripts\/\S+)/gmu)) assert.ok(filtered(match[1]), match[1]);
  }
  // Every dependency manifest and lockfile a published Dockerfile copies,
  // including the runtime CLI's npm dependencies that ship in the image.
  const builds = [{ dockerfile: "docker/runtime/Dockerfile", context: "." },
    ...matrix(publisher.services).map(({ dockerfile, context: buildContext }) => ({ dockerfile, context: buildContext }))];
  const manifests = builds.flatMap(({ dockerfile, context: buildContext }) => copiedManifests(dockerfile, buildContext));
  for (const required of ["pnpm-lock.yaml", "packages/instafy-cli/package.json", "packages/runtime-agent/Cargo.lock",
    "packages/tunnel-broker/Cargo.lock"]) assert.ok(manifests.includes(required), required);
  for (const manifest of manifests) {
    assert.ok(fs.existsSync(path.join(root, manifest)), manifest);
    assert.ok(filtered(manifest), `${manifest} is copied into an image build`);
  }
  for (const match of scanSource.slice(scanSource.indexOf("\njobs:\n")).matchAll(/\bscripts\/[\w./-]+\.(?:sh|mjs)\b/gu)) {
    assert.ok(filtered(match[0]), match[0]);
  }
  // No stale entry: each literal path exists, and each glob's directory does.
  for (const pattern of paths) {
    const literal = pattern.split("*")[0].replace(/\/$/u, "");
    assert.ok(fs.existsSync(path.join(root, literal)), pattern);
  }
  assert.ok(!filtered("packages/frontend/src/App.tsx"), "ordinary source changes do not rebuild every image");
});

test("cells equal the publishers' matrices and run on the same hosted runners", () => {
  const runtimeCells = matrix(publisher.runtime).map(({ tag_prefix: _unused, ...cell }) => cell);
  assert.deepEqual(matrix(scan.runtime), runtimeCells);
  assert.equal(runtimeCells.length, 4);
  assert.deepEqual(matrix(scan.services), matrix(publisher.services));
  assert.equal(matrix(scan.services).length, 7);
  for (const section of [scan.runtime, scan.services]) assert.match(section, /^ {6}fail-fast: false$/mu);
  assert.deepEqual(strategy(scan.runtime), strategy(publisher.runtime));
  assert.deepEqual(strategy(scan.services), strategy(publisher.services));

  assert.match(scan.runtime, /^ {4}runs-on: \$\{\{ matrix\.runner \}\}$/mu);
  assert.match(publisher.runtime, /\|\| matrix\.runner \}\}\n/u);
  const serviceFallback = publisher.services.match(/\|\| '([\w.-]+)' \}\}\n/u)?.[1];
  assert.ok(serviceFallback);
  assert.match(scan.services, new RegExp(`^ {4}runs-on: ${serviceFallback.replace(/\./gu, "\\.")}$`, "mu"));
  assert.match(scan.report, /^ {4}runs-on: ubuntu-24\.04$/mu);
  assert.doesNotMatch(scanSource, /self-hosted|vars\.|instafy-trusted-build|instafy-ci-/u);
  for (const cell of matrix(scan.runtime)) assert.match(cell.runner, /^ubuntu-24\.04(?:-arm)?$/u);

  // The publisher's bound minus the cache export it adds after publication.
  const exported = step(publisher.runtime, "Export the scanned build's layer cache");
  const [, grace, minutes] = exported.match(/timeout --kill-after=(\d+)m (\d+)m docker buildx build/u).map(Number);
  assert.equal(timeout(scan.runtime), timeout(publisher.runtime) - minutes - grace);
  assert.equal(timeout(scan.services), timeout(publisher.services));
});

test("the same pinned Trivy runs the same blocking scan as each publisher", () => {
  const runtimeInstall = step(scan.runtime, "Install pinned Trivy");
  const publisherInstall = step(publisher.runtime, "Install pinned Trivy");
  assert.equal(runBlock(runtimeInstall), runBlock(publisherInstall));
  assert.deepEqual(env(runtimeInstall), {
    TRIVY_VERSION: env(publisherInstall).TRIVY_VERSION,
    TRIVY_ASSET: "${{ matrix.trivy_asset }}",
    TRIVY_SHA256: "${{ matrix.trivy_sha256 }}",
  });
  const servicesInstall = step(scan.services, "Install pinned Trivy");
  const publisherServicesInstall = step(publisher.services, "Install pinned Trivy");
  assert.equal(runBlock(servicesInstall), runBlock(publisherServicesInstall));
  assert.deepEqual(env(servicesInstall), env(publisherServicesInstall));
  assert.equal(env(servicesInstall).TRIVY_VERSION, env(runtimeInstall).TRIVY_VERSION);
  assert.match(env(runtimeInstall).TRIVY_VERSION, /^"\d+\.\d+\.\d+"$/u);

  const runtimeGate = step(scan.runtime, "Scan audit image");
  const servicesGate = step(scan.services, "Scan amd64 image");
  assert.equal(gate(runtimeGate), gate(step(publisher.runtime, "Scan audit image")));
  assert.equal(gate(servicesGate), gate(step(publisher.services, "Scan amd64 release candidate")));
  for (const text of [runtimeGate, servicesGate]) {
    const flags = trivyFlags(runBlock(text));
    for (const flag of ["--scanners vuln,secret", "--severity HIGH,CRITICAL", "--exit-code 1", "--ignore-unfixed"]) {
      assert.ok(flags.includes(flag), flag);
    }
    assert.doesNotMatch(text, /^        (?:if|continue-on-error):/mu, "the gate always runs after a build and always blocks");
  }
  assert.doesNotMatch(scanSource, /continue-on-error|\.trivyignore|--exit-code 0|--severity (?!HIGH,CRITICAL\b)/u);

  // The findings listing repeats the gate's filters without deciding anything.
  for (const [section, gateName] of [[scan.runtime, "Scan audit image"], [scan.services, "Scan amd64 image"]]) {
    const gateRun = runBlock(step(section, gateName));
    assert.match(gateRun, /^empty_config="\$RUNNER_TEMP\/trivy\.empty\.yaml"$/mu);
    assert.match(gateRun, /^empty_ignore="\$RUNNER_TEMP\/trivy\.empty-ignore"$/mu);
    const gateFlags = trivyFlags(gateRun).filter((flag) => flag !== "--exit-code 1")
      .map((flag) => flag.replace('"$empty_config"', '"$RUNNER_TEMP/trivy.empty.yaml"')
        .replace('"$empty_ignore"', '"$RUNNER_TEMP/trivy.empty-ignore"'));
    const listing = step(section, "List the findings that failed the scan");
    assert.match(listing, /^        if: failure\(\) && steps\.scan\.outcome == 'failure'$/mu);
    const listed = trivyFlags(runBlock(listing));
    assert.deepEqual([...listed].sort(), [...gateFlags, "--skip-db-update", "--skip-java-db-update", "--format json",
      '--output "$RUNNER_TEMP/trivy-findings.json"'].sort());
    assert.equal(runBlock(listing).trimEnd().split("\n").at(-1), runBlock(step(section, gateName)).trimEnd().split("\n").at(-1));
  }
});

test("each cell builds the publisher's exact Dockerfile, target, platform and arguments", () => {
  const ours = withInputs(step(scan.runtime, "Build audit image"));
  const theirs = withInputs(step(publisher.runtime, "Build audit image"));
  assert.deepEqual(Object.keys(ours).sort(), Object.keys(theirs).sort());
  for (const key of Object.keys(theirs)) {
    if (key === "tags") continue;
    const expected = key === "labels"
      ? theirs.labels.map((label) => label.replace("${{ needs.authorize.outputs.commit_sha }}", "${{ github.sha }}"))
      : theirs[key];
    assert.deepEqual(ours[key], expected, key);
  }
  assert.match(step(scan.runtime, "Build audit image"), /^        uses: docker\/build-push-action@[0-9a-f]{40} # v6$/mu);

  const command = (text) => {
    const run = runBlock(text);
    return run.slice(run.indexOf("docker buildx build \\\n")).split("\n").filter((line) => /^(?:docker| {2})/u.test(line))
      .join("\n").replace(/"\$(?:release|scan)_tag"/u, '"$TAG"').replace(/\$\{(?:RELEASE|SOURCE)_COMMIT\}/gu, "${COMMIT}");
  };
  const serviceBuild = step(scan.services, "Build amd64 image");
  const publisherBuild = step(publisher.services, "Build amd64 release candidate");
  assert.equal(command(serviceBuild), command(publisherBuild));
  for (const key of ["CONTEXT", "DOCKERFILE"]) assert.equal(env(serviceBuild)[key], env(publisherBuild)[key]);
  assert.equal(env(serviceBuild).SOURCE_COMMIT, "${{ github.sha }}");

  // The webdev cells run the same Shared Browser gate that publication requires.
  const smoke = step(scan.runtime, "Prove the webdev image starts the Shared Browser");
  assert.equal(runLine(smoke), runLine(step(publisher.runtime, "Prove the webdev image starts the Shared Browser")));
  assert.match(smoke, /^        if: \$\{\{ !cancelled\(\) && matrix\.flavor == 'webdev' && steps\.build\.outcome == 'success' \}\}$/mu);

  // Disk preparation matches the publisher on hosted runners.
  assert.equal(runBlock(step(scan.runtime, "Reclaim hosted-runner disk for the audited image")),
    runBlock(step(publisher.runtime, "Reclaim hosted-runner disk for the audited image")));
  const disk = runBlock(step(scan.runtime, "Require sufficient free disk for the audited image"));
  const publisherDisk = runBlock(step(publisher.runtime, "Require sufficient free disk for the audited image"));
  for (const line of publisherDisk.split("\n").filter((value) => !value.includes("::error::"))) assert.ok(disk.includes(line), line);

  const buildx = (section) => withInputs(step(section, "Set up Docker Buildx")).version;
  assert.equal(buildx(scan.runtime), buildx(publisher.runtime));
  assert.equal(buildx(scan.services), buildx(publisher.services));
});

test("steps run in the publisher's order and every action is a publisher's exact pin", () => {
  const names = (section) => steps(section).map((value) => value.match(/^ {6}- name: (.+)$/mu)[1]);
  assert.deepEqual(names(scan.runtime), ["Checkout", "Reclaim hosted-runner disk for the audited image",
    "Require sufficient free disk for the audited image", "Set up Docker Buildx", "Install pinned Trivy",
    "Build audit image", "Scan audit image", "List the findings that failed the scan",
    "Prove the webdev image starts the Shared Browser", "Summarize this image", "Upload the failure record"]);
  assert.deepEqual(names(scan.services), ["Checkout", "Set up Docker Buildx", "Install pinned Trivy", "Build amd64 image",
    "Scan amd64 image", "List the findings that failed the scan", "Summarize this image", "Upload the failure record"]);
  for (const section of [scan.runtime, scan.services]) {
    const checkout = withInputs(step(section, "Checkout"));
    assert.deepEqual(checkout, { "fetch-depth": "1", "persist-credentials": "false", ref: "${{ github.sha }}", submodules: "recursive" });
    for (const name of ["Summarize this image", "Upload the failure record"]) {
      assert.match(step(section, name), /^        if: always\(\)$/mu, name);
    }
  }
  // Every cell builds and scans; no step condition can skip one for a cell.
  for (const [section, names] of [[scan.runtime, ["Install pinned Trivy", "Build audit image", "Scan audit image"]],
    [scan.services, ["Install pinned Trivy", "Build amd64 image", "Scan amd64 image"]]]) {
    for (const name of names) assert.doesNotMatch(step(section, name), /^        if:/mu, name);
  }
  assert.equal(withInputs(step(scan.report, "Checkout"))["persist-credentials"], "false");

  const pins = (source) => new Set([...source.matchAll(/^\s+uses: ([^\s#]+)/gmu)].map((match) => match[1]));
  const published = new Set([...pins(runtimeSource), ...pins(servicesSource)]);
  for (const action of pins(scanSource)) {
    assert.match(action, /@[0-9a-f]{40}$/u);
    assert.ok(published.has(action), `${action} must reuse a publisher's exact pin`);
  }
});

test("failure records flow from each cell to the report through one artifact prefix", () => {
  for (const [section, prefix] of [[scan.runtime, "runtime-${{ matrix.flavor }}-${{ matrix.architecture }}"],
    [scan.services, "service-${{ matrix.key }}"]]) {
    const summary = env(step(section, "Summarize this image"));
    assert.equal(summary.RESULT_FILE, `\${{ runner.temp }}/image-scan-result/${prefix}.json`);
    assert.equal(summary.FINDINGS_FILE, "${{ runner.temp }}/trivy-findings.json");
    assert.equal(summary.BUILD_OUTCOME, "${{ steps.build.outcome }}");
    assert.equal(summary.CELL_SOURCE, section === scan.runtime ? withInputs(step(section, "Build audit image")).file : "${{ matrix.dockerfile }}");
    assert.equal(summary.CELL_TARGET, section === scan.runtime ? "${{ matrix.target }}" : '""');
    assert.equal(summary.SCAN_OUTCOME, "${{ steps.scan.outcome }}");
    assert.equal(runLine(step(section, "Summarize this image")), "node scripts/image-scan-report.mjs cell");
    const upload = withInputs(step(section, "Upload the failure record"));
    assert.deepEqual(upload, { name: `image-scan-result-${prefix}-attempt-\${{ github.run_attempt }}`, path: "${{ runner.temp }}/image-scan-result/",
      "if-no-files-found": "ignore", "retention-days": "7" });
    for (const id of ["build", "scan"]) assert.match(section, new RegExp(`^        id: ${id}$`, "mu"));
  }
  assert.equal(env(step(scan.runtime, "Summarize this image")).SMOKE_OUTCOME, "${{ steps.smoke.outcome }}");
  assert.equal(env(step(scan.runtime, "Summarize this image")).SMOKE_REQUIRED, "${{ matrix.flavor == 'webdev' }}");
  assert.match(scan.runtime, /^        id: smoke$/mu);
  const download = withInputs(step(scan.report, "Download the failure records"));
  // Only the current attempt's records, so a cell that passes on a re-run is not reported again.
  assert.deepEqual(download, { pattern: "image-scan-result-*-attempt-${{ github.run_attempt }}", path: "${{ runner.temp }}/image-scan-results", "merge-multiple": "true" });
  assert.equal(env(step(scan.report, "Open, update or close the tracking issue")).RESULT_DIR, "${{ runner.temp }}/image-scan-results");
  assert.ok(runBlock(step(scan.report, "Open, update or close the tracking issue")).includes(`title="${ISSUE_TITLE}"`));
});

const trivyReport = {
  Results: [
    { Target: "debian 13.1", Vulnerabilities: [
      { VulnerabilityID: "CVE-2026-0002", PkgName: "libssl3t64", InstalledVersion: "3.5.1-1", FixedVersion: "3.5.1-2", Severity: "HIGH" },
      { VulnerabilityID: "CVE-2026-0001", PkgName: "chromium", InstalledVersion: "152.0.1", FixedVersion: "152.0.2", Severity: "CRITICAL" },
    ] },
    { Target: "usr/lib/node_modules/npm", Vulnerabilities: [
      { VulnerabilityID: "CVE-2026-0003", PkgName: "undici|pipe\nline", InstalledVersion: "6.27.0", FixedVersion: "6.28.1", Severity: "HIGH" },
    ] },
    { Target: "/etc/app/config", Secrets: [{ RuleID: "aws-access-key-id", Category: "AWS", Severity: "CRITICAL", StartLine: 4 }] },
  ],
};

test("findings list every vulnerability and secret, most severe first", () => {
  const rows = scanFindings(trivyReport);
  assert.deepEqual(rows.map((row) => [row.severity, row.id, row.package]), [
    ["CRITICAL", "secret aws-access-key-id", "AWS"],
    ["CRITICAL", "CVE-2026-0001", "chromium"],
    ["HIGH", "CVE-2026-0002", "libssl3t64"],
    ["HIGH", "CVE-2026-0003", "undici|pipe\nline"],
  ]);
  assert.equal(rows[0].target, "/etc/app/config:4");
  assert.deepEqual(scanFindings({}), []);
  assert.deepEqual(scanFindings({ Results: [{ Target: "x" }] }), []);
});

test("a cell summary names the image, the failed check and each failing package", () => {
  const failed = cellResult({ image: "instafy-runtime-agent webdev", source: "docker/runtime/Dockerfile", target: "runtime-webdev",
    platform: "linux/arm64", build: "success", scan: "failure", smoke: "success", smokeRequired: true,
    findings: scanFindings(trivyReport) });
  assert.equal(failed.passed, false);
  const markdown = cellMarkdown(failed);
  assert.match(markdown, /^### Image scan failed: instafy-runtime-agent webdev \(linux\/arm64\)$/mu);
  assert.match(markdown, /^Built from `docker\/runtime\/Dockerfile` target `runtime-webdev` for `linux\/arm64`\. Nothing was pushed/mu);
  assert.match(markdown, /\| Trivy scan \(fixable HIGH and CRITICAL, secrets\) \| failed \|/u);
  assert.match(markdown, /\| Shared Browser starts \| passed \|/u);
  assert.match(markdown, /Trivy found 4 fixable HIGH or CRITICAL findings in packages `AWS`, `chromium`, `libssl3t64`, `undici\|pipeline`\./u);
  assert.match(markdown, /^\| CRITICAL \| `CVE-2026-0001` \| `chromium` \| `152\.0\.1` \| `152\.0\.2` \| `debian 13\.1` \|$/mu);
  assert.match(markdown, /^\| HIGH \| `CVE-2026-0003` \| `undici\\\|pipe line` \| `6\.27\.0` \| `6\.28\.1` \| `usr\/lib\/node_modules\/npm` \|$/mu,
    "untrusted values cannot break the table");
  // A scoped npm package stays inside a code span, so the issue mentions nobody.
  const scoped = cellMarkdown(cellResult({ image: "a", source: "b", platform: "linux/amd64", build: "success", scan: "failure",
    smoke: "", smokeRequired: false, findings: [{ severity: "HIGH", id: "GHSA-x`y", package: "@npmcli/arborist", installed: "9.0.0",
      fixed: "9.0.1", target: "usr/lib/node_modules/@npmcli/arborist/package.json" }] }));
  assert.match(scoped, /\| `GHSA-x'y` \| `@npmcli\/arborist` \|/u);
  assert.doesNotMatch(scoped.replace(/`[^`\n]*`/gu, ""), /@/u);

  const broken = cellResult({ image: "instafy-git-edge", source: "docker/git-edge/Dockerfile", platform: "linux/amd64",
    build: "failure", scan: "skipped", smoke: "", smokeRequired: false, findings: [] });
  assert.match(cellMarkdown(broken), /The image did not build/u);
  assert.match(cellMarkdown(broken), /\| Trivy scan \(fixable HIGH and CRITICAL, secrets\) \| not run, an earlier step failed \|/u);
  assert.doesNotMatch(cellMarkdown(broken), /Shared Browser/u);

  const unlisted = cellResult({ image: "a", source: "b", platform: "linux/amd64", build: "success", scan: "failure",
    smoke: "", smokeRequired: false, findings: null });
  assert.match(cellMarkdown(unlisted), /failed without a findings list/u);
  const browser = cellResult({ image: "a", source: "b", platform: "linux/amd64", build: "success", scan: "success",
    smoke: "failure", smokeRequired: true, findings: [] });
  assert.equal(browser.passed, false);
  assert.match(cellMarkdown(browser), /Headed Chromium did not answer/u);
  const timedOut = cellResult({ image: "a", source: "b", platform: "linux/amd64", build: "cancelled", scan: "",
    smoke: "", smokeRequired: false, findings: [] });
  assert.equal(timedOut.passed, false);
  assert.match(cellMarkdown(timedOut), /\| Build \| cancelled \(time limit or manual cancel\) \|/u);

  const passed = cellResult({ image: "instafy-origin-gateway", source: "docker/origin-gateway/Dockerfile",
    platform: "linux/amd64", build: "success", scan: "success", smoke: "", smokeRequired: false, findings: [] });
  assert.equal(passed.passed, true);
  assert.match(cellMarkdown(passed), /^### Image scan passed: instafy-origin-gateway \(linux\/amd64\)$/mu);
  assert.match(cellMarkdown(passed), /^Built from `docker\/origin-gateway\/Dockerfile` for `linux\/amd64`\./mu);
});

function runCell(environment) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-scan-cell-"));
  try {
    const summary = path.join(dir, "summary.md");
    const result = path.join(dir, "result", "cell.json");
    const findings = path.join(dir, "findings.json");
    if (environment.findings) fs.writeFileSync(findings, JSON.stringify(environment.findings));
    const run = spawnSync(process.execPath, [path.join(root, "scripts/image-scan-report.mjs"), "cell"], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, RESULT_FILE: result, FINDINGS_FILE: findings,
        CELL_IMAGE: "instafy-runtime-agent base", CELL_SOURCE: "docker/runtime/Dockerfile", CELL_TARGET: "runtime",
        CELL_PLATFORM: "linux/amd64", SMOKE_OUTCOME: "", SMOKE_REQUIRED: "false", ...environment.env },
    });
    return { ...run, summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
      record: fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, "utf8")) : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the cell command writes a summary always and a failure record only for a failed cell", () => {
  const failed = runCell({ env: { BUILD_OUTCOME: "success", SCAN_OUTCOME: "failure" }, findings: trivyReport });
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.summary, /CVE-2026-0001/u);
  assert.equal(failed.record.passed, false);
  assert.equal(failed.record.findings.length, 4);
  assert.match(failed.stdout, /^::error title=Image scan failed::instafy-runtime-agent base \(linux\/amd64\): Trivy found 4 /mu);
  // A package name cannot inject a second workflow command.
  assert.doesNotMatch(failed.stdout, /^(?!::error title=Image scan failed::)::/mu);

  const passed = runCell({ env: { BUILD_OUTCOME: "success", SCAN_OUTCOME: "success" } });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.summary, /Image scan passed/u);
  assert.equal(passed.record, null);
  assert.doesNotMatch(passed.stdout, /::error/u);

  const unreadable = runCell({ env: { BUILD_OUTCOME: "success", SCAN_OUTCOME: "failure" } });
  assert.equal(unreadable.status, 0);
  assert.match(unreadable.summary, /without a findings list/u);
});

const jobsFixture = { total_count: 4, jobs: [
  { name: "Scan webdev arm64 runtime", conclusion: "failure", html_url: "https://github.com/instafy-dev/instafy/actions/runs/9/job/1",
    steps: [{ name: "Build audit image", conclusion: "success" }, { name: "Scan audit image", conclusion: "failure" }] },
  { name: "Scan proxy service", conclusion: "success", html_url: "https://github.com/instafy-dev/instafy/actions/runs/9/job/2", steps: [] },
  { name: "Scan gitEdge service", conclusion: "cancelled", html_url: "javascript:alert(1)", steps: [] },
  { name: "Report to the tracking issue", conclusion: null, html_url: "https://github.com/instafy-dev/instafy/actions/runs/9/job/4", steps: [] },
] };

test("the issue body links each failed job and bounds its findings", () => {
  const record = cellResult({ image: "instafy-runtime-agent webdev", source: "docker/runtime/Dockerfile", target: "runtime-webdev",
    platform: "linux/arm64", build: "success", scan: "failure", smoke: "success", smokeRequired: true,
    findings: Array.from({ length: 25 }, (_, index) => ({ severity: "HIGH", id: `CVE-2026-${1000 + index}`, package: "chromium",
      installed: "1", fixed: "2", target: "debian" })) });
  const body = issueBody({ repositoryUrl: "https://github.com/instafy-dev/instafy", runUrl: "https://github.com/instafy-dev/instafy/actions/runs/9",
    sha: "a".repeat(40), jobs: jobsFixture, results: [record] });
  assert.match(body, /^<!-- instafy-image-scan-tracking -->$/mu);
  assert.match(body, /\[this run\]\(https:\/\/github\.com\/instafy-dev\/instafy\/actions\/runs\/9\)/u);
  assert.match(body, /^\| \[Scan webdev arm64 runtime\]\(https:\/\/github\.com\/instafy-dev\/instafy\/actions\/runs\/9\/job\/1\) \| failure \| Scan audit image \|$/mu);
  assert.match(body, /^\| Scan gitEdge service \| cancelled \| see the log \|$/mu, "a non-GitHub link is never rendered");
  assert.doesNotMatch(body, /Scan proxy service|Report to the tracking issue|javascript:/u);
  assert.equal((body.match(/^\| HIGH \| `CVE-2026-/gmu) ?? []).length, ISSUE_ROW_LIMIT);
  assert.match(body, /15 more findings are in the job log\./u);
  assert.match(body, /https:\/\/github\.com\/instafy-dev\/instafy\/blob\/main\/docs\/Testing\.md#nightly-image-scan/u);

  // Truncation keeps whole cell sections, so every code span stays closed.
  const huge = Array.from({ length: 600 }, (_, index) => ({ ...record, image: `image-${index}-${"x".repeat(150)}`,
    findings: record.findings.map((row) => ({ ...row, package: "@npmcli/arborist" })) }));
  const truncated = issueBody({ repositoryUrl: "r", runUrl: "u", sha: "s", jobs: jobsFixture, results: huge });
  assert.ok(truncated.length < ISSUE_BODY_LIMIT);
  const shown = (truncated.match(/^### Image scan failed: image-\d+-/gmu) ?? []).length;
  assert.ok(shown > 0 && shown < huge.length);
  assert.match(truncated, new RegExp(`^${huge.length - shown} more failed images are not shown here;`, "mu"));
  for (const line of truncated.split("\n")) assert.equal((line.match(/`/gu) ?? []).length % 2, 0, line);
  assert.doesNotMatch(truncated.replace(/`[^`\n]*`/gu, ""), /@npmcli/u, "a scope never sits outside a code span");
  assert.match(issueBody({ repositoryUrl: "r", runUrl: "u", sha: "s", jobs: { jobs: [] }, results: [] }), /job list was unavailable/u);

  const comment = issueComment({ runUrl: "https://github.com/instafy-dev/instafy/actions/runs/9", sha: "b".repeat(40), jobs: jobsFixture });
  assert.equal(comment, `Still failing at \`${"b".repeat(40)}\` in [this run](https://github.com/instafy-dev/instafy/actions/runs/9): Scan gitEdge service, Scan webdev arm64 runtime. The issue body shows the current findings.\n`);
});

// Runs the workflow's actual reporting Bash with an inert gh that answers
// only the fixture's exact endpoints, so no request can reach GitHub.
function report({ runtime = "success", services = "success", issues = [], jobs = jobsFixture, results = [], failing = [] } = {}) {
  const script = runBlock(step(scan.report, "Open, update or close the tracking issue"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-scan-report-"));
  try {
    const repo = "instafy-dev/instafy";
    const responses = {
      [`GET repos/${repo}/issues`]: issues,
      [`GET repos/${repo}/actions/runs/9/attempts/2/jobs`]: jobs,
      [`POST repos/${repo}/issues`]: { number: 42 },
      [`PATCH repos/${repo}/issues/7`]: { number: 7 },
      [`POST repos/${repo}/issues/7/comments`]: { id: 1 },
    };
    for (const key of failing) responses[key] = { error: true };
    fs.writeFileSync(path.join(dir, "responses.json"), JSON.stringify(responses));
    fs.writeFileSync(path.join(dir, "calls.jsonl"), "");
    fs.writeFileSync(path.join(dir, "gh"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "api" || args[1] !== "--method") process.exit(23);
const method = args[2], endpoint = args[3], fields = {};
for (let index = 4; index < args.length; index += 2) {
  if (!["-f", "-F"].includes(args[index])) process.exit(24);
  const [key, ...rest] = args[index + 1].split("=");
  const value = rest.join("=");
  fields[key] = args[index] === "-F" && value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : value;
}
fs.appendFileSync(process.env.CALLS, JSON.stringify({ method, endpoint, fields }) + "\\n");
const responses = JSON.parse(fs.readFileSync(process.env.RESPONSES, "utf8"));
const key = method + " " + endpoint;
if (!Object.hasOwn(responses, key) || responses[key]?.error) process.exit(19);
process.stdout.write(JSON.stringify(responses[key]));
`, { mode: 0o700 });
    const resultDir = path.join(dir, "results");
    fs.mkdirSync(resultDir);
    for (const [index, record] of results.entries()) fs.writeFileSync(path.join(resultDir, `${index}.json`), JSON.stringify(record));
    const summary = path.join(dir, "summary");
    fs.writeFileSync(summary, "");
    const run = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
      cwd: root, encoding: "utf8", timeout: 20_000,
      env: { PATH: `${dir}:${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        GH_TOKEN: "inert-fixture", CALLS: path.join(dir, "calls.jsonl"), RESPONSES: path.join(dir, "responses.json"),
        GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "2",
        GITHUB_SHA: "c".repeat(40), GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir,
        RUNTIME_RESULT: runtime, SERVICES_RESULT: services, RESULT_DIR: resultDir },
    });
    const calls = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    return { ...run, calls, summary: fs.readFileSync(summary, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const trackingIssue = { number: 7, title: ISSUE_TITLE };
const failedRecord = cellResult({ image: "instafy-runtime-agent webdev", source: "docker/runtime/Dockerfile", target: "runtime-webdev",
  platform: "linux/arm64", build: "success", scan: "failure", smoke: "success", smokeRequired: true, findings: scanFindings(trivyReport) });

test("a failing run opens one tracking issue with the failing cells, links and findings", () => {
  const result = report({ runtime: "failure", results: [failedRecord],
    issues: [{ number: 3, title: ISSUE_TITLE, pull_request: {} }, { number: 5, title: "Something else" }] });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(result.calls.map(({ method, endpoint }) => `${method} ${endpoint}`), [
    "GET repos/instafy-dev/instafy/issues",
    "GET repos/instafy-dev/instafy/actions/runs/9/attempts/2/jobs",
    "POST repos/instafy-dev/instafy/issues",
  ]);
  assert.deepEqual(result.calls[0].fields, { state: "open", creator: "github-actions[bot]", per_page: "100" });
  const created = result.calls[2].fields;
  assert.equal(created.title, ISSUE_TITLE);
  assert.match(created.body, /\[this run\]\(https:\/\/github\.com\/instafy-dev\/instafy\/actions\/runs\/9\)/u);
  assert.match(created.body, /Scan webdev arm64 runtime/u);
  assert.match(created.body, /`CVE-2026-0001` \| `chromium`/u);
  assert.match(result.summary, /opened #42/u);
});

test("a failing run updates the open tracking issue and comments instead of opening another", () => {
  const result = report({ services: "failure", issues: [{ number: 9, title: ISSUE_TITLE.toLowerCase() }, trackingIssue], results: [failedRecord] });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(result.calls.map(({ method, endpoint }) => `${method} ${endpoint}`), [
    "GET repos/instafy-dev/instafy/issues",
    "GET repos/instafy-dev/instafy/actions/runs/9/attempts/2/jobs",
    "PATCH repos/instafy-dev/instafy/issues/7",
    "POST repos/instafy-dev/instafy/issues/7/comments",
  ]);
  assert.match(result.calls[2].fields.body, /CVE-2026-0001/u);
  assert.match(result.calls[3].fields.body, /^Still failing at `c{40}`/u);
});

test("a passing run closes the tracking issue, and does nothing when none is open", () => {
  const closed = report({ issues: [trackingIssue] });
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  assert.deepEqual(closed.calls.map(({ method, endpoint, fields }) => [method, endpoint, fields.state ?? null]), [
    ["GET", "repos/instafy-dev/instafy/issues", "open"],
    ["POST", "repos/instafy-dev/instafy/issues/7/comments", null],
    ["PATCH", "repos/instafy-dev/instafy/issues/7", "closed"],
  ]);
  assert.match(closed.calls[1].fields.body, /passed at `c{40}`/u);
  assert.equal(closed.calls[2].fields.state_reason, "completed");

  const quiet = report();
  assert.equal(quiet.status, 0, quiet.stderr + quiet.stdout);
  assert.equal(quiet.calls.length, 1);
  assert.match(quiet.summary, /no tracking issue is open/u);
});

test("a cancelled or skipped cell job reports failure, an unlisted run still reports, and a failed issue read writes nothing", () => {
  for (const [runtime, services] of [["cancelled", "success"], ["success", "skipped"], ["failure", "failure"]]) {
    const result = report({ runtime, services });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.at(-1).endpoint, "repos/instafy-dev/instafy/issues");
    assert.equal(result.calls.at(-1).method, "POST");
  }
  const unlisted = report({ runtime: "failure", failing: ["GET repos/instafy-dev/instafy/actions/runs/9/attempts/2/jobs"] });
  assert.equal(unlisted.status, 0, unlisted.stderr);
  assert.match(unlisted.stdout, /::warning::The run's jobs could not be listed/u);
  assert.match(unlisted.calls.at(-1).fields.body, /job list was unavailable/u);

  const unreadable = report({ runtime: "failure", failing: ["GET repos/instafy-dev/instafy/issues"] });
  assert.notEqual(unreadable.status, 0);
  assert.deepEqual(unreadable.calls.map(({ method }) => method), ["GET"]);
  const malformed = report({ runtime: "failure", issues: [{ number: "7; rm -rf /", title: ISSUE_TITLE }] });
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.calls.length, 1);
});

test("failure records are read only for failed cells", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-scan-records-"));
  try {
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(failedRecord));
    fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify({ ...failedRecord, passed: true }));
    fs.writeFileSync(path.join(dir, "c.txt"), "ignored");
    assert.deepEqual(readResults(dir).map((record) => record.image), ["instafy-runtime-agent webdev"]);
    assert.deepEqual(readResults(path.join(dir, "missing")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
