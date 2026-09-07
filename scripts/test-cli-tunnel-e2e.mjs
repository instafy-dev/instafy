#!/usr/bin/env node
/**
 * Full-stack CLI tunnel E2E
 *
 * Brings up:
 * - local tunnel-broker ingress stack (docker compose)
 * - local controller (+ local Supabase) via scripts/run-e2e-dev.mjs
 *
 * Then runs:
 * - packages/instafy-cli/test/runtime-tunnel.e2e.spec.ts
 */

import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    shell: process.platform === "win32",
    ...options,
  });
  const code = result.status ?? result.code ?? 1;
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${code}`);
  }
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    cwd: repoRoot,
    shell: process.platform === "win32",
    ...options,
  });
  return result.status ?? result.code ?? 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalHostname(hostname) {
  const value = (hostname || "").trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost";
}

function resolvePort(url) {
  const parsed = new URL(url);
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

async function fetchOk(url, { timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function isPortOpen(port, { host = "127.0.0.1" } = {}) {
  return await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.setTimeout(800);
  });
}

async function waitForPort(port, { host = "127.0.0.1", timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host, port });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => resolve(false));
      socket.setTimeout(800);
    });
    if (ok) return true;
    await delay(250);
  }
  return false;
}

function normalizeBaseUrl(raw, fallback) {
  const value = (raw || "").trim();
  if (!value) return new URL(fallback).origin;
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
}

function parseArgs(argv) {
  const args = { keep: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      args.keep = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage:",
          "  pnpm test:cli:tunnel:e2e",
          "",
          "Options:",
          "  --keep    Keep the controller/broker stack running after the test (for debugging).",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const supabaseWasRunning =
    tryRun("pnpm", ["exec", "supabase", "--workdir", "supabase", "status", "--output", "env"]) ===
    0;

  const controllerBaseUrl = normalizeBaseUrl(
    process.env.PLAYWRIGHT_CONTROLLER_URL,
    "http://127.0.0.1:8788",
  );
  const controllerUrl = new URL(controllerBaseUrl);
  const controllerPort = resolvePort(controllerBaseUrl);
  const controllerHost = controllerUrl.hostname;
  const canManageController =
    controllerUrl.protocol === "http:" && isLocalHostname(controllerHost);
  console.log(`[cli-tunnel-e2e] Controller URL: ${controllerBaseUrl}`);

  const brokerEnv = {
    ...process.env,
    // Ensure host-based rathole clients can connect to the ingress control plane.
    INGRESS_HOST: process.env.INGRESS_HOST || "127.0.0.1",
  };

  const brokerBaseUrl = normalizeBaseUrl(process.env.TUNNEL_BROKER_BASE_URL, "http://127.0.0.1:8082");
  const brokerUrl = new URL(brokerBaseUrl);
  const brokerPort = resolvePort(brokerBaseUrl);
  const brokerHost = brokerUrl.hostname;
  const tunnelE2EHttpBaseUrl = normalizeBaseUrl(
    process.env.TUNNEL_E2E_HTTP_BASE_URL,
    "http://127.0.0.1:8083",
  );
  const ingressUrl = new URL(tunnelE2EHttpBaseUrl);
  const ingressPort = resolvePort(tunnelE2EHttpBaseUrl);
  const ingressHost = ingressUrl.hostname;
  const ingressProtocolOk = ingressUrl.protocol === "http:" || ingressUrl.protocol === "https:";
  const canManageBroker =
    brokerUrl.protocol === "http:" &&
    ingressProtocolOk &&
    isLocalHostname(brokerHost) &&
    isLocalHostname(ingressHost);

  const controllerEnv = {
    ...process.env,
    CONTROLLER_PORT: String(controllerPort),
    RUNTIME_SKIP_PROXY: "1",
    TUNNEL_BROKER_BASE_URL: brokerBaseUrl,
    TUNNEL_BROKER_TOKEN: process.env.TUNNEL_BROKER_TOKEN || "dev-token",
  };

  const testEnv = {
    ...process.env,
    PLAYWRIGHT_CONTROLLER_URL: controllerBaseUrl,
    TUNNEL_E2E_HTTP_BASE_URL: tunnelE2EHttpBaseUrl,
  };

  const brokerPortOpenBefore = canManageBroker
    ? await isPortOpen(brokerPort, { host: brokerHost })
    : true;
  const ingressPortOpenBefore = canManageBroker
    ? await isPortOpen(ingressPort, { host: ingressHost })
    : true;
  const brokerStackAlreadyUp = brokerPortOpenBefore && ingressPortOpenBefore;
  const brokerStackOwned = canManageBroker && !brokerPortOpenBefore && !ingressPortOpenBefore;
  const controllerWasRunning = canManageController
    ? await isPortOpen(controllerPort, { host: controllerHost })
    : true;

  let startedBroker = false;
  let startedController = false;

  try {
    run("docker", ["version"]);

    if (!canManageBroker) {
      console.log(
        `[cli-tunnel-e2e] Using external tunnel broker/ingress (${brokerBaseUrl}, ${tunnelE2EHttpBaseUrl}); skipping broker startup.`,
      );
    } else if (brokerStackAlreadyUp) {
      console.log("[cli-tunnel-e2e] Tunnel broker/ingress already running; reusing existing stack.");
    } else {
      console.log("[cli-tunnel-e2e] Starting tunnel broker (ingress profile)...");
      run("pnpm", ["-C", "packages/tunnel-broker", "ingress:up:build"], { env: brokerEnv });
      startedBroker = brokerStackOwned;
    }

    const brokerReady = canManageBroker
      ? await waitForPort(brokerPort, { timeoutMs: 60_000, host: brokerHost })
      : true;
    if (!brokerReady) {
      throw new Error(`Tunnel broker did not become reachable on ${brokerBaseUrl}`);
    }
    const brokerHealthy = await fetchOk(`${brokerBaseUrl}/healthz`, { timeoutMs: 2500 });
    if (!brokerHealthy) {
      throw new Error(`Tunnel broker is up but not healthy on ${brokerBaseUrl}/healthz`);
    }

    const traefikReady = canManageBroker
      ? await waitForPort(ingressPort, { timeoutMs: 60_000, host: ingressHost })
      : true;
    if (!traefikReady) {
      throw new Error(`Tunnel ingress (Traefik) did not become reachable on ${tunnelE2EHttpBaseUrl}`);
    }

    if (!canManageController) {
      console.log(
        `[cli-tunnel-e2e] Using external controller (${controllerBaseUrl}); skipping controller startup.`,
      );
    } else if (controllerWasRunning) {
      const controllerHealthy = await fetchOk(`${controllerBaseUrl}/healthz`, { timeoutMs: 2500 });
      if (!controllerHealthy) {
        throw new Error(
          `Port ${controllerPort} is already in use, but ${controllerBaseUrl}/healthz did not respond OK. ` +
            "Stop the existing process (or point PLAYWRIGHT_CONTROLLER_URL at your controller) and retry.",
        );
      }
      console.log("[cli-tunnel-e2e] Controller already running; reusing existing instance.");
    } else {
      console.log("[cli-tunnel-e2e] Starting controller (and Supabase if needed)...");
      run("node", ["scripts/run-e2e-dev.mjs", "controller:start"], { env: controllerEnv });
      startedController = true;
    }

    console.log("[cli-tunnel-e2e] Building runtime-agent...");
    run(process.execPath, ["scripts/runtime-cargo.mjs", "build", "--manifest-path", "packages/runtime-agent/Cargo.toml", "--bins"]);

    console.log("[cli-tunnel-e2e] Building CLI...");
    run("pnpm", ["--filter", "@instafy/cli", "build"]);

    console.log("[cli-tunnel-e2e] Running CLI tunnel spec...");
    run("pnpm", ["--filter", "@instafy/cli", "exec", "vitest", "run", "test/runtime-tunnel.e2e.spec.ts"], {
      env: testEnv,
    });
  } finally {
    if (args.keep) {
      console.log("[cli-tunnel-e2e] --keep enabled; skipping teardown.");
      return;
    }

    if (!canManageController) {
      console.log("[cli-tunnel-e2e] Leaving external controller untouched.");
    } else if (startedController) {
      console.log("[cli-tunnel-e2e] Tearing down controller/provider stack...");
      const downEnv = { ...controllerEnv };
      if (supabaseWasRunning) {
        downEnv.RUNTIME_KEEP_SUPABASE = "1";
      }
      try {
        run("node", ["scripts/run-e2e-dev.mjs", "down"], { env: downEnv });
      } catch (error) {
        console.warn(
          `[cli-tunnel-e2e] Warning: controller stack teardown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      console.log("[cli-tunnel-e2e] Leaving controller stack running (reused existing instance).");
    }

    if (!canManageBroker) {
      console.log("[cli-tunnel-e2e] Leaving external tunnel broker untouched.");
    } else if (startedBroker) {
      console.log("[cli-tunnel-e2e] Tearing down tunnel broker stack...");
      try {
        run("pnpm", ["-C", "packages/tunnel-broker", "ingress:down"], { env: brokerEnv });
      } catch (error) {
        console.warn(
          `[cli-tunnel-e2e] Warning: broker teardown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      console.log("[cli-tunnel-e2e] Leaving tunnel broker stack running (reused existing instance).");
    }
  }
}

main().catch((error) => {
  console.error(`[cli-tunnel-e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
