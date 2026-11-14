#!/usr/bin/env node
// Run the packaged controller, never a host binary, against an inert in-container
// Auth fixture. Registry acquisition is separate; this runner has no credentials.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = "ghcr.io/instafy-dev/instafy-runtime-controller";
const scope = "isolated_controller_startup_before_database_io";
const expectedCases = [
  ["existing_user_lookup", { jwks: 1, lookup: 1, create: 0 }],
  ["missing_user_creation", { jwks: 1, lookup: 1, create: 1 }],
  ["explicit_uuid_bypass", { jwks: 1, lookup: 0, create: 0 }],
];

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

export function validateRecord(record, commit) {
  requireCondition(
    /^[0-9a-f]{40}$/u.test(commit) && record?.schemaVersion === 1 &&
      record.key === "controller" && record.coreCommit === commit &&
      record.platform === "linux/amd64" &&
      record.releaseTag === `${repository}:${commit}` &&
      typeof record.ref === "string" && record.ref.startsWith(`${repository}@`) &&
      /^sha256:[0-9a-f]{64}$/u.test(record.ref.slice(repository.length + 1)),
    "invalid_controller_image_record",
  );
  return record.ref;
}

export function validateImage(image, record, commit) {
  requireCondition(
    image?.Os === "linux" && image.Architecture === "amd64" &&
      /^sha256:[0-9a-f]{64}$/u.test(image.Id) &&
      Array.isArray(image.RepoDigests) && image.RepoDigests.includes(record.ref) &&
      image.Config?.Labels?.["org.opencontainers.image.revision"] === commit &&
      image.Config?.Labels?.["org.opencontainers.image.source"] ===
        "https://github.com/instafy-dev/instafy" &&
      JSON.stringify(image.Config.Entrypoint) ===
        JSON.stringify(["/usr/local/bin/runtime-controller"]) &&
      Object.keys(image.Config.Volumes ?? {}).length === 0,
    "controller_image_identity_mismatch",
  );
  return image.Id;
}

export function validateReport(report) {
  requireCondition(
    report?.schemaVersion === 1 && report.passed === true &&
      report.scope === scope && report.failure === undefined &&
      Object.keys(report).every((key) => ["schemaVersion", "passed", "scope", "cases"].includes(key)) &&
      Array.isArray(report.cases) && report.cases.length === expectedCases.length,
    "controller_startup_report_failed",
  );
  // Reconstruct the receipt from fixed fields: never retain arbitrary child text.
  return expectedCases.map(([name, requests], index) => {
    const item = report.cases[index];
    requireCondition(
      item?.name === name && item.passed === true && item.exitCode === 1 &&
        Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 &&
        item.durationMs <= 60_000 &&
        (item.failures === undefined || (Array.isArray(item.failures) && item.failures.length === 0)) &&
        Object.keys(item).every((key) => ["name", "passed", "exitCode", "durationMs", "requests", "failures"].includes(key)) &&
        Object.keys(item.requests ?? {}).length === 3 &&
        Object.entries(requests).every(([key, value]) => item.requests?.[key] === value),
      "controller_startup_case_failed",
    );
    return { name, passed: true, exitCode: 1, durationMs: item.durationMs, requests };
  });
}

export function dockerEnvironment(configDirectory, environment = process.env) {
  const result = { PATH: environment.PATH, DOCKER_CONFIG: configDirectory };
  if (environment.DOCKER_HOST) {
    requireCondition(
      /^unix:\/\/\/[^\r\n]+$/u.test(environment.DOCKER_HOST),
      "only_local_unix_docker_hosts_are_supported",
    );
    result.DOCKER_HOST = environment.DOCKER_HOST;
  }
  return result;
}

export function containerArguments(imageRef, harness, name) {
  return [
    "create", "--name", name, "--platform", "linux/amd64", "--pull", "never",
    "--network", "none", "--read-only", "--user", "65532:65532",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "128", "--memory", "512m", "--memory-swap", "512m",
    "--cpus", "2", "--stop-timeout", "5",
    "--mount", `type=bind,src=${harness},dst=/fixture/startup-smoke,readonly`,
    "--entrypoint", "/fixture/startup-smoke", imageRef,
    "/usr/local/bin/runtime-controller",
  ];
}

export function runSmoke(record, commit, harnessPath, {
  environment = process.env,
  execute = spawnSync,
} = {}) {
  const ref = validateRecord(record, commit);
  const harness = fs.realpathSync(harnessPath);
  requireCondition(!/[\r\n,]/u.test(harness), "unsupported_harness_mount_path");
  const info = fs.statSync(harness);
  requireCondition(info.isFile() && (info.mode & 0o111) !== 0, "harness_not_executable");
  const harnessSha256 = createHash("sha256").update(fs.readFileSync(harness)).digest("hex");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "controller-image-smoke-"));
  let containerId;
  try {
    const env = dockerEnvironment(temporary, environment);
    const docker = (args, timeout = 30_000) => {
      const result = execute("docker", args, {
        env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      });
      requireCondition(!result.error && result.status === 0, `docker_${args[0]}_failed`);
      return result.stdout;
    };
    const images = JSON.parse(docker(["image", "inspect", ref]));
    requireCondition(Array.isArray(images) && images.length === 1, "expected_one_controller_image");
    const imageId = validateImage(images[0], record, commit);
    const created = docker(containerArguments(ref, harness, `controller-startup-${randomUUID()}`)).trim();
    requireCondition(/^[0-9a-f]{64}$/u.test(created), "invalid_created_container_id");
    containerId = created;
    // The harness has three 15-second child deadlines. Bound Docker itself too.
    const report = JSON.parse(docker(["start", "--attach", containerId], 60_000));
    const exit = docker(["inspect", "--format", "{{.State.ExitCode}}", containerId]).trim();
    requireCondition(exit === "0", "controller_startup_container_failed");
    const cases = validateReport(report);
    return { schemaVersion: 1, passed: true, scope, coreCommit: commit, ref, imageId,
      platform: "linux/amd64", harnessSha256, cases };
  } finally {
    try {
      if (containerId) {
        // Only the exact ID returned by our successful create is eligible for cleanup.
        const result = execute("docker", ["rm", "--force", containerId], {
          env: dockerEnvironment(temporary, environment), encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
          killSignal: "SIGKILL", maxBuffer: 64 * 1024,
        });
        requireCondition(!result.error && result.status === 0, "owned_container_cleanup_failed");
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [recordPath, commit, harness, output, ...extra] = process.argv.slice(2);
  if (!recordPath || !commit || !harness || !output || extra.length) {
    console.error("Usage: controller-image-smoke.mjs <controller.json> <commit> <harness> <receipt.json>");
    process.exitCode = 1;
  } else {
    let receipt;
    try {
      receipt = runSmoke(JSON.parse(fs.readFileSync(recordPath, "utf8")), commit, harness);
    } catch (error) {
      const failure = /^[a-z_]+$/u.test(error.message) ? error.message : "controller_image_smoke_failed";
      receipt = { schemaVersion: 1, passed: false, scope, failure };
      process.exitCode = 1;
    }
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(receipt));
  }
}
