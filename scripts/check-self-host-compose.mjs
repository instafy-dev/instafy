#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..");
const COMPOSE_FILE = path.join("docker", "docker-compose.runtime.yml");
const EXAMPLE_ENV_FILE = path.join("docker", ".env.example");
const EXPECTED_SERVICES = [
  "git-edge",
  "git-shard-0",
  "origin-gateway",
  "proxy",
  "redis",
  "runtime",
];

function checkSelfHostCompose({ dockerCommand = "docker" } = {}) {
  const version = spawnSync(dockerCommand, ["compose", "version"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (version.error || version.status !== 0) {
    throw new Error("Docker Compose v2 is unavailable");
  }

  const isolatedEnvRoot = mkdtempSync(
    path.join(os.tmpdir(), "instafy-compose-example-"),
  );
  mkdirSync(path.join(isolatedEnvRoot, "docker"), { mode: 0o700 });
  copyFileSync(
    path.join(REPO_ROOT, EXAMPLE_ENV_FILE),
    path.join(isolatedEnvRoot, "docker", ".env.local"),
  );
  let result;
  try {
    result = spawnSync(
      dockerCommand,
      [
        "compose",
        "--env-file",
        EXAMPLE_ENV_FILE,
        "--file",
        COMPOSE_FILE,
        "config",
        "--format",
        "json",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          INSTAFY_ENV_DIR: isolatedEnvRoot,
        },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      },
    );
  } finally {
    rmSync(isolatedEnvRoot, { force: true, recursive: true });
  }
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "")
      .trim()
      .slice(-4_000);
    throw new Error(`example-only Compose config failed${detail ? `: ${detail}` : ""}`);
  }

  let config;
  try {
    config = JSON.parse(result.stdout);
  } catch {
    throw new Error("Docker Compose returned malformed JSON");
  }
  const serviceNames = Object.keys(config?.services ?? {}).sort();
  for (const service of EXPECTED_SERVICES) {
    if (!serviceNames.includes(service)) {
      throw new Error(`Compose config is missing required service ${service}`);
    }
  }
  if (serviceNames.length !== EXPECTED_SERVICES.length) {
    throw new Error(
      `Compose config contains unexpected services: ${serviceNames
        .filter((service) => !EXPECTED_SERVICES.includes(service))
        .join(", ")}`,
    );
  }

  const runtime = config.services.runtime;
  if (
    runtime?.image !== "instafy-runtime-agent:webdev-local" ||
    runtime?.build?.target !== "runtime-webdev"
  ) {
    throw new Error("local runtime must build the reviewed webdev target with a local image tag");
  }
  if (
    runtime?.environment?.PROXY_CREDENTIAL_LEASE_TOKEN !== "" ||
    runtime?.environment?.PROXY_SIGNING_SECRET !== "" ||
    runtime?.environment?.ORIGIN_ACCESS_TOKEN !== ""
  ) {
    throw new Error("runtime Compose config exposes a proxy/origin credential");
  }
  if (JSON.stringify(config).includes("${")) {
    throw new Error("Compose config contains an unresolved interpolation");
  }

  console.log(
    `SELF-HOST COMPOSE: PASS (${serviceNames.length} services, example env only)`,
  );
  return config;
}

function main() {
  if (process.argv.length !== 2) {
    throw new Error("check-self-host-compose.mjs does not accept arguments");
  }
  checkSelfHostCompose();
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? `Self-host Compose validation failed: ${error.message}`
        : "Self-host Compose validation failed",
    );
    process.exitCode = 1;
  }
}

export {
  COMPOSE_FILE,
  EXAMPLE_ENV_FILE,
  EXPECTED_SERVICES,
  checkSelfHostCompose,
};
