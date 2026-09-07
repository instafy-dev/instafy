import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  containerArguments,
  dockerEnvironment,
  runSmoke,
  validateImage,
  validateRecord,
  validateReport,
} from "./controller-image-smoke.mjs";

const repository = "ghcr.io/instafy-dev/instafy-runtime-controller";
const commit = "a".repeat(40);
const ref = `${repository}@sha256:${"b".repeat(64)}`;
const imageId = `sha256:${"c".repeat(64)}`;
const containerId = "d".repeat(64);
const scope = "isolated_controller_startup_before_database_io";
const environment = {
  PATH: "/synthetic/bin",
  DOCKER_HOST: "unix:///synthetic/docker.sock",
  DOCKER_CONFIG: "/synthetic/private-docker-config",
  DOCKER_CONTEXT: "remote-context",
  DOCKER_AUTH_CONFIG: "synthetic-auth-config",
  DOCKER_CERT_PATH: "/synthetic/client-certs",
  DOCKER_TLS_VERIFY: "1",
  HOME: "/synthetic/private-home",
  GH_TOKEN: "synthetic-token",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
  HTTPS_PROXY: "https://proxy.invalid",
  NODE_OPTIONS: "--inspect",
};

function record() {
  return {
    schemaVersion: 1, key: "controller", coreCommit: commit,
    platform: "linux/amd64", releaseTag: `${repository}:${commit}`, ref,
  };
}

function image() {
  return {
    Os: "linux", Architecture: "amd64", Id: imageId, RepoDigests: [ref],
    Config: {
      Labels: {
        "org.opencontainers.image.revision": commit,
        "org.opencontainers.image.source": "https://github.com/instafy-dev/instafy",
      },
      Entrypoint: ["/usr/local/bin/runtime-controller"],
      Volumes: null,
    },
  };
}

function report() {
  return {
    schemaVersion: 1, passed: true, scope,
    cases: [
      ["existing_user_lookup", { jwks: 1, lookup: 1, create: 0 }],
      ["missing_user_creation", { jwks: 1, lookup: 1, create: 1 }],
      ["explicit_uuid_bypass", { jwks: 1, lookup: 0, create: 0 }],
    ].map(([name, requests]) => ({ name, passed: true, exitCode: 1, durationMs: 20, requests })),
  };
}

function harnessFixture(t, basename = "startup-smoke") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "controller-image-smoke-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const harness = path.join(directory, basename);
  // The injected executor never runs this synthetic file.
  fs.writeFileSync(harness, "synthetic harness fixture\n", { mode: 0o755 });
  return fs.realpathSync(harness);
}

function dockerFake(overrides = {}) {
  const calls = [];
  const defaults = {
    image: JSON.stringify([image()]), create: `${containerId}\n`,
    start: JSON.stringify(report()), inspect: "0\n", rm: `${containerId}\n`,
  };
  return {
    calls,
    execute(command, args, options) {
      assert.equal(command, "docker");
      assert.ok(Object.hasOwn(defaults, args[0]), `unexpected Docker command: ${args[0]}`);
      assert.equal(fs.statSync(options.env.DOCKER_CONFIG).mode & 0o777, 0o700);
      assert.deepEqual(fs.readdirSync(options.env.DOCKER_CONFIG), []);
      calls.push({ command, args, options });
      const result = overrides[args[0]];
      return result ?? { status: 0, stdout: defaults[args[0]], stderr: "" };
    },
  };
}

function assertTemporaryConfigRemoved(calls) {
  assert.ok(calls.length > 0);
  const directories = new Set(calls.map(({ options }) => options.env.DOCKER_CONFIG));
  assert.equal(directories.size, 1);
  for (const directory of directories) assert.equal(fs.existsSync(directory), false);
}

test("validates the exact controller record and inspected image identity", () => {
  assert.equal(validateRecord(record(), commit), ref);
  assert.equal(validateImage(image(), record(), commit), imageId);
});

