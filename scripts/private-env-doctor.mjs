#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditPrivateEnvLayout,
  INSTAFY_ENV_DIR_VARIABLE,
} from "./lib/privateEnvPaths.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = auditPrivateEnvLayout({ repoRoot });
  console.log(`[private-env] ${INSTAFY_ENV_DIR_VARIABLE} is configured outside the repository.`);
  console.log(`[${result.root.ok ? "PASS" : "FAIL"}] external root: ${result.root.reason}`);
  for (const entry of result.files) {
    console.log(
      `[${entry.external.ok ? "PASS" : "FAIL"}] ${entry.relativePath}: ${entry.external.reason}`,
    );
    console.log(
      `[${entry.legacyPresent ? "FAIL" : "PASS"}] ${entry.relativePath}: ${
        entry.legacyPresent ? "legacy in-repository copy is still present" : "no in-repository copy"
      }`,
    );
  }
  console.log(`[private-env] RESULT: ${result.ok ? "PASS" : "FAIL"}`);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(`[private-env] RESULT: FAIL (${error?.message ?? error})`);
  process.exitCode = 1;
}
