#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import {
  normalizeOptionalString,
  parseAudioDataUrl,
  sanitizeAudioFileExtension,
} from "./shared/audio-artifact.mjs";
import {
  isOpenAiAudioSpeechUrl,
  resolveTranscriptionBackendConfig,
} from "./shared/openai-speech-backend.mjs";
import {
  resolveDefaultLocalSpeechWhisperModel,
  resolveLocalSpeechServiceConfig,
} from "./shared/speech-host-config.mjs";
import {
  buildManagedSpeechRuntimeEnv,
  ensureManagedSpeechRuntimeCacheDirs,
  pathExists,
  resolveManagedSpeechOnly,
  resolveManagedSpeechToolchainPaths,
} from "./shared/speech-managed-runtime.mjs";

const localSpeechService = resolveLocalSpeechServiceConfig(process.env);
const {
  hostMode,
  bindHost,
  healthHost,
  publicHost,
  port,
  baseUrl,
  healthUrl,
  transcriptionUrl,
  synthesisUrl,
} = localSpeechService;
const whisperBin = process.env.LOCAL_SPEECH_WHISPER_BIN || "insanely-fast-whisper";
const whisperDeviceId =
  process.env.LOCAL_SPEECH_WHISPER_DEVICE_ID || (process.platform === "darwin" ? "mps" : "0");
const whisperModelName = resolveDefaultLocalSpeechWhisperModel(process.env);
const whisperBatchSize =
  process.env.LOCAL_SPEECH_WHISPER_BATCH_SIZE || (process.platform === "darwin" ? "4" : "24");
const whisperFlash = process.env.LOCAL_SPEECH_WHISPER_FLASH === "true";
const whisperLanguage = normalizeOptionalString(process.env.LOCAL_SPEECH_WHISPER_LANGUAGE);
const synthesisBackendUrl = normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_BACKEND_URL);
const synthesisAuthToken = normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_BACKEND_TOKEN);
const transcriptionBackendConfig = resolveTranscriptionBackendConfig(process.env);
const transcriptionBackendUrl = transcriptionBackendConfig.url;
const transcriptionAuthToken = transcriptionBackendConfig.authToken;
const speechAuthToken = normalizeOptionalString(process.env.LOCAL_SPEECH_AUTH_TOKEN);
const macSayVoice = normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_SAY_VOICE);
const defaultOpenAiTtsModel =
  normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_OPENAI_MODEL) ?? "gpt-4o-mini-tts";
const defaultOpenAiTtsVoice =
  normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_OPENAI_VOICE) ?? "cedar";
const defaultOpenAiTranscriptionModel =
  normalizeOptionalString(process.env.LOCAL_SPEECH_TRANSCRIPTION_OPENAI_MODEL) ?? "gpt-4o-transcribe";
const defaultUserWhisperPath = path.join(os.homedir(), ".local", "bin", "insanely-fast-whisper");
const managedSpeechToolchain = resolveManagedSpeechToolchainPaths(process.env);
const managedSpeechRuntimeEnv = buildManagedSpeechRuntimeEnv(process.env);
const managedSpeechOnly = resolveManagedSpeechOnly(process.env);
const defaultWarmupDurationMs = Number(process.env.LOCAL_SPEECH_WARMUP_DURATION_MS || 320);
const speechTempRoot =
  normalizeOptionalString(process.env.INSTAFY_SPEECH_TEMP_ROOT) ??
  normalizeOptionalString(process.env.LOCAL_SPEECH_TEMP_ROOT) ??
  path.join(managedSpeechToolchain.home, "tmp");
const tempPrefix = path.join(speechTempRoot, "instafy-local-speech-");
const transcriptionHealth = {
  ready: false,
  warming: false,
  lastError: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
};
const synthesisHealth = {
  lastError: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
};
let transcriptionWarmupPromise = null;

async function createSpeechTempDir() {
  await fs.mkdir(path.dirname(tempPrefix), { recursive: true });
  return await fs.mkdtemp(tempPrefix);
}

function isoTimestamp(date = new Date()) {
  return date.toISOString();
}

function resolveTranscriptionStatus() {
  if (transcriptionBackendUrl) {
    return transcriptionHealth.lastError ? "failed" : "ready";
  }
  if (transcriptionHealth.ready) {
    return "ready";
  }
  if (transcriptionHealth.warming) {
    return "warming";
  }
  if (transcriptionHealth.lastError) {
    return "failed";
  }
  return "starting";
}

