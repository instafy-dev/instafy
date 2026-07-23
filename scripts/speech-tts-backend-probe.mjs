#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { resolveTranscriptionBackendConfig } from "../packages/frontend/scripts/shared/openai-speech-backend.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const proxyScriptPath = path.join(repoRoot, "scripts", "speech-tts-proxy.mjs");
const repoOpenAiEnvPath = path.join(repoRoot, ".env.openai");

function usage() {
  console.log(
    [
      "Usage: node scripts/speech-tts-backend-probe.mjs [--proxy-port 8799] [--host 127.0.0.1] [--auth-path /abs/path/auth.json] [--model gpt-4o-mini-tts] [--voice cedar] [--format wav]",
      "",
      "Starts the local speech proxy, probes /v1/audio/speech and /v1/audio/transcriptions,",
      "and reports whether the configured credentials/backend can complete a cheap speech roundtrip.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const result = {
    host: process.env.SPEECH_TTS_PROXY_HOST?.trim() || "127.0.0.1",
    port: Number(process.env.SPEECH_TTS_PROXY_PORT || 8799),
    authPath: process.env.CODEX_AUTH_PATH?.trim() || "",
    model: process.env.LOCAL_SPEECH_TTS_OPENAI_MODEL?.trim() || "gpt-4o-mini-tts",
    voice: process.env.LOCAL_SPEECH_TTS_OPENAI_VOICE?.trim() || "cedar",
    format: "wav",
    text: "Instafy speech backend probe.",
    transcriptionModel:
      process.env.LOCAL_SPEECH_TRANSCRIPTION_OPENAI_MODEL?.trim() || "gpt-4o-transcribe",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if ((arg === "--proxy-port" || arg === "--port") && argv[index + 1]) {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid ${arg} value: ${argv[index] ?? "<missing>"}`);
      }
      result.port = value;
      continue;
    }
    if (arg === "--host" && argv[index + 1]) {
      result.host = argv[++index].trim();
      continue;
    }
    if (arg === "--auth-path" && argv[index + 1]) {
      result.authPath = argv[++index].trim();
      continue;
    }
    if (arg === "--model" && argv[index + 1]) {
      result.model = argv[++index].trim();
      continue;
    }
    if (arg === "--voice" && argv[index + 1]) {
      result.voice = argv[++index].trim();
      continue;
    }
    if (arg === "--format" && argv[index + 1]) {
      result.format = argv[++index].trim();
      continue;
    }
    if (arg === "--text" && argv[index + 1]) {
      result.text = argv[++index];
      continue;
    }
    if (arg === "--transcription-model" && argv[index + 1]) {
      result.transcriptionModel = argv[++index].trim();
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}

function readEnvFileValue(filePath, key) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (!line.startsWith(`${key}=`)) {
      continue;
    }
    let value = line.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

function resolveAuthDescriptor(explicitAuthPath) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey) {
    return {
      source: "OPENAI_API_KEY",
      kind: apiKey.startsWith("sk-") ? "api_key" : "non_sk_env_token",
      path: null,
      openAiApiKey: apiKey,
    };
  }

  const envFileApiKey = readEnvFileValue(repoOpenAiEnvPath, "OPENAI_API_KEY");
  if (envFileApiKey) {
    return {
      source: repoOpenAiEnvPath,
      kind: envFileApiKey.startsWith("sk-") ? "api_key" : "non_sk_env_token",
      path: null,
      openAiApiKey: envFileApiKey,
    };
  }

  const candidates = [
    explicitAuthPath ? path.resolve(explicitAuthPath) : null,
    path.join(repoRoot, "tmp", "proxy-codex", "auth.json"),
    path.join(os.homedir(), ".codex", "auth.json"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const json = JSON.parse(raw);
      const token = json.OPENAI_API_KEY || json.tokens?.access_token || "";
      return {
        source: "auth_json",
        kind:
          !token
            ? "missing"
            : token.startsWith("sk-")
              ? "api_key"
              : token.startsWith("sess-")
                ? "session"
                : token.split(".").length === 3
                  ? "jwt_like"
                : "other",
        path: candidate,
        openAiApiKey: null,
      };
    } catch {
      return {
        source: "auth_json",
        kind: "unreadable",
        path: candidate,
        openAiApiKey: null,
      };
    }
  }

  return {
    source: "none",
    kind: "missing",
    path: null,
    openAiApiKey: null,
  };
}

function extractErrorDetail(rawText) {
  const detail = typeof rawText === "string" ? rawText.trim() : "";
  if (!detail) {
    return null;
  }
  try {
    const payload = JSON.parse(detail);
    if (typeof payload?.error === "string" && payload.error.trim()) {
      return payload.error.trim();
    }
    if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
    if (typeof payload?.message === "string" && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    // Fall back to the raw response.
  }
  return detail;
}

async function waitForHealthy(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const descriptor = resolveAuthDescriptor(options.authPath);
  const proxyUrl = `http://${options.host}:${options.port}`;
  const healthUrl = `${proxyUrl}/healthz`;
  const speechUrl = `${proxyUrl}/v1/audio/speech`;
  const transcriptionUrl =
    resolveTranscriptionBackendConfig({
      ...process.env,
      LOCAL_SPEECH_TTS_BACKEND_URL: speechUrl,
    }).url ?? `${proxyUrl}/v1/audio/transcriptions`;

  console.log(
    `[speech-tts-backend-probe] credentialSource=${descriptor.source} credentialKind=${descriptor.kind}${
      descriptor.path ? ` path=${descriptor.path}` : ""
    }`,
  );
  console.log(`[speech-tts-backend-probe] probing synthesis ${speechUrl}`);
  console.log(`[speech-tts-backend-probe] probing transcription ${transcriptionUrl}`);

  const proxyArgs = [proxyScriptPath, "--host", options.host, "--port", String(options.port)];
  if (options.authPath) {
    proxyArgs.push("--auth-path", options.authPath);
  }

  const child = spawn(process.execPath, proxyArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(descriptor.openAiApiKey ? { OPENAI_API_KEY: descriptor.openAiApiKey } : {}),
    },
    stdio: "inherit",
  });

  const handleSignal = async (signal) => {
    await stopChild(child, signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", () => void handleSignal("SIGINT"));
  process.once("SIGTERM", () => void handleSignal("SIGTERM"));

  try {
    await waitForHealthy(healthUrl);
    const synthesisResponse = await fetch(speechUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        voice: options.voice,
        input: options.text,
        response_format: options.format,
      }),
    });

    if (!synthesisResponse.ok) {
      const detail = extractErrorDetail(await synthesisResponse.text());
      console.error(
        `[speech-tts-backend-probe] synthesis failed status=${synthesisResponse.status} detail=${detail ?? "<empty>"}`,
      );
      if (descriptor.kind !== "api_key") {
        console.error(
          "[speech-tts-backend-probe] current credential path is not an API-key-style token. Retry with OPENAI_API_KEY or an auth.json that carries an API key if the upstream account should support speech synthesis.",
        );
      }
      process.exitCode = 1;
      return;
    }

    const contentType = synthesisResponse.headers.get("content-type") ?? "application/octet-stream";
    const synthesisBuffer = Buffer.from(await synthesisResponse.arrayBuffer());
    console.log(
      `[speech-tts-backend-probe] synthesis ok contentType=${contentType} bytes=${synthesisBuffer.byteLength}`,
    );

    const transcriptionFormData = new FormData();
    transcriptionFormData.append(
      "file",
      new Blob([synthesisBuffer], { type: contentType }),
      `speech-probe.${options.format === "mp3" ? "mp3" : "wav"}`,
    );
    transcriptionFormData.append("model", options.transcriptionModel);

    const transcriptionResponse = await fetch(transcriptionUrl, {
      method: "POST",
      body: transcriptionFormData,
    });
    const transcriptionRawText = await transcriptionResponse.text();
    if (!transcriptionResponse.ok) {
      const detail = extractErrorDetail(transcriptionRawText);
      console.error(
        `[speech-tts-backend-probe] transcription failed status=${transcriptionResponse.status} detail=${detail ?? "<empty>"}`,
      );
      process.exitCode = 1;
      return;
    }

    let transcriptPayload = null;
    try {
      transcriptPayload = JSON.parse(transcriptionRawText);
    } catch {
      transcriptPayload = { text: transcriptionRawText };
    }
    const transcriptText =
      typeof transcriptPayload?.text === "string" ? transcriptPayload.text.trim() : "";
    console.log(
      `[speech-tts-backend-probe] transcription ok model=${options.transcriptionModel} text=${transcriptText || "<empty>"}`,
    );
    if (!transcriptText) {
      console.error("[speech-tts-backend-probe] transcription returned no text.");
      process.exitCode = 1;
    }
  } finally {
    await stopChild(child);
  }
}

main().catch((error) => {
  console.error(
    `[speech-tts-backend-probe] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
