import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { publishProjectSpeechRoute } from "./project-speech-route-publisher.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const SERVER_SPEECH_HOST_SCRIPT = path.join(
  REPO_ROOT,
  "packages",
  "frontend",
  "scripts",
  "server-speech-host.mjs",
);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function attachLogs(child, prefix = "[server-voice-publisher]") {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`${prefix} ${chunk.toString("utf8")}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`${prefix} ${chunk.toString("utf8")}`);
  });
}

async function waitForJson(url, predicate = () => true, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (predicate(payload)) {
          return payload;
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function extractSpeechServiceFailure(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const transcription =
    payload.transcription && typeof payload.transcription === "object" ? payload.transcription : null;
  const synthesis =
    payload.synthesis && typeof payload.synthesis === "object" ? payload.synthesis : null;
  const transcriptionError =
    typeof transcription?.lastError === "string" ? transcription.lastError.trim() : "";
  if (transcriptionError) {
    return transcriptionError;
  }
  const synthesisError =
    typeof synthesis?.lastError === "string" ? synthesis.lastError.trim() : "";
  if (synthesisError) {
    return synthesisError;
  }
  return null;
}

async function waitForSpeechServiceReady(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        const serviceFailure = extractSpeechServiceFailure(payload);
        if (serviceFailure) {
          throw new Error(serviceFailure);
        }
        const transcriptionReady =
          payload?.transcription?.ready === true ||
          (payload?.transcription?.warming === true && payload?.transcription?.lastError == null);
        if (payload?.ok === true && transcriptionReady && payload?.synthesis?.ready === true) {
          return payload;
        }
        lastError = "speech service is not ready yet";
      } else {
        lastError = `${response.status} ${response.statusText}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (lastError.includes("insanely-fast-whisper")) {
        throw new Error(lastError);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function stopChild(child) {
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
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      finish();
    });
    child.kill("SIGTERM");
  });
}

export async function launchServerVoicePublisher(options = {}) {
  const speechPort = await getFreePort();
  const providerPort = await getFreePort();
  const managedSpeechHome = await fs.mkdtemp(path.join(os.tmpdir(), "instafy-server-voice-publisher-"));
  const env = {
    ...process.env,
    INSTAFY_SPEECH_HOST_MODE: "server",
    INSTAFY_SPEECH_HOST_HOME: managedSpeechHome,
    LOCAL_SPEECH_HOST: "127.0.0.1",
    LOCAL_PROVIDER_HOST_HOST: "127.0.0.1",
    LOCAL_SPEECH_PORT: String(speechPort),
    LOCAL_PROVIDER_HOST_PORT: String(providerPort),
    ...(options.env ?? {}),
  };

  const child = spawn(process.execPath, [SERVER_SPEECH_HOST_SCRIPT], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachLogs(child);

  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await stopChild(child).catch(() => undefined);
    await fs.rm(managedSpeechHome, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const speechServiceHealthUrl = `http://127.0.0.1:${speechPort}/health`;
    const providerHostHealthUrl = `http://127.0.0.1:${providerPort}/health`;
    await waitForSpeechServiceReady(speechServiceHealthUrl, options.timeoutMs ?? 120_000);
    await waitForJson(
      providerHostHealthUrl,
      (payload) => payload?.ok === true && payload?.providers?.[0]?.id === "speech",
      30_000,
    );
    const publicUrl = `http://127.0.0.1:${speechPort}`;
    return {
      publicUrl,
      hostname: "127.0.0.1",
      speechServiceHealthUrl,
      providerHostHealthUrl,
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

export async function publishServerSpeechRoute(input) {
  await publishProjectSpeechRoute({
    controllerUrl: input.controllerUrl,
    controllerAccessToken: input.controllerAccessToken,
    projectId: input.projectId,
    publicUrl: input.publicUrl,
    hostMode: "server",
    connectionType: "http",
  });
}
