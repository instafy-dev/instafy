import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { primeProcessEnvFromLocalSupabase } from "./lib/localSupabaseEnv.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function normalizeArgs(rawArgs) {
  if (rawArgs.length > 0 && rawArgs[0] === "--") {
    return rawArgs.slice(1);
  }
  return rawArgs;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node scripts/test-e2e-supabase.mjs [-- <playwright args...>]",
      "",
      "Behavior:",
      "  - resets the local Supabase database",
      "  - primes local Supabase env for frontend Playwright runs",
      "  - delegates to node scripts/test-e2e.mjs run -- <args>",
    ].join("\n"),
  );
}

function runCommand(command, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(typeof code === "number" ? code : 1));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const args = normalizeArgs(process.argv.slice(2));
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const resetArgs = [
    "exec",
    "supabase",
    "--workdir",
    "supabase",
    "db",
    "reset",
    "--local",
    "--yes",
  ];
  let resetCode = await runCommand("pnpm", resetArgs);
  if (resetCode !== 0) {
    console.warn("[test:e2e:supabase] Local Supabase reset failed; recycling the local stack and retrying once.");
    await runCommand("pnpm", ["supabase:down"]);
    const upCode = await runCommand("pnpm", ["supabase:up"]);
    if (upCode !== 0) {
      process.exit(upCode);
    }
    resetCode = await runCommand("pnpm", resetArgs);
    if (resetCode !== 0) {
      process.exit(resetCode);
    }
  }

  primeProcessEnvFromLocalSupabase(process.env, {
    cwd: repoRoot,
    fillApiUrl: true,
    fillAnonKey: true,
    fillServiceRole: true,
    required: true,
  });

  const delegateCode = await runCommand(process.execPath, [
    path.join(repoRoot, "scripts", "test-e2e.mjs"),
    "run",
    "--",
    ...args,
  ]);
  process.exit(delegateCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
