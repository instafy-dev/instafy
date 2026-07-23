#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runSpeechBackendBootstrap } from "./speech-backend-bootstrap.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const speechServiceScript = path.join(__dirname, "local-speech-service.mjs");
const providerHostScript = path.join(__dirname, "server-speech-provider-host.mjs");

function createServerVoiceEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    INSTAFY_SPEECH_HOST_MODE: baseEnv.INSTAFY_SPEECH_HOST_MODE || "server",
    LOCAL_SPEECH_HOST: baseEnv.LOCAL_SPEECH_HOST || "0.0.0.0",
    LOCAL_PROVIDER_HOST_HOST: baseEnv.LOCAL_PROVIDER_HOST_HOST || "0.0.0.0",
    INSTAFY_SPEECH_AUTODETECT_LOCAL_SERVICE:
      baseEnv.INSTAFY_SPEECH_AUTODETECT_LOCAL_SERVICE || "true",
  };
}

function parseBooleanFlag(value, defaultValue = false) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function attachLogs(label, child) {
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      console.log(`[${label}] ${text}`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      console.error(`[${label}] ${text}`);
    }
  });
}

function startService(scriptPath, env) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachLogs(path.basename(scriptPath), child);
  return child;
}

async function stopChild(child, signal = "SIGTERM", timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      finish();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      finish();
    });
    child.kill(signal);
  });
}

async function main() {
  const env = createServerVoiceEnv();
  if (parseBooleanFlag(env.INSTAFY_SPEECH_BOOTSTRAP_ON_START, false)) {
    console.log("[server-speech-host] bootstrapping managed speech runtime before startup");
    const bootstrapResult = await runSpeechBackendBootstrap({
      action: "install_transcription",
      dryRun: false,
    });
    if (!bootstrapResult?.ok) {
      throw new Error(bootstrapResult?.error || "Server speech bootstrap failed.");
    }
  }
  const children = [
    startService(speechServiceScript, env),
    startService(providerHostScript, env),
  ];

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await Promise.all(children.map((child) => stopChild(child).catch(() => undefined)));
    process.exitCode = code;
  };

  for (const child of children) {
    child.once("exit", async (code, signal) => {
      if (shuttingDown) {
        return;
      }
      console.error(
        `[server-speech-host] ${path.basename(child.spawnargs?.[1] || "service")} exited unexpectedly (${signal ?? code ?? "unknown"}).`,
      );
      await shutdown(typeof code === "number" ? code : 1);
    });
    child.once("error", async (error) => {
      if (shuttingDown) {
        return;
      }
      console.error(
        `[server-speech-host] ${path.basename(child.spawnargs?.[1] || "service")} failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await shutdown(1);
    });
  }

  const handleSignal = async () => {
    await shutdown(0);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  console.log("[server-speech-host] running shared speech host in server mode");
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(
    `[server-speech-host] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