for (const [name, change] of [
  ["schema", { schemaVersion: 2 }],
  ["service", { key: "proxy" }],
  ["commit", { coreCommit: "e".repeat(40) }],
  ["platform", { platform: "linux/arm64" }],
  ["mutable tag", { releaseTag: `${repository}:latest` }],
  ["mutable reference", { ref: `${repository}:${commit}` }],
  ["repository", { ref: `ghcr.io/example/controller@sha256:${"b".repeat(64)}` }],
  ["digest", { ref: `${repository}@sha256:short` }],
  ["uppercase digest", { ref: `${repository}@sha256:${"B".repeat(64)}` }],
]) {
  test(`rejects a controller record with mismatched ${name}`, () => {
    assert.throws(() => validateRecord({ ...record(), ...change }, commit), /invalid_controller_image_record/u);
  });
}

test("rejects missing records and non-exact commit inputs", () => {
  assert.throws(() => validateRecord(null, commit), /invalid_controller_image_record/u);
  for (const value of [undefined, "main", commit.slice(0, 39), commit.toUpperCase()]) {
    assert.throws(() => validateRecord(record(), value), /invalid_controller_image_record/u);
  }
});

for (const [name, mutate] of [
  ["OS", (value) => { value.Os = "windows"; }],
  ["architecture", (value) => { value.Architecture = "arm64"; }],
  ["image ID", (value) => { value.Id = "latest"; }],
  ["repository digest", (value) => { value.RepoDigests = []; }],
  ["digest field type", (value) => { value.RepoDigests = ref; }],
  ["revision label", (value) => { value.Config.Labels["org.opencontainers.image.revision"] = "e".repeat(40); }],
  ["source label", (value) => { value.Config.Labels["org.opencontainers.image.source"] = "https://github.com/example/controller"; }],
  ["missing labels", (value) => { delete value.Config.Labels; }],
  ["entrypoint", (value) => { value.Config.Entrypoint = ["/bin/sh"]; }],
  ["extra entrypoint arguments", (value) => { value.Config.Entrypoint.push("--other"); }],
  ["declared volumes", (value) => { value.Config.Volumes = { "/srv": {} }; }],
]) {
  test(`rejects inspected controller image with mismatched ${name}`, () => {
    const value = image();
    mutate(value);
    assert.throws(() => validateImage(value, record(), commit), /controller_image_identity_mismatch/u);
  });
}

test("requires all three successful cases and reconstructs only the receipt fields", () => {
  const value = report();
  value.cases[0].failures = [];
  assert.deepEqual(validateReport(value), report().cases);
});

for (const [name, mutate] of [
  ["empty cases", (value) => { value.cases = []; }],
  ["missing case", (value) => { value.cases.pop(); }],
  ["duplicate case", (value) => { value.cases[2] = value.cases[0]; }],
  ["reordered cases", (value) => { value.cases.reverse(); }],
  ["wrong scope", (value) => { value.scope = "healthy_database_startup"; }],
  ["wrong schema", (value) => { value.schemaVersion = 2; }],
  ["failed report", (value) => { value.passed = false; }],
  ["top-level failure", (value) => { value.failure = "synthetic_failure"; }],
  ["top-level skip", (value) => { value.skipped = true; }],
  ["case skip", (value) => { value.cases[0].skipped = true; }],
  ["case retry", (value) => { value.cases[0].retries = 1; }],
  ["raw child output", (value) => { value.cases[0].stdout = "synthetic-secret"; }],
  ["case failure", (value) => { value.cases[0].passed = false; }],
  ["unexpected successful controller exit", (value) => { value.cases[0].exitCode = 0; }],
  ["controller panic", (value) => { value.cases[0].exitCode = 101; }],
  ["negative duration", (value) => { value.cases[0].durationMs = -1; }],
  ["unbounded duration", (value) => { value.cases[0].durationMs = 60_001; }],
  ["fractional duration", (value) => { value.cases[0].durationMs = 0.5; }],
  ["non-finite duration", (value) => { value.cases[0].durationMs = Infinity; }],
  ["failure list", (value) => { value.cases[0].failures = ["synthetic_failure"]; }],
  ["malformed failure list", (value) => { value.cases[0].failures = ""; }],
  ["missing JWKS request", (value) => { value.cases[0].requests.jwks = 0; }],
  ["unexpected user creation", (value) => { value.cases[0].requests.create = 1; }],
  ["lookup in UUID bypass", (value) => { value.cases[2].requests.lookup = 1; }],
  ["extra request counter", (value) => { value.cases[0].requests.other = 1; }],
]) {
  test(`rejects a startup report with ${name}`, () => {
    const value = report();
    mutate(value);
    assert.throws(() => validateReport(value), /controller_startup_(?:report|case)_failed/u);
  });
}

