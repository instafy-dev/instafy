#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const composeFile = path.resolve("docker", "docker-compose.runtime.yml");

function ensureFileExists(file) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `compose file not found at ${file}. Run \`pnpm stack:up\` once to generate the stack.`
    );
  }
}

function checkRuntimeService() {
  const result = spawnSync(
    "docker",
    ["compose", "-f", composeFile, "ps", "--status", "running", "runtime"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    }
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "runtime service not running";
    throw new Error(stderr);
  }

  const output = result.stdout ?? "";
  if (!/runtime\s+running/i.test(output)) {
    throw new Error("runtime container is not running");
  }
}

try {
  ensureFileExists(composeFile);
  checkRuntimeService();
  console.log("✔ Runtime container is running (docker compose runtime).");
  process.exit(0);
} catch (error) {
  console.error(`✖ Runtime check failed: ${error.message ?? error}`);
  console.error("Hint: run `pnpm stack:up` to build and start the runtime stack.");
  process.exit(1);
}
