#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TMP_DIR = path.join(REPO_ROOT, "tmp", "ios-automation-probe");
const DEFAULT_TEST_SELECTOR = "AppUITests/AppUITests/testCaptureAutomationProbe";

function usage() {
  console.log(
    [
      "Usage: node scripts/ios-automation-probe.mjs [--udid <udid>] [--team <team>] [--json]",
      "",
      "Runs a lightweight physical-iPhone XCTest probe before heavier camera/voice smokes.",
      "The probe caches DerivedData under tmp/ios-automation-probe so repeated retries are cheaper.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    udid: "",
    team: "",
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--udid" && argv[index + 1]) {
      options.udid = argv[++index].trim();
      continue;
    }
    if (arg === "--team" && argv[index + 1]) {
      options.team = argv[++index].trim();
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function runStreaming(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${
            signal ? `signal ${signal}` : `code ${code ?? 1}`
          }`,
        ),
      );
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const suffix = options.udid || "default-device";
  const derivedDataPath = path.join(TMP_DIR, `derived-data-${suffix}`);
  const resultBundlePath = path.join(TMP_DIR, `automation-probe-${suffix}.xcresult`);
  const attachmentsPath = path.join(TMP_DIR, `automation-probe-attachments-${suffix}`);

  const args = [
    "scripts/ios-device-debug.mjs",
    "capture",
    "--",
    "--test",
    DEFAULT_TEST_SELECTOR,
    "--derived-data-path",
    derivedDataPath,
    "--result-bundle-path",
    resultBundlePath,
    "--attachments-path",
    attachmentsPath,
  ];
  if (options.udid) {
    args.push("--udid", options.udid);
  }
  if (options.team) {
    args.push("--team", options.team);
  }
  if (options.json) {
    args.push("--json");
  }

  await runStreaming(process.execPath, args);
}

main().catch((error) => {
  console.error(
    `[ios-automation-probe] ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exit(1);
});
