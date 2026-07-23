#!/usr/bin/env node

/**
 * Live infra helpers (developer convenience).
 *
 * `up` brings up:
 * - tunnel-broker ingress (rathole + broker + traefik)
 * - local Supabase + controller/proxy/provider stack
 *
 * `down` tears them back down.
 */

import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  const code = typeof result.status === "number" ? result.status : 1;
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${code}`);
  }
}

function isTruthy(value) {
  return value && value.trim() && value.trim() !== "0" && value.trim().toLowerCase() !== "false";
}

function applyDefaults(env) {
  const next = { ...env };
  next.INGRESS_HOST = next.INGRESS_HOST || "127.0.0.1";
  next.RATHOLE_CONFIG_REFRESH_SECONDS = next.RATHOLE_CONFIG_REFRESH_SECONDS || "1";
  next.TUNNEL_BROKER_BASE_URL = next.TUNNEL_BROKER_BASE_URL || "http://127.0.0.1:8082";
  next.TUNNEL_BROKER_TOKEN = next.TUNNEL_BROKER_TOKEN || "dev-token";
  return next;
}

function usage() {
  console.log("Usage: pnpm live:up | pnpm live:down");
  console.log("");
  console.log("Env overrides:");
  console.log("  TUNNEL_BROKER_BASE_URL, TUNNEL_BROKER_TOKEN");
  console.log("  INGRESS_HOST, RATHOLE_CONFIG_REFRESH_SECONDS");
  console.log("  RUNTIME_KEEP_SUPABASE=1 (preserve Supabase on down)");
}

async function main() {
  const [command = "help"] = process.argv.slice(2);
  const env = applyDefaults(process.env);

  switch (command) {
    case "up": {
      console.log("[live-env] Starting tunnel broker ingress...");
      run("pnpm", ["-C", "packages/tunnel-broker", "ingress:up:build"], { env });

      console.log("[live-env] Starting local stack (Supabase + controller + proxy + providers)...");
      run("pnpm", ["stack:up"], { env });

      console.log("[live-env] Live env ready.");
      console.log(`- Controller: ${env.VITE_CONTROLLER_URL || "http://127.0.0.1:8788"}`);
      console.log("- Webhook tunnel (rathole): pnpm tunnel:webhook --port 8788");
      console.log("- Stripe CLI forward: pnpm stripe:sync-env && pnpm stripe:listen");
      break;
    }
    case "down": {
      const keepUp = isTruthy(env.LIVE_KEEP_UP || "");
      if (keepUp) {
        console.log("[live-env] LIVE_KEEP_UP=1 set; skipping teardown.");
        return;
      }
      console.log("[live-env] Stopping tunnel broker ingress...");
      try {
        run("pnpm", ["-C", "packages/tunnel-broker", "ingress:down"], { env });
      } catch (_error) {
        // best-effort
      }
      console.log("[live-env] Stopping local stack...");
      try {
        run("pnpm", ["stack:down"], { env });
      } catch (_error) {
        // best-effort
      }
      console.log("[live-env] Live env stopped.");
      break;
    }
    case "help":
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
