#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import {
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseServiceRoleKey,
} from "./lib/localSupabaseEnv.mjs";
import {
  fetchSpeechServiceHealth,
  getSpeechServiceReadiness,
  waitForSpeechServiceReady,
} from "../packages/frontend/scripts/shared/speech-service-health.mjs";

const REPO_ROOT = new URL("../", import.meta.url);
const LOCAL_SPEECH_BASE_URL = process.env.INSTAFY_SPEECH_SERVICE_URL || "http://127.0.0.1:8796";
const LOCAL_SPEECH_HEALTH_URL = `${LOCAL_SPEECH_BASE_URL.replace(/\/+$/, "")}/health`;
const LOCAL_WHISPER_MODEL = process.env.LOCAL_SPEECH_WHISPER_MODEL || "openai/whisper-small";
const DEFAULT_TIMEOUT_MS = 30_000;

function usage() {
  console.log(
    [
      "Usage: node scripts/voice-tunnel-smoke.mjs",
      "",
      "Starts or reuses the local speech service, requests a speech tunnel from the local controller,",
      "waits for the ingress route to come up, then proves /health, /synthesize, and /transcribe",
      "through the tunneled speech URL.",
    ].join("\n"),
  );
}

function normalizeTranscript(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function repoPath(url) {
  return new URL(url).pathname;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCapture(command, args, cwd = REPO_ROOT) {
  const result = spawnSync(command, args, {
    cwd: repoPath(cwd),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = result.status ?? result.code ?? 1;
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || "").trim() || `exit ${code}`}`);
  }
  return result.stdout || "";
}

function resolveLocalServiceRoleKey() {
  const statusEnv = readLocalSupabaseStatusEnv({
    cwd: repoPath(REPO_ROOT),
    required: true,
  });
  const serviceRoleKey = resolveLocalSupabaseServiceRoleKey({ env: {}, statusEnv });
  if (serviceRoleKey) {
    return serviceRoleKey;
  }
  throw new Error("Supabase local status did not include SERVICE_ROLE_KEY.");
}

async function ensureLocalSpeechService() {
  let existingPayload = null;
  try {
    existingPayload = await fetchSpeechServiceHealth(LOCAL_SPEECH_HEALTH_URL);
  } catch {
    existingPayload = null;
  }

  if (existingPayload) {
    const readiness = getSpeechServiceReadiness(existingPayload);
    if (readiness.ready) {
      return null;
    }
    await waitForSpeechServiceReady(LOCAL_SPEECH_HEALTH_URL, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return null;
  }

  const child = spawn(
    "pnpm",
    ["-C", "packages/frontend", "dev:speech-service"],
    {
      cwd: repoPath(REPO_ROOT),
      env: {
        ...process.env,
        LOCAL_SPEECH_WHISPER_MODEL: LOCAL_WHISPER_MODEL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[voice-tunnel-smoke:speech] ${chunk.toString("utf8")}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[voice-tunnel-smoke:speech] ${chunk.toString("utf8")}`);
  });

  try {
    await waitForSpeechServiceReady(LOCAL_SPEECH_HEALTH_URL, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return child;
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    throw error;
  }
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

async function startSpeechTunnel(serviceRoleKey) {
  const child = spawn(
    process.execPath,
    [
      "scripts/webhook-tunnel.mjs",
      "--port",
      "8796",
      "--ready-path",
      "/health",
      "--print-speech-env",
      "--json",
    ],
    {
      cwd: repoPath(REPO_ROOT),
      env: {
        ...process.env,
        SERVICE_ROLE_KEY: serviceRoleKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let parsedPayload = null;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    process.stdout.write(`[voice-tunnel-smoke:tunnel] ${text}`);
    if (!parsedPayload) {
      const jsonBlock = extractFirstJsonObject(stdout);
      if (jsonBlock) {
        parsedPayload = JSON.parse(jsonBlock);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(`[voice-tunnel-smoke:tunnel] ${text}`);
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (parsedPayload) {
      return { child, payload: parsedPayload };
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Speech tunnel exited early with code ${child.exitCode}.\n${stdout}\n${stderr}`.trim(),
      );
    }
    await sleep(250);
  }

  child.kill("SIGTERM");
  throw new Error("Timed out waiting for tunnel metadata from the webhook tunnel script.");
}

function buildTunnelOverrideTarget(urlString) {
  const publicUrl = new URL(urlString);
  const protocol = publicUrl.protocol === "https:" ? "https:" : "http:";
  const port =
    publicUrl.port ||
    (protocol === "https:" ? "443" : "80");
  return {
    publicUrl,
    ingressUrl: `${protocol}//127.0.0.1:${port}`,
    hostHeader: publicUrl.host,
  };
}

async function fetchThroughTunnel(target, pathname, init = {}) {
  const requestUrl = new URL(pathname, target.ingressUrl);
  const bodyBuffer =
    typeof init.body === "string"
      ? Buffer.from(init.body)
      : Buffer.isBuffer(init.body)
        ? init.body
        : init.body == null
          ? null
          : Buffer.from(String(init.body));
  const headers = {
    ...(init.headers || {}),
    host: target.hostHeader,
  };
  if (bodyBuffer && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
    headers["content-length"] = String(bodyBuffer.length);
  }

  const transport = requestUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      requestUrl,
      {
        method: init.method || "GET",
        headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            ok: (response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300,
            status: response.statusCode || 500,
            statusText: response.statusMessage || "",
            headers: {
              get(name) {
                const value = response.headers[name.toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : value ?? null;
              },
            },
            text: async () => buffer.toString("utf8"),
            json: async () => JSON.parse(buffer.toString("utf8")),
            arrayBuffer: async () => buffer,
          });
        });
      },
    );
    request.on("error", reject);
    if (bodyBuffer) {
      request.write(bodyBuffer);
    }
    request.end();
  });
}

async function waitForTunnelHealth(target) {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const response = await fetchThroughTunnel(target, "/health");
      if (response.ok) {
        return await response.json();
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for tunnel health: ${lastError}`);
}

async function synthesizeThroughTunnel(target, text) {
  const response = await fetchThroughTunnel(target, "/synthesize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text,
      format: "wav",
    }),
  });
  if (!response.ok) {
    throw new Error(`Tunnel synthesis failed (${response.status}): ${(await response.text()).trim()}`);
  }
  return {
    mimeType: response.headers.get("content-type")?.toLowerCase() || "audio/wav",
    buffer: Buffer.from(await response.arrayBuffer()),
  };
}

async function transcribeThroughTunnel(target, audioArtifact) {
  const response = await fetchThroughTunnel(target, "/transcribe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audioDataUrl: `data:${audioArtifact.mimeType};base64,${audioArtifact.buffer.toString("base64")}`,
      fileName: "voice-tunnel-smoke.wav",
    }),
  });
  if (!response.ok) {
    throw new Error(`Tunnel transcription failed (${response.status}): ${(await response.text()).trim()}`);
  }
  return response.json();
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve(undefined);
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.kill("SIGTERM");
  });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    process.exit(0);
  }

  const serviceRoleKey = resolveLocalServiceRoleKey();
  const managedSpeechService = await ensureLocalSpeechService();
  let tunnelChild = null;

  try {
    const { child, payload } = await startSpeechTunnel(serviceRoleKey);
    tunnelChild = child;
    const target = buildTunnelOverrideTarget(payload.url);
    const health = await waitForTunnelHealth(target);
    const synthesisText = "Project update tunnel voice proof";
    const audioArtifact = await synthesizeThroughTunnel(target, synthesisText);
    const transcription = await transcribeThroughTunnel(target, audioArtifact);
    const transcript = typeof transcription.text === "string" ? transcription.text : "";

    const normalizedTranscript = normalizeTranscript(transcript);
    if (
      !normalizedTranscript.includes("tunnel voice proof") &&
      !normalizedTranscript.includes(normalizeTranscript(synthesisText))
    ) {
      throw new Error(`Unexpected tunnel transcript: ${JSON.stringify(transcription)}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          tunnelId: payload.tunnelId,
          url: payload.url,
          hostHeader: target.hostHeader,
          health,
          synthesisMimeType: audioArtifact.mimeType,
          transcript,
        },
        null,
        2,
      ),
    );
  } finally {
    await stopChild(tunnelChild);
    await stopChild(managedSpeechService);
  }
}

main().catch((error) => {
  console.error(
    `[voice-tunnel-smoke] ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exit(1);
});
