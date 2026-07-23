import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");
const fixtureSiteServerPath = path.join(repoRoot, "packages/frontend/tests/playwright/bench/fixture-site-server.mjs");
const fixtureSiteRuntimeHost = "host.docker.internal";

export type BenchFixtureSite = {
  baseUrl: string;
  localUrl: string;
  port: number;
  stop: () => Promise<void>;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(localUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${localUrl}/healthz`);
      if (response.ok) {
        return;
      }
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Fixture site failed health check at ${localUrl}: ${lastError ?? "unknown error"}`);
}

async function waitForPortFromState(statePath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(statePath)) {
        const raw = fs.readFileSync(statePath, "utf8");
        const parsed = JSON.parse(raw) as { port?: number | null };
        if (typeof parsed.port === "number" && parsed.port > 0) {
          return parsed.port;
        }
      }
    } catch {
      // Keep polling.
    }
    await delay(100);
  }
  throw new Error(`Fixture site did not report a port in time: ${statePath}`);
}

async function stopChild(child: ChildProcess, timeoutMs: number) {
  if (child.killed || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return;
    }
    await delay(100);
  }
  child.kill("SIGKILL");
}

export async function startBenchFixtureSite(testKey: string): Promise<BenchFixtureSite> {
  if (!fs.existsSync(fixtureSiteServerPath)) {
    throw new Error(`Fixture site server missing: ${fixtureSiteServerPath}`);
  }

  const runtimeDir = path.join(repoRoot, "tmp", "playwright-fixture-sites");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const safeKey = testKey.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const suffix = `${safeKey}-${process.pid}-${Date.now()}`;
  const statePath = path.join(runtimeDir, `${suffix}.json`);
  const logPath = path.join(runtimeDir, `${suffix}.log`);
  const logFd = fs.openSync(logPath, "a");

  const child = spawn("node", [fixtureSiteServerPath, "0"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "0.0.0.0",
      STATE_PATH: statePath,
    },
    stdio: ["ignore", logFd, logFd],
  });

  try {
    const port = await waitForPortFromState(statePath, 20_000);
    const localUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(localUrl, 20_000);

    return {
      baseUrl: `http://${fixtureSiteRuntimeHost}:${port}`,
      localUrl,
      port,
      stop: async () => {
        await stopChild(child, 2_000).catch(() => {});
        try {
          fs.closeSync(logFd);
        } catch {
          // Ignore close failures.
        }
        try {
          fs.rmSync(statePath, { force: true });
        } catch {
          // Ignore cleanup failures.
        }
      },
    };
  } catch (error) {
    await stopChild(child, 1_000).catch(() => {});
    try {
      fs.closeSync(logFd);
    } catch {
      // Ignore close failures.
    }
    throw error;
  }
}