function resolveSynthesisStatus() {
  if (synthesisBackendUrl || process.platform === "darwin") {
    return "ready";
  }
  return "unconfigured";
}

function extractSpeechSynthesisErrorDetail(rawText) {
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
    // Fall back to the raw response body.
  }
  return detail;
}

function extractSpeechBackendErrorDetail(rawText) {
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
    // Fall back to the raw response body.
  }
  return detail;
}

function createSilentWavBuffer({ durationMs = defaultWarmupDurationMs, sampleRate = 16_000 } = {}) {
  const sampleCount = Math.max(1, Math.round((durationMs / 1_000) * sampleRate));
  const bytesPerSample = 2;
  const channelCount = 1;
  const byteRate = sampleRate * channelCount * bytesPerSample;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = sampleCount * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

async function resolveWhisperExecutablePath() {
  const explicitWhisperBin = normalizeOptionalString(process.env.LOCAL_SPEECH_WHISPER_BIN);
  if (explicitWhisperBin && explicitWhisperBin !== "insanely-fast-whisper") {
    if (path.isAbsolute(explicitWhisperBin)) {
      return explicitWhisperBin;
    }
    if (explicitWhisperBin.includes("/")) {
      return path.resolve(process.cwd(), explicitWhisperBin);
    }
    return explicitWhisperBin;
  }
  const managedWhisperPath =
    normalizeOptionalString(process.env.LOCAL_SPEECH_MANAGED_WHISPER_BIN) ??
    managedSpeechToolchain.whisperPath;
  try {
    await fs.access(managedWhisperPath);
    return managedWhisperPath;
  } catch {
    if (managedSpeechOnly) {
      return managedWhisperPath;
    }
  }
  if (path.isAbsolute(whisperBin)) {
    return whisperBin;
  }
  if (whisperBin.includes("/")) {
    return path.resolve(process.cwd(), whisperBin);
  }
  if (whisperBin === "insanely-fast-whisper") {
    try {
      await fs.access(defaultUserWhisperPath);
      return defaultUserWhisperPath;
    } catch {
      // fall through to PATH resolution
    }
  }
  return whisperBin;
}

async function resolveFfmpegExecutablePath() {
  const managedFfmpegPath =
    normalizeOptionalString(process.env.LOCAL_SPEECH_FFMPEG_BIN) ??
    normalizeOptionalString(process.env.LOCAL_SPEECH_MANAGED_FFMPEG_BIN) ??
    managedSpeechToolchain.ffmpegPath;
  try {
    await fs.access(managedFfmpegPath);
    return managedFfmpegPath;
  } catch {
    if (managedSpeechOnly) {
      return managedFfmpegPath;
    }
    return "ffmpeg";
  }
}

function jsonResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  });
  response.end(JSON.stringify(body));
}

function textResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  });
  response.end(body);
}

function audioResponse(response, statusCode, body, mimeType) {
  response.writeHead(statusCode, {
    "content-type": mimeType,
    "cache-control": "no-store",
    "content-length": String(body.length),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  });
  response.end(body);
}

function requestAuthorizationMatches(request) {
  if (!speechAuthToken) {
    return true;
  }
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() === speechAuthToken : false;
}

function authorizeSpeechRequest(request, response) {
  if (requestAuthorizationMatches(request)) {
    return true;
  }
  response.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "www-authenticate": 'Bearer realm="instafy-local-speech"',
  });
  response.end(
    JSON.stringify({
      ok: false,
      error: "Local speech service requires the Desktop pairing token for direct requests.",
    }),
  );
  return false;
}

async function toWebRequest(request, url) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : Readable.toWeb(request);
  return new Request(url, {
    method: request.method,
    headers,
    body,
    duplex: body ? "half" : undefined,
  });
}

async function readTranscriptionRequestPayload(request, url) {
  const webRequest = await toWebRequest(request, url);
  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await webRequest.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new Error("Expected multipart field \"file\".");
    }
    return {
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type || "application/octet-stream",
      fileName: normalizeOptionalString(file.name) || "speech-input.webm",
      model: normalizeOptionalString(formData.get("model")),
      language: normalizeOptionalString(formData.get("language")),
    };
  }

  const body = await webRequest.json();
  if (!body || typeof body !== "object") {
    throw new Error("Expected a JSON body.");
  }
  const parsedAudio = parseAudioDataUrl(body.audioDataUrl);
  return {
    buffer: parsedAudio.buffer,
    mimeType: parsedAudio.mimeType,
    fileName: normalizeOptionalString(body.fileName) || "speech-input.webm",
    model: normalizeOptionalString(body.model),
    language: normalizeOptionalString(body.language),
  };
}

