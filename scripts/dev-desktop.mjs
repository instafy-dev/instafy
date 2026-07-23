#!/usr/bin/env node
import { spawn } from "node:child_process";

function resolvePnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function parseViteLocalUrl(text) {
  if (!text) return null;
  const match = text.match(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1):\d+\b/);
  return match ? match[0] : null;
}

function normalizeStudioUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/studio";
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
    } catch {
      // ignore; keep polling
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function spawnChild(command, args, { env, name, stdio = "inherit" }) {
  const child = spawn(command, args, {
    stdio,
    env,
    shell: process.platform === "win32",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[dev:desktop] ${name} exited with signal ${signal}`);
      return;
    }
    console.log(`[dev:desktop] ${name} exited with code ${code ?? 0}`);
  });

  child.on("error", (error) => {
    console.error(`[dev:desktop] Failed to start ${name}:`, error);
  });

  return child;
}

function startFrontendDevServer({ command, host, preferredPort, env, scriptName }) {
  return spawnChild(
    command,
    ["--filter", "@instafy/frontend", scriptName, "--", "--host", host, "--port", String(preferredPort)],
    {
      env,
      name: "frontend",
      stdio: ["inherit", "pipe", "pipe"],
    },
  );
}

async function waitForFrontendUrl(frontend, timeoutMs) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for Vite dev server URL."));
    }, timeoutMs);

    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve(url);
    };

    const onChunk = (chunk, writer) => {
      const text = chunk.toString("utf8");
      writer.write(text);
      const parsed = parseViteLocalUrl(text);
      if (parsed) {
        finish(null, parsed);
      }
    };

    frontend.stdout?.on("data", (chunk) => onChunk(chunk, process.stdout));
    frontend.stderr?.on("data", (chunk) => onChunk(chunk, process.stderr));
    frontend.on("exit", (code) => {
      finish(new Error(`Frontend dev server exited unexpectedly (code ${code ?? "unknown"}).`));
    });
  });
}

async function main() {
  const host = process.env.VITE_HOST?.trim() || "127.0.0.1";
  const preferredPort = Number.parseInt(process.env.VITE_PORT?.trim() || "5173", 10);
  const explicitStudioUrl = process.env.INSTAFY_APP_URL?.trim() || null;
  const presetRaw = process.env.INSTAFY_DESKTOP_PRESET?.trim().toLowerCase() || "dev";
  const frontendScriptName =
    presetRaw === "prod" || presetRaw === "production" ? "dev:prod" : "dev";

  const pnpm = resolvePnpmCommand();
  const sharedEnv = { ...process.env };
  let frontend = null;
  let resolvedStudioUrl = explicitStudioUrl ? normalizeStudioUrl(explicitStudioUrl) : null;

  if (!explicitStudioUrl) {
    console.log(
      `[dev:desktop] Starting frontend dev server via ${frontendScriptName} (preferred http://${host}:${preferredPort})...`,
    );
    frontend = startFrontendDevServer({
      command: pnpm,
      host,
      preferredPort: Number.isNaN(preferredPort) ? 5173 : preferredPort,
      env: sharedEnv,
      scriptName: frontendScriptName,
    });
  } else {
    console.log(
      `[dev:desktop] Using INSTAFY_APP_URL=${resolvedStudioUrl}; skipping managed frontend dev server.`,
    );
  }

  let desktop = null;
  let shuttingDown = false;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (desktop && !desktop.killed) {
      desktop.kill("SIGTERM");
    }
    if (frontend && !frontend.killed) {
      frontend.kill("SIGTERM");
    }
    process.exit(code);
  };

  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));

  if (frontend) {
    frontend.on("exit", (code) => {
      if (shuttingDown) return;
      shutdown(typeof code === "number" ? code : 1);
    });
    const frontendBaseUrl = await waitForFrontendUrl(frontend, 60_000);
    await waitForHttpOk(frontendBaseUrl, 60_000);
    resolvedStudioUrl = normalizeStudioUrl(frontendBaseUrl);
    console.log(`[dev:desktop] Frontend dev server ready: ${resolvedStudioUrl}`);
  }

  if (!resolvedStudioUrl) {
    throw new Error("Unable to resolve desktop app URL.");
  }

  console.log(`[dev:desktop] Starting Electron (INSTAFY_APP_URL=${resolvedStudioUrl})...`);
  desktop = spawnChild(
    pnpm,
    ["--filter", "@instafy/desktop-app", "start"],
    { env: { ...sharedEnv, INSTAFY_APP_URL: resolvedStudioUrl }, name: "desktop-app" },
  );

  desktop.on("exit", (code) => {
    if (shuttingDown) return;
    shutdown(typeof code === "number" ? code : 0);
  });
}

main().catch((error) => {
  console.error("[dev:desktop] Unhandled error:", error);
  process.exit(1);
});
