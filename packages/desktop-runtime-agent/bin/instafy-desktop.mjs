#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledCliPath = path.join(packageRoot, "dist", "cli.js");

if (!fs.existsSync(compiledCliPath)) {
  console.error(
    [
      "instafy-desktop is not built yet.",
      "Run `pnpm --filter @instafy/desktop-runtime-agent build` before invoking this CLI in the workspace.",
    ].join(" "),
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [compiledCliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}