function extractTranscriptText(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Whisper wrapper returned an invalid transcript payload.");
  }
  if (typeof payload.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }
  if (Array.isArray(payload.chunks)) {
    const combined = payload.chunks
      .map((chunk) =>
        chunk && typeof chunk === "object" && typeof chunk.text === "string" ? chunk.text.trim() : "",
      )
      .filter(Boolean)
      .join(" ")
      .trim();
    if (combined) {
      return combined;
    }
  }
  throw new Error("Whisper wrapper did not produce transcript text.");
}

function resolveValidatedWhisperDeviceId() {
  const normalized = normalizeOptionalString(whisperDeviceId)?.toLowerCase();
  if (normalized === "cpu") {
    throw new Error(
      'LOCAL_SPEECH_WHISPER_DEVICE_ID="cpu" is not supported by insanely-fast-whisper. Use "mps" on Apple Silicon or a CUDA device number.',
    );
  }
  return whisperDeviceId;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
      });
    });
  });
}

async function runWhisperTranscription(payload, options = {}) {
  const tempDir = await createSpeechTempDir();
  const inputPath = path.join(
    tempDir,
    `input${sanitizeAudioFileExtension(payload.fileName, payload.mimeType, ".webm")}`,
  );
  const outputPath = path.join(tempDir, "transcript.json");

  try {
    const validatedWhisperDeviceId = resolveValidatedWhisperDeviceId();
    const whisperExecutable = await resolveWhisperExecutablePath();
    const managedPathEntries = [managedSpeechToolchain.binDir, process.env.PATH].filter(Boolean);
    await ensureManagedSpeechRuntimeCacheDirs(process.env);
    await fs.writeFile(inputPath, payload.buffer);
    const args = [
      "--file-name",
      inputPath,
      "--transcript-path",
      outputPath,
      "--device-id",
      validatedWhisperDeviceId,
      "--model-name",
      payload.model || whisperModelName,
      "--batch-size",
      whisperBatchSize,
    ];
    if (whisperFlash) {
      args.push("--flash", "True");
    }
    if (payload.language || whisperLanguage) {
      args.push("--language", payload.language || whisperLanguage);
    }

    const result = await runCommand(whisperExecutable, args, {
      env: {
        ...process.env,
        ...managedSpeechRuntimeEnv,
        PATH: managedPathEntries.join(path.delimiter),
      },
    });
    if (!result.ok) {
      throw new Error(
        `insanely-fast-whisper failed${result.code != null ? ` (${result.code})` : ""}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
      );
    }

    const transcriptRaw = await fs.readFile(outputPath, "utf8");
    const transcriptJson = JSON.parse(transcriptRaw);
    let transcriptText = null;
    try {
      transcriptText = extractTranscriptText(transcriptJson);
    } catch (error) {
      if (!options.allowEmptyTranscript) {
        throw error;
      }
    }
    return {
      text: transcriptText,
      raw: transcriptJson,
      model: payload.model || whisperModelName,
      language: payload.language || whisperLanguage,
      engine: "insanely-fast-whisper",
      deviceId: validatedWhisperDeviceId,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function transcribeWithInsanelyFastWhisper(payload) {
  try {
    const result = await runWhisperTranscription(payload, {
      allowEmptyTranscript: false,
    });
    transcriptionHealth.ready = true;
    transcriptionHealth.lastError = null;
    transcriptionHealth.lastSuccessAt = isoTimestamp();
    return result;
  } catch (error) {
    transcriptionHealth.ready = false;
    transcriptionHealth.lastError =
      error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function transcribeViaBackend(payload) {
  transcriptionHealth.lastAttemptAt = isoTimestamp();

  const formData = new FormData();
  formData.append("file", new Blob([payload.buffer], { type: payload.mimeType }), payload.fileName);
  const model = payload.model || defaultOpenAiTranscriptionModel;
  const language = payload.language || whisperLanguage;
  if (model) {
    formData.append("model", model);
  }
  if (language) {
    formData.append("language", language);
  }

  const headers = new Headers();
  if (transcriptionAuthToken) {
    headers.set("authorization", `Bearer ${transcriptionAuthToken}`);
  }

  const response = await fetch(transcriptionBackendUrl, {
    method: "POST",
    headers,
    body: formData,
  });
  const rawText = await response.text();
  if (!response.ok) {
    const detail = extractSpeechBackendErrorDetail(rawText);
    const errorMessage = `Speech transcription backend failed (${response.status})${
      detail ? `: ${detail.slice(0, 180)}` : ""
    }`;
    transcriptionHealth.ready = false;
    transcriptionHealth.lastError = errorMessage;
    throw new Error(errorMessage);
  }

  let payloadJson = null;
  try {
    payloadJson = JSON.parse(rawText);
  } catch {
    payloadJson = rawText;
  }
  const transcriptText = extractTranscriptText(payloadJson);
  transcriptionHealth.ready = true;
  transcriptionHealth.lastError = null;
  transcriptionHealth.lastSuccessAt = isoTimestamp();
  return {
    text: transcriptText,
    raw: payloadJson,
    model,
    language,
    engine: "proxy",
    deviceId: null,
    url: transcriptionBackendUrl,
  };
}

async function warmTranscriptionEngine() {
  if (transcriptionBackendUrl) {
    transcriptionHealth.ready = true;
    transcriptionHealth.warming = false;
    transcriptionHealth.lastError = null;
    transcriptionHealth.lastSuccessAt = isoTimestamp();
    return;
  }
  if (transcriptionHealth.ready) {
    return;
  }
  if (transcriptionWarmupPromise) {
    return await transcriptionWarmupPromise;
  }

  transcriptionHealth.warming = true;
  transcriptionHealth.lastError = null;
  transcriptionHealth.lastAttemptAt = isoTimestamp();

  transcriptionWarmupPromise = (async () => {
    try {
      await runWhisperTranscription({
        buffer: createSilentWavBuffer(),
        mimeType: "audio/wav",
        fileName: "speech-warmup.wav",
        model: whisperModelName,
        language: whisperLanguage,
      }, {
        allowEmptyTranscript: true,
      });
      transcriptionHealth.ready = true;
      transcriptionHealth.lastSuccessAt = isoTimestamp();
    } catch (error) {
      transcriptionHealth.ready = false;
      transcriptionHealth.lastError =
        error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      transcriptionHealth.warming = false;
      transcriptionWarmupPromise = null;
    }
  })();

  return await transcriptionWarmupPromise;
}

async function shouldWarmTranscriptionOnStartup() {
  if (transcriptionBackendUrl) {
    return false;
  }
  if (!managedSpeechOnly) {
    return true;
  }
  const whisperExecutable = await resolveWhisperExecutablePath();
  if (!whisperExecutable || (!path.isAbsolute(whisperExecutable) && !whisperExecutable.includes("/"))) {
    return true;
  }
  return await pathExists(whisperExecutable);
}

async function parseSynthesisRequestPayload(request, url) {
  const webRequest = await toWebRequest(request, url);
  const body = await webRequest.json();
  if (!body || typeof body !== "object") {
    throw new Error("Expected a JSON body.");
  }
  const text = normalizeOptionalString(body.text);
  if (!text) {
    throw new Error("Speech synthesis requires text.");
  }
  return {
    text,
    voice: normalizeOptionalString(body.voice),
    language: normalizeOptionalString(body.language),
    rate: typeof body.rate === "number" ? body.rate : null,
    format: normalizeOptionalString(body.format),
  };
}

function resolveSynthesisFormatTarget(format) {
  const normalized = normalizeOptionalString(format)?.toLowerCase();
  if (!normalized || normalized === "aiff" || normalized === "audio/aiff") {
    return {
      ext: ".aiff",
      mimeType: "audio/aiff",
      ffmpegFormat: null,
    };
  }
  if (normalized === "wav" || normalized === "wave" || normalized === "audio/wav") {
    return {
      ext: ".wav",
      mimeType: "audio/wav",
      ffmpegFormat: "wav",
    };
  }
  if (normalized === "mp3" || normalized === "mpeg" || normalized === "audio/mpeg") {
    return {
      ext: ".mp3",
      mimeType: "audio/mpeg",
      ffmpegFormat: "mp3",
    };
  }
  throw new Error(`Unsupported synthesis format: ${format}`);
}

async function transcodeAudioWithFfmpeg(inputPath, outputPath, format) {
  const ffmpegExecutable = await resolveFfmpegExecutablePath();
  const args = ["-y", "-i", inputPath];
  if (format === "mp3") {
    args.push("-codec:a", "libmp3lame", "-q:a", "4");
  }
  args.push(outputPath);
  const result = await runCommand(ffmpegExecutable, args);
  if (!result.ok) {
    throw new Error(
      `ffmpeg failed${result.code != null ? ` (${result.code})` : ""}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
    );
  }
}

async function synthesizeViaProxy(payload) {
  synthesisHealth.lastAttemptAt = isoTimestamp();
  let requestBody = payload;
  try {
    if (isOpenAiAudioSpeechUrl(synthesisBackendUrl)) {
      requestBody = {
        model: defaultOpenAiTtsModel,
        voice: payload.voice || defaultOpenAiTtsVoice,
        input: payload.text,
        response_format: payload.format
          ? resolveSynthesisFormatTarget(payload.format).ffmpegFormat ?? "wav"
          : "wav",
      };
    }
  } catch {
    // Fall back to the caller-provided payload for non-URL or custom backend values.
  }

  const headers = new Headers({
    "content-type": "application/json",
  });
  if (synthesisAuthToken) {
    headers.set("authorization", `Bearer ${synthesisAuthToken}`);
  }

  const response = await fetch(synthesisBackendUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const detail = extractSpeechSynthesisErrorDetail(await response.text());
    const errorMessage = `Speech synthesis proxy failed (${response.status})${
      detail ? `: ${detail.slice(0, 180)}` : ""
    }`;
    synthesisHealth.lastError = errorMessage;
    throw new Error(errorMessage);
  }

  synthesisHealth.lastError = null;
  synthesisHealth.lastSuccessAt = isoTimestamp();
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "application/octet-stream";
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType: contentType,
    engine: "proxy",
  };
}

