#!/usr/bin/env node
/**
 * Frontend dev server with production-ish config.
 *
 * - Forces Vite mode to "production" so `import.meta.env.PROD === true`.
 * - Loads VITE_* values from `packages/frontend/.env` (committed) unless the
 *   variable is already set in the shell.
 * - Injects Supabase envs from `.env.supabase` under `INSTAFY_ENV_DIR` (or the
 *   legacy repo-level fallback) by default so local
 *   `.env.local` contents do not need manual switching for prod-mode runs.
 * - If the configured anon key is stale, it can auto-refresh from the live
 *   public bundle (without mutating local files).
 *
 * Notes:
 * - Vite always loads `.env.local`; we intentionally override it by setting
 *   explicit env vars in the process environment.
 * - Set `VITE_CONTROLLER_URL` in your shell if you don't want the default.
 * - Set `DEV_PROD_SUPABASE_SOURCE=local` to force the external
 *   `.env.supabase.local`.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasCliFlag, resolveFrontendProdEnv } from "./prod-env.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendDir, "..", "..");

const { env } = await resolveFrontendProdEnv({ frontendDir, repoRoot, logPrefix: "dev:prod" });

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const args = ["exec", "vite", "--mode", "production", ...cliArgs];

const hasHost = hasCliFlag(cliArgs, "--host");
const hasPort = hasCliFlag(cliArgs, "--port");
if (!hasHost) {
  args.push("--host", process.env.VITE_HOST || "127.0.0.1");
}
if (!hasPort) {
  args.push("--port", process.env.VITE_PORT || "5173");
}

const child = spawn("pnpm", args, {
  cwd: frontendDir,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
