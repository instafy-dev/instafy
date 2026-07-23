import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePrivateEnvPath } from "./lib/privateEnvPaths.mjs";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendProductionEnvPath = resolvePrivateEnvPath({
  repoRoot,
  relativePath: "packages/frontend/.env.production.local",
});

function readFrontendProductionEnv() {
  let content;
  try {
    content = fs.readFileSync(frontendProductionEnvPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!key.startsWith("VITE_")) continue;
    if (key.toUpperCase().includes("SERVICE_ROLE")) {
      throw new Error(
        `${frontendProductionEnvPath} contains a forbidden client-visible service-role variable`,
      );
    }
    values[key] = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"](.+)['"]$/, "$1");
  }
  return values;
}

function createChildEnv() {
  const env = { ...readFrontendProductionEnv(), ...process.env };
  env.BROWSERSLIST_IGNORE_OLD_DATA = env.BROWSERSLIST_IGNORE_OLD_DATA ?? "1";
  env.BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA =
    env.BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA ?? "1";
  delete env.NO_COLOR;
  return env;
}

async function runStep(args) {
  const exitCode = await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: createChildEnv(),
    });

    child.on("error", () => {
      resolve(1);
    });

    child.on("exit", (code) => {
      resolve(typeof code === "number" ? code : 1);
    });
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

await runStep(["exec", "tsc", "--noEmit"]);
await runStep(["exec", "vite", "build"]);