test("Docker receives only the isolated config, PATH, and optional local socket", () => {
  assert.deepEqual(dockerEnvironment("/synthetic/empty-config", environment), {
    PATH: environment.PATH, DOCKER_CONFIG: "/synthetic/empty-config", DOCKER_HOST: environment.DOCKER_HOST,
  });
  assert.deepEqual(dockerEnvironment("/synthetic/empty-config", { PATH: environment.PATH }), {
    PATH: environment.PATH, DOCKER_CONFIG: "/synthetic/empty-config",
  });
  for (const host of ["tcp://remote.invalid:2375", "ssh://remote.invalid", "unix:///tmp/socket\nother", "unix:///tmp/socket\rother"]) {
    assert.throws(() => dockerEnvironment("/synthetic/empty-config", { DOCKER_HOST: host }), /only_local_unix_docker_hosts_are_supported/u);
  }
});

test("Docker arguments pin the image and isolate the packaged controller fixture", () => {
  assert.deepEqual(containerArguments(ref, "/synthetic fixture/startup-smoke", "owned-container"), [
    "create", "--name", "owned-container", "--platform", "linux/amd64", "--pull", "never",
    "--network", "none", "--read-only", "--user", "65532:65532",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "128", "--memory", "512m", "--memory-swap", "512m",
    "--cpus", "2", "--stop-timeout", "5",
    "--mount", "type=bind,src=/synthetic fixture/startup-smoke,dst=/fixture/startup-smoke,readonly",
    "--entrypoint", "/fixture/startup-smoke", ref, "/usr/local/bin/runtime-controller",
  ]);
});

test("runs the exact image with bounded sanitized Docker calls and removes only its container", (t) => {
  const harness = harnessFixture(t);
  const fake = dockerFake();
  assert.deepEqual(runSmoke(record(), commit, harness, { environment, execute: fake.execute }), {
    schemaVersion: 1, passed: true, scope, coreCommit: commit, ref, imageId,
    platform: "linux/amd64",
    harnessSha256: createHash("sha256").update(fs.readFileSync(harness)).digest("hex"),
    cases: report().cases,
  });
  assert.deepEqual(fake.calls.map(({ args }) => args[0]), ["image", "create", "start", "inspect", "rm"]);
  assert.deepEqual(fake.calls[0].args, ["image", "inspect", ref]);
  const name = fake.calls[1].args[2];
  assert.match(name, /^controller-startup-[0-9a-f-]{36}$/u);
  assert.deepEqual(fake.calls[1].args, containerArguments(ref, harness, name));
  assert.deepEqual(fake.calls[2].args, ["start", "--attach", containerId]);
  assert.deepEqual(fake.calls[3].args, ["inspect", "--format", "{{.State.ExitCode}}", containerId]);
  assert.deepEqual(fake.calls[4].args, ["rm", "--force", containerId]);
  for (const { args, options } of fake.calls) {
    assert.deepEqual(options, {
      env: { PATH: environment.PATH, DOCKER_CONFIG: fake.calls[0].options.env.DOCKER_CONFIG, DOCKER_HOST: environment.DOCKER_HOST },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: args[0] === "start" ? 60_000 : args[0] === "rm" ? 15_000 : 30_000,
      killSignal: "SIGKILL", maxBuffer: args[0] === "rm" ? 64 * 1024 : 1024 * 1024,
    });
  }
  assertTemporaryConfigRemoved(fake.calls);
});

