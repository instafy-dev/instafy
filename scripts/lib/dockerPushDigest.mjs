#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DOCKER_PUSH_DIGEST_LINE =
  /^(?:\S+: )?digest: (sha256:[0-9a-f]{64}) size: [0-9]+$/;

export function extractDockerPushDigest(output) {
  if (typeof output !== "string") {
    throw new TypeError("Docker push output must be a string.");
  }

  const matches = output
    .split(/\r?\n/u)
    .map((line) => DOCKER_PUSH_DIGEST_LINE.exec(line)?.[1])
    .filter(Boolean);

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Docker push digest line; found ${matches.length}.`,
    );
  }
  return matches[0];
}

function main() {
  if (process.argv.length !== 3) {
    throw new Error("Usage: dockerPushDigest.mjs <docker-push-log>");
  }
  const logPath = path.resolve(process.argv[2]);
  const output = fs.readFileSync(logPath, "utf8");
  process.stdout.write(`${extractDockerPushDigest(output)}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(
      `[docker-push-digest] ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}
