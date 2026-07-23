#!/usr/bin/env node

/**
 * Live infra test runner (developer convenience).
 *
 * Default behaviour targets local infra:
 * - Starts the local tunnel-broker ingress stack (docker compose).
 * - Starts the local Supabase + controller stack (`pnpm stack:up`) with tunnel broker env wired.
 * - Runs the Instafy CLI live tunnel smoke.
 *
 * You can also target an existing controller by setting CONTROLLER_URL and skipping bring-up:
 *   LIVE_TARGET=remote CONTROLLER_URL=... CONTROLLER_TOKEN=... SPACE_ID=... pnpm test:live
 */

import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  const code = typeof result.status === "number" ? result.status : 1;
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${code}`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });
  const code = typeof result.status === "number" ? result.status : 1;
  if (code !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || `exit ${code}`}`);
  }
  return (result.stdout ?? "").toString();
}

function parseEnvLines(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

function isTruthy(value) {
  return value && value.trim() && value.trim() !== "0" && value.trim().toLowerCase() !== "false";
}

function main() {
  const target = (process.env.LIVE_TARGET || "local").trim().toLowerCase();
  const keepUp = isTruthy(process.env.LIVE_KEEP_UP || "");

  if (target === "local") {
    // Bring up tunnel-broker ingress (broker + rathole + traefik) on localhost.
    process.env.INGRESS_HOST = process.env.INGRESS_HOST || "127.0.0.1";
    process.env.RATHOLE_CONFIG_REFRESH_SECONDS =
      process.env.RATHOLE_CONFIG_REFRESH_SECONDS || "1";
    run("pnpm", ["-C", "packages/tunnel-broker", "ingress:up:build"]);

    // Wire controller -> broker.
    process.env.TUNNEL_BROKER_BASE_URL = process.env.TUNNEL_BROKER_BASE_URL || "http://127.0.0.1:8082";
    process.env.TUNNEL_BROKER_TOKEN = process.env.TUNNEL_BROKER_TOKEN || "dev-token";

    // Bring up Supabase + controller/proxy/provider stack.
    run("pnpm", ["stack:up"]);

    // Resolve Supabase URLs/keys from the running local stack.
    const status = capture("pnpm", ["exec", "supabase", "--workdir", "supabase", "status", "--output", "env"]);
    const env = parseEnvLines(status);
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || env.API_URL || env.SUPABASE_URL;
    process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || env.ANON_KEY || env.SUPABASE_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY || env.SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

    // Controller URL for local stack.
    process.env.CONTROLLER_URL = process.env.CONTROLLER_URL || "http://127.0.0.1:8788";

    // Help the test bypass local DNS (.rt.test).
    process.env.TUNNEL_INGRESS_IP = process.env.TUNNEL_INGRESS_IP || "127.0.0.1";

    process.env.TUNNEL_E2E_LIVE = "1";
  } else if (target === "remote") {
    process.env.TUNNEL_E2E_LIVE = process.env.TUNNEL_E2E_LIVE || "1";
  } else {
    throw new Error(`Unknown LIVE_TARGET=${target} (expected local|remote)`);
  }

  try {
    run("pnpm", ["-C", "packages/instafy-cli", "test:live"], { env: process.env });
  } finally {
    if (!keepUp && target === "local") {
      // Best-effort cleanup.
      try {
        run("pnpm", ["-C", "packages/tunnel-broker", "ingress:down"]);
      } catch {}
      try {
        run("pnpm", ["stack:down"]);
      } catch {}
    }
  }
}

main();
