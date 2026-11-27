#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseDbUrl,
} from "./lib/localSupabaseEnv.mjs";
import { LOCAL_SUPABASE_PROJECT_DIR, localSupabasePorts } from "./lib/localSupabasePorts.mjs";
import { readSupabaseProjectId } from "./lib/supabaseEmailTemplateMounts.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  const code = result.status ?? result.code ?? 1;
  if (code !== 0) {
    const detail = result.error ? ` (${result.error.message})` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${code}${detail}`);
  }
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error && (result.status ?? 1) === 0;
}

function escapeSqlLiteral(value) {
  return value.replace(/'/g, "''");
}

function resolveDbUrl() {
  const dbUrl = resolveLocalSupabaseDbUrl({
    env: process.env,
    statusEnv: readLocalSupabaseStatusEnv({ required: true }),
  });
  if (!dbUrl) {
    throw new Error("supabase status output did not include DB_URL");
  }
  return dbUrl;
}

// Without psql the SQL runs inside the database container. The Supabase CLI names it
// supabase_db_<project_id>, and it is this checkout's database only when dbUrl uses the config's
// [db] port, so another stack's database is never written through it.
function localDbContainer(dbUrl) {
  const explicit = (process.env.SUPABASE_DB_CONTAINER || "").trim();
  if (explicit) return explicit;
  const { dbPort } = localSupabasePorts();
  let urlPort = "";
  try {
    urlPort = new URL(dbUrl).port || "5432";
  } catch {}
  if (urlPort !== String(dbPort)) {
    throw new Error(
      `psql is not installed, and the database URL is not this checkout's Supabase database (port ${dbPort} in supabase/supabase/config.toml). Install psql or set SUPABASE_DB_CONTAINER.`,
    );
  }
  return `supabase_db_${readSupabaseProjectId(LOCAL_SUPABASE_PROJECT_DIR)}`;
}

function runSql(dbUrl, sql) {
  if (commandExists("psql")) {
    run("psql", ["-d", dbUrl, "-v", "ON_ERROR_STOP=1", "-c", sql]);
    return;
  }

  const container = localDbContainer(dbUrl);
  run("docker", [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
}

function buildDefaultProviderSql() {
  const endpoint = (process.env.DEV_PROVIDER_ENDPOINT || "").trim();
  const token = (process.env.DEV_PROVIDER_AUTH_TOKEN || "dev-provider-token").trim();

  if (endpoint) {
    const endpointSql = escapeSqlLiteral(endpoint);
    const tokenSql = escapeSqlLiteral(token);
    return [
      `insert into runtime_providers (id, display_name, kind, endpoint, auth_token) values ('runtime','Local Provider','external_http','${endpointSql}','${tokenSql}') on conflict (id) do update set endpoint = excluded.endpoint, auth_token = excluded.auth_token, kind = excluded.kind;`,
      `insert into runtime_providers (id, display_name, kind, endpoint, auth_token) values ('instafy-cloud','Instafy Cloud (local)','external_http','${endpointSql}','${tokenSql}') on conflict (id) do update set endpoint = excluded.endpoint, auth_token = excluded.auth_token, kind = excluded.kind;`,
      `insert into runtime_providers (id, display_name, kind, endpoint, auth_token) values ('self-hosted','Self-hosted Provider','external_http','${endpointSql}','${tokenSql}') on conflict (id) do update set endpoint = excluded.endpoint, auth_token = excluded.auth_token, kind = excluded.kind;`,
    ].join("\n");
  }

  return [
    "insert into runtime_providers (id, display_name, kind) values ('runtime','Local Docker','docker') on conflict (id) do nothing;",
    "insert into runtime_providers (id, display_name, kind) values ('instafy-cloud','Instafy Cloud (local)','docker') on conflict (id) do nothing;",
    "insert into runtime_providers (id, display_name, kind) values ('self-hosted','Self-hosted Docker','docker') on conflict (id) do nothing;",
  ].join("\n");
}

function buildHetznerProviderSql() {
  const raw = (process.env.HETZNER_PROVIDER_METADATA || "{}").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `HETZNER_PROVIDER_METADATA must be valid JSON (got ${raw.slice(0, 200)}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const normalized = JSON.stringify(parsed);
  const normalizedSql = escapeSqlLiteral(normalized);

  const endpoint = (process.env.HETZNER_PROVIDER_ENDPOINT || "").trim();
  const authToken = (process.env.HETZNER_PROVIDER_AUTH_TOKEN || "").trim();

  const endpointSql = endpoint ? `'${escapeSqlLiteral(endpoint)}'` : "null";
  const authTokenSql = authToken ? `'${escapeSqlLiteral(authToken)}'` : "null";

  return `insert into runtime_providers (id, display_name, kind, endpoint, auth_token, metadata)
values ('hetzner','Hetzner Cloud','hetzner', ${endpointSql}, ${authTokenSql}, coalesce(nullif('${normalizedSql}',''), '{}')::jsonb)
on conflict (id) do update set
  display_name = excluded.display_name,
  kind = excluded.kind,
  endpoint = coalesce(excluded.endpoint, runtime_providers.endpoint),
  auth_token = coalesce(excluded.auth_token, runtime_providers.auth_token),
  metadata = excluded.metadata;`;
}

function printUsage() {
  console.log("Usage: node scripts/providers-seed.mjs <default|hetzner>");
}

async function main() {
  const [command] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    process.exitCode = command ? 0 : 1;
    return;
  }

  const dbUrl = resolveDbUrl();
  if (command === "default") {
    runSql(dbUrl, buildDefaultProviderSql());
    return;
  }
  if (command === "hetzner") {
    runSql(dbUrl, buildHetznerProviderSql());
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[providers-seed] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
