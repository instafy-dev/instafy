#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const frontendRoot = path.join(repoRoot, "packages", "frontend");
const proxyScriptPath = path.join(repoRoot, "scripts", "speech-tts-proxy.mjs");
const fixtureSummaryPath = path.join(
  repoRoot,
  "packages",
  "frontend",
  "test-results",
  "speech-fixtures",
  "summary.json",
);

function usage() {
  console.log(
    [
      "Usage: node scripts/speech-strict-roundtrip-check.mjs [--proxy-port 8799] [--speech-port 8798] [--provider-port 8794] [--auth-path /abs/path/auth.json]",
      "",
      "Starts the local speech TTS proxy, waits for it to become healthy, runs the speech doctor against that backend,",
      "then runs the speech fixture roundtrip on isolated local speech/provider-host ports.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const result = {
    proxyHost: process.env.SPEECH_TTS_PROXY_HOST?.trim() || "127.0.0.1",
    proxyPort: Number(process.env.SPEECH_TTS_PROXY_PORT || 8799),
    speechPort: Number(process.env.LOCAL_SPEECH_PORT || 8798),
    providerPort: Number(process.env.LOCAL_PROVIDER_HOST_PORT || 8794),
    authPath: process.env.CODEX_AUTH_PATH?.trim() || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if ((arg === "--proxy-port" || arg === "--speech-port" || arg === "--provider-port") && argv[index + 1]) {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid value for ${arg}: ${argv[index] ?? "<missing>"}`);
      }
      if (arg === "--proxy-port") {
        result.proxyPort = value;
      } else if (arg === "--speech-port") {
        result.speechPort = value;
      } else {
        result.providerPort = value;
      }
      continue;
    }
    if (arg === "--auth-path" && argv[index + 1]) {
      result.authPath = argv[++index].trim();
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

function createEnv(options) {
  const synthesisBackendUrl = `http://${options.proxyHost}:${options.proxyPort}/v1/audio/speech`;
  const transcriptionBackendUrl = `http://${options.proxyHost}:${options.proxyPort}/v1/audio/transcriptions`;
  const speechBaseUrl = `http://127.0.0.1:${options.speechPort}`;
  const providerBaseUrl = `http://127.0.0.1:${options.providerPort}`;
  return {
    ...process.env,
    LOCAL_SPEECH_TTS_BACKEND_URL: synthesisBackendUrl,
    LOCAL_SPEECH_TRANSCRIPTION_BACKEND_URL: transcriptionBackendUrl,
    LOCAL_SPEECH_PORT: String(options.speechPort),
    LOCAL_PROVIDER_HOST_PORT: String(options.providerPort),
    INSTAFY_SPEECH_SERVICE_URL: speechBaseUrl,
    INSTAFY_SPEECH_PROVIDER_HOST_URL: providerBaseUrl,
  };
}

async function waitForHealthy(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function spawnInherited(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
}

async function runInherited(command, args, options = {}) {
  const child = spawnInherited(command, args, options);
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited via ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function stopChild(child, signal = "SIGTERM", timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill(signal);
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function readFixtureSummary() {
  try {
    const raw = await fs.readFile(fixtureSummaryPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = createEnv(options);
  const backendUrl = env.LOCAL_SPEECH_TTS_BACKEND_URL;
  const transcriptionBackendUrl = env.LOCAL_SPEECH_TRANSCRIPTION_BACKEND_URL;
  const proxyHealthUrl = `http://${options.proxyHost}:${options.proxyPort}/healthz`;

  console.log(`[speech-strict-roundtrip] synthesis backend=${backendUrl}`);
  console.log(`[speech-strict-roundtrip] transcription backend=${transcriptionBackendUrl}`);
  console.log(
    `[speech-strict-roundtrip] local speech=${env.INSTAFY_SPEECH_SERVICE_URL} provider=${env.INSTAFY_SPEECH_PROVIDER_HOST_URL}`,
  );

  const proxyArgs = [proxyScriptPath, "--host", options.proxyHost, "--port", String(options.proxyPort)];
  if (options.authPath) {
    proxyArgs.push("--auth-path", options.authPath);
  }

  const proxyChild = spawnInherited(process.execPath, proxyArgs, { env });
  const forwardSignal = async (signal) => {
    await stopChild(proxyChild, signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", () => void forwardSignal("SIGINT"));
  process.once("SIGTERM", () => void forwardSignal("SIGTERM"));

  try {
    await waitForHealthy(proxyHealthUrl);

    const bootstrapCode = await runInherited(
      "pnpm",
      ["-C", frontendRoot, "speech:bootstrap:check"],
      { env },
    );
    if (bootstrapCode !== 0) {
      throw new Error(`speech bootstrap check failed (${bootstrapCode})`);
    }

    const fixturesCode = await runInherited(
      "pnpm",
      ["-C", frontendRoot, "speech:fixtures:check"],
      { env },
    );
    if (fixturesCode !== 0) {
      const summary = await readFixtureSummary();
      const guidance =
        typeof summary?.guidance === "string" && summary.guidance.trim().length > 0
          ? summary.guidance.trim()
          : null;
      throw new Error(
        `speech fixtures check failed (${fixturesCode}). Inspect ${fixtureSummaryPath}${
          guidance ? `\n${guidance}` : ""
        }`,
      );
    }
  } finally {
    await stopChild(proxyChild);
  }
}

main().catch((error) => {
  console.error(
    `[speech-strict-roundtrip] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
