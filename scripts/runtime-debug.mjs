#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const composeFile = path.join(repoRoot, "docker", "docker-compose.runtime.yml");

function runSection(title, command, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const env = { ...process.env, ...(options.env ?? {}) };

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`▶ ${title}`);
  console.log(`Command: ${command.join(" ")}`);

  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8"
  });

  if (result.stdout?.trim()) {
    console.log(result.stdout.trim());
  }
  if (result.stderr?.trim()) {
    console.log(result.stderr.trim());
  }
  if (result.error) {
    console.log(`(failed to execute: ${result.error.message})`);
  }
  if ((result.status ?? result.code ?? 0) !== 0 && !result.error) {
    console.log(`(exit code ${(result.status ?? result.code)})`);
  }
}

console.log("Runtime debug helper — collecting stack diagnostics...\n");

runSection("Runtime status", ["pnpm", "runtime:status"]);
runSection("Docker compose ps", ["docker", "compose", "-f", composeFile, "ps"]);
runSection("Docker compose recent logs", ["docker", "compose", "-f", composeFile, "logs", "--tail", "120", "runtime"]);
runSection("Supabase status", ["supabase", "status", "--output", "env"]);
runSection("Open ports (54321 / 8788)", ["lsof", "-i", ":54321"]);
runSection("Open ports (54321 / 8788)", ["lsof", "-i", ":8788"]);
runSection("Controller process", ["pgrep", "-fl", "runtime-controller"]);

console.log("\nDebug summary complete. If you need additional context, rerun with KEEP_RUNTIME_STACK=1 and inspect the controller output directly.\n");
