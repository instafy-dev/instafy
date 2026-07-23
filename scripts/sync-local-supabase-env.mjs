#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseAnonKey,
  resolveLocalSupabaseApiUrl,
  resolveLocalSupabaseServiceRoleKey,
} from "./lib/localSupabaseEnv.mjs";
import {
  resolvePrivateEnvPath,
  writePrivateEnvFileSync,
} from "./lib/privateEnvPaths.mjs";

const repoRoot = path.resolve(path.join(import.meta.url.replace("file://", ""), "..", ".."));
const outputPath = resolvePrivateEnvPath({
  repoRoot,
  relativePath: ".env.supabase.local",
});

function writeEnvFile(filePath, values) {
  const lines = [
    "# Auto-generated from `supabase status --output env` (local dev only).",
    "# This file is gitignored; do not commit.",
    "",
    `VITE_SUPABASE_URL=${values.apiUrl}`,
    `VITE_SUPABASE_ANON_KEY=${values.anonKey}`,
    "",
    `SUPABASE_PROJECT_URL=${values.apiUrl}`,
    `SUPABASE_SERVICE_ROLE_KEY=${values.serviceRoleKey}`,
    ...(values.jwtSecret ? [`SUPABASE_JWT_SECRET=${values.jwtSecret}`] : []),
    "",
    `SERVICE_ROLE_KEY=${values.serviceRoleKey}`,
    "",
  ];
  const writtenPath = writePrivateEnvFileSync({
    repoRoot,
    relativePath: ".env.supabase.local",
    data: `${lines.join("\n")}\n`,
    encoding: "utf-8",
  });
  if (writtenPath !== filePath) {
    throw new Error("private env path changed between resolution and write");
  }
}

try {
  const env = readLocalSupabaseStatusEnv({ cwd: repoRoot, required: true });
  const apiUrl = resolveLocalSupabaseApiUrl({ statusEnv: env });
  const anonKey = resolveLocalSupabaseAnonKey({ statusEnv: env });
  const serviceRoleKey = resolveLocalSupabaseServiceRoleKey({ statusEnv: env });
  const jwtSecret = (env.JWT_SECRET || "").trim();

  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      `Supabase status did not include required keys (API_URL/ANON_KEY/SERVICE_ROLE_KEY).`
    );
  }

  writeEnvFile(outputPath, { apiUrl, anonKey, serviceRoleKey, jwtSecret: jwtSecret || null });

  spawnSync("node", ["scripts/set-local-frontend-env.mjs"], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  console.log("[sync:supabase-local] wrote .env.supabase.local");
  console.log(`[sync:supabase-local] VITE_SUPABASE_URL=${apiUrl}`);
  console.log("[sync:supabase-local] VITE_SUPABASE_ANON_KEY=<hidden>");
  console.log("[sync:supabase-local] SUPABASE_SERVICE_ROLE_KEY=<hidden>");
} catch (error) {
  console.error(`[sync:supabase-local] ${error?.message || error}`);
  process.exit(1);
}