for (const [name, overrides, expected, commands] of [
  ["missing Docker executable", { image: { status: null, error: { code: "ENOENT" } } }, /docker_image_failed/u, ["image"]],
  ["missing image", { image: { status: 1, stderr: "synthetic-private-diagnostic" } }, /docker_image_failed/u, ["image"]],
  ["empty inspection", { image: { status: 0, stdout: "[]" } }, /expected_one_controller_image/u, ["image"]],
  ["multiple image inspection", { image: { status: 0, stdout: JSON.stringify([image(), image()]) } }, /expected_one_controller_image/u, ["image"]],
  ["wrong image identity", { image: { status: 0, stdout: JSON.stringify([{ ...image(), Architecture: "arm64" }]) } }, /controller_image_identity_mismatch/u, ["image"]],
  ["failed create", { create: { status: 1, stdout: containerId } }, /docker_create_failed/u, ["image", "create"]],
  ["invalid created ID", { create: { status: 0, stdout: "unowned-container-name" } }, /invalid_created_container_id/u, ["image", "create"]],
  ["Docker start failure", { start: { status: 1, stderr: "synthetic-private-diagnostic" } }, /docker_start_failed/u, ["image", "create", "start", "rm"]],
  ["Docker start timeout", { start: { status: null, error: { code: "ETIMEDOUT" } } }, /docker_start_failed/u, ["image", "create", "start", "rm"]],
  ["Docker output limit", { start: { status: null, error: { code: "ENOBUFS" } } }, /docker_start_failed/u, ["image", "create", "start", "rm"]],
  ["empty report", { start: { status: 0, stdout: "{}" } }, /controller_startup_report_failed/u, ["image", "create", "start", "inspect", "rm"]],
  ["skipped report", { start: { status: 0, stdout: JSON.stringify({ ...report(), skipped: true }) } }, /controller_startup_report_failed/u, ["image", "create", "start", "inspect", "rm"]],
  ["nonzero container exit", { inspect: { status: 0, stdout: "1\n" } }, /controller_startup_container_failed/u, ["image", "create", "start", "inspect", "rm"]],
  ["exit inspection failure", { inspect: { status: 1 } }, /docker_inspect_failed/u, ["image", "create", "start", "inspect", "rm"]],
  ["failed owned cleanup", { rm: { status: 1 } }, /owned_container_cleanup_failed/u, ["image", "create", "start", "inspect", "rm"]],
]) {
  test(`fails closed on ${name} and bounds owned cleanup`, (t) => {
    const fake = dockerFake(overrides);
    assert.throws(() => runSmoke(record(), commit, harnessFixture(t), { environment, execute: fake.execute }), expected);
    assert.deepEqual(fake.calls.map(({ args }) => args[0]), commands);
    const cleanup = fake.calls.filter(({ args }) => args[0] === "rm");
    assert.ok(cleanup.length <= 1);
    for (const call of cleanup) assert.deepEqual(call.args, ["rm", "--force", containerId]);
    assertTemporaryConfigRemoved(fake.calls);
  });
}

test("malformed report output still removes the owned container", (t) => {
  const fake = dockerFake({ start: { status: 0, stdout: "not JSON" } });
  assert.throws(() => runSmoke(record(), commit, harnessFixture(t), { environment, execute: fake.execute }), SyntaxError);
  assert.deepEqual(fake.calls.at(-1).args, ["rm", "--force", containerId]);
  assertTemporaryConfigRemoved(fake.calls);
});

test("refuses invalid records and unsafe or missing fixtures before invoking Docker", (t) => {
  const harness = harnessFixture(t);
  const execute = () => assert.fail("Docker must not run for invalid input");
  assert.throws(() => runSmoke({ ...record(), coreCommit: "e".repeat(40) }, commit, harness, { execute }), /invalid_controller_image_record/u);
  assert.throws(() => runSmoke(record(), commit, `${harness}.absent`, { execute }), { code: "ENOENT" });
  assert.throws(() => runSmoke(record(), commit, path.dirname(harness), { execute }), /harness_not_executable/u);
  fs.chmodSync(harness, 0o600);
  assert.throws(() => runSmoke(record(), commit, harness, { execute }), /harness_not_executable/u);
  for (const basename of ["fixture,readonly=false", "fixture\nother"]) {
    assert.throws(() => runSmoke(record(), commit, harnessFixture(t, basename), { execute }), /unsupported_harness_mount_path/u);
  }
});