async function synthesizeViaMacSay(payload) {
  synthesisHealth.lastAttemptAt = isoTimestamp();
  const tempDir = await createSpeechTempDir();
  const sourcePath = path.join(tempDir, "speech.aiff");
  try {
    const rate = payload.rate ? Math.max(90, Math.min(360, Math.round(payload.rate * 180))) : null;
    const args = [];
    if (payload.voice || macSayVoice) {
      args.push("-v", payload.voice || macSayVoice);
    }
    if (rate) {
      args.push("-r", String(rate));
    }
    args.push("-o", sourcePath, payload.text);
    const result = await runCommand("say", args);
    if (!result.ok) {
      throw new Error(
        `macOS say failed${result.code != null ? ` (${result.code})` : ""}: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
      );
    }
    const target = resolveSynthesisFormatTarget(payload.format);
    if (!target.ffmpegFormat) {
      synthesisHealth.lastError = null;
      synthesisHealth.lastSuccessAt = isoTimestamp();
      return {
        buffer: await fs.readFile(sourcePath),
        mimeType: target.mimeType,
        engine: "macos_say",
      };
    }
    const outputPath = path.join(tempDir, `speech${target.ext}`);
    await transcodeAudioWithFfmpeg(sourcePath, outputPath, target.ffmpegFormat);
    synthesisHealth.lastError = null;
    synthesisHealth.lastSuccessAt = isoTimestamp();
    return {
      buffer: await fs.readFile(outputPath),
      mimeType: target.mimeType,
      engine: "macos_say",
    };
  } catch (error) {
    synthesisHealth.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function listMacSayVoices() {
  const result = await runCommand("say", ["-v", "?"]);
  if (!result.ok) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^\s]+)\s+([a-z_]+)\s+#\s+(.*)$/i);
      if (!match) {
        return null;
      }
      return {
        id: match[1],
        name: match[1],
        language: match[2],
        label: `${match[1]} (${match[2]})`,
      };
    })
    .filter(Boolean);
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    jsonResponse(response, 400, { ok: false, error: "Request URL is missing." });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    response.end();
    return;
  }

  const url = new URL(request.url, healthUrl);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      jsonResponse(response, 200, {
        ok: true,
        hostMode,
        service: {
          bindHost,
          healthHost,
          publicHost,
          port,
          baseUrl,
          healthUrl,
          tempRoot: speechTempRoot,
          authRequired: Boolean(speechAuthToken),
        },
        transcription: {
          engine: transcriptionBackendUrl ? "proxy" : "insanely-fast-whisper",
          url: transcriptionBackendUrl,
          bin: whisperBin,
          deviceId: whisperDeviceId,
          model: transcriptionBackendUrl ? defaultOpenAiTranscriptionModel : whisperModelName,
          batchSize: whisperBatchSize,
          flash: whisperFlash,
          language: whisperLanguage,
          ready: transcriptionBackendUrl ? transcriptionHealth.lastError == null : transcriptionHealth.ready,
          warming: transcriptionHealth.warming,
          status: resolveTranscriptionStatus(),
          lastError: transcriptionHealth.lastError,
          lastAttemptAt: transcriptionHealth.lastAttemptAt,
          lastSuccessAt: transcriptionHealth.lastSuccessAt,
        },
        synthesis: synthesisBackendUrl
          ? {
              engine: "proxy",
              url: synthesisBackendUrl,
              ready: true,
              status: resolveSynthesisStatus(),
              lastError: synthesisHealth.lastError,
              lastAttemptAt: synthesisHealth.lastAttemptAt,
              lastSuccessAt: synthesisHealth.lastSuccessAt,
            }
          : process.platform === "darwin"
            ? {
                engine: "macos_say",
                defaultVoice: macSayVoice,
                ready: true,
                status: resolveSynthesisStatus(),
                lastError: synthesisHealth.lastError,
                lastAttemptAt: synthesisHealth.lastAttemptAt,
                lastSuccessAt: synthesisHealth.lastSuccessAt,
              }
            : {
                engine: "none",
                ready: false,
                status: resolveSynthesisStatus(),
                lastError: synthesisHealth.lastError,
                lastAttemptAt: synthesisHealth.lastAttemptAt,
                lastSuccessAt: synthesisHealth.lastSuccessAt,
              },
      });
      return;
    }

    if (!authorizeSpeechRequest(request, response)) {
      return;
    }

    if (request.method === "POST" && url.pathname === "/warmup") {
      await warmTranscriptionEngine();
      jsonResponse(response, 200, {
        ok: true,
        transcription: {
          ready: transcriptionHealth.ready,
          warming: transcriptionHealth.warming,
          status: resolveTranscriptionStatus(),
          lastError: transcriptionHealth.lastError,
          lastAttemptAt: transcriptionHealth.lastAttemptAt,
          lastSuccessAt: transcriptionHealth.lastSuccessAt,
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/voices") {
      const voices =
        synthesisBackendUrl || process.platform !== "darwin" ? [] : await listMacSayVoices();
      jsonResponse(response, 200, {
        ok: true,
        defaultVoice: macSayVoice,
        voices,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/transcribe") {
      const payload = await readTranscriptionRequestPayload(request, url);
      const result = transcriptionBackendUrl
        ? await transcribeViaBackend(payload)
        : await transcribeWithInsanelyFastWhisper(payload);
      jsonResponse(response, 200, {
        ok: true,
        ...result,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/synthesize") {
      const payload = await parseSynthesisRequestPayload(request, url);
      const result = synthesisBackendUrl
        ? await synthesizeViaProxy(payload)
        : process.platform === "darwin"
          ? await synthesizeViaMacSay(payload)
          : null;
      if (!result) {
        jsonResponse(response, 501, {
          ok: false,
          error:
            "Speech synthesis is not configured. Set LOCAL_SPEECH_TTS_BACKEND_URL or run on macOS to use the built-in say fallback.",
        });
        return;
      }
      audioResponse(response, 200, result.buffer, result.mimeType);
      return;
    }

    jsonResponse(response, 404, {
      ok: false,
      error: `Unknown route: ${request.method} ${url.pathname}`,
    });
  } catch (error) {
    jsonResponse(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, bindHost, () => {
  console.log(
    `[local-speech-service] listening on ${bindHost}:${port} (public=${baseUrl}, health=${healthUrl}, mode=${hostMode}, whisper=${whisperBin}, device=${whisperDeviceId})`,
  );
  console.log(
    `[local-speech-service] set INSTAFY_SPEECH_TRANSCRIPTION_URL=${transcriptionUrl}`,
  );
  console.log(
    `[local-speech-service] set INSTAFY_SPEECH_SYNTHESIS_URL=${synthesisUrl}`,
  );
  void (async () => {
    const shouldWarm = await shouldWarmTranscriptionOnStartup();
    if (!shouldWarm) {
      console.log("[local-speech-service] waiting for managed transcription runtime before warmup");
      return;
    }
    await warmTranscriptionEngine();
  })().catch((error) => {
    console.error(
      `[local-speech-service] warmup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
});
