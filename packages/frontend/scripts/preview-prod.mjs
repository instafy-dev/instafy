#!/usr/bin/env node
/**
 * Build + serve the frontend using production-ish config.
 *
 * - Uses the same production-ish env resolution as `dev:prod`.
 * - Defaults to hosted Supabase/controller unless env overrides are set.
 * - Runs `tsc --noEmit && vite build` then `vite preview`.
 *
 * This is closer to a real production deploy than `dev:prod` because it serves
 * the built assets.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasCliFlag, resolveFrontendProdEnv } from "./prod-env.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendDir, "..", "..");

const { env, supabaseSource } = await resolveFrontendProdEnv({
  frontendDir,
  repoRoot,
  logPrefix: "preview:prod",
});

console.log(
  `[preview:prod] Building local production preview with ${supabaseSource === "local" ? "local" : "hosted"} Supabase config.`,
);

const build = spawnSync("pnpm", ["run", "build"], {
  cwd: frontendDir,
  env,
  stdio: "inherit",
  encoding: "utf-8",
});
if ((build.status ?? 1) !== 0) {
  process.exit(build.status ?? 1);
}

const previewArgs = ["exec", "vite", "preview"];
const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
previewArgs.push(...cliArgs);
if (!hasCliFlag(cliArgs, "--host")) {
  previewArgs.push("--host", process.env.VITE_HOST || "127.0.0.1");
}
if (!hasCliFlag(cliArgs, "--port")) {
  previewArgs.push("--port", process.env.VITE_PREVIEW_PORT || "4173");
}

const preview = spawnSync("pnpm", previewArgs, {
  cwd: frontendDir,
  env,
  stdio: "inherit",
  encoding: "utf-8",
});
process.exit(preview.status ?? 0);
