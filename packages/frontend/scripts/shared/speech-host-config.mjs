import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOptionalString } from "./audio-artifact.mjs";

export const DEFAULT_LOCAL_SPEECH_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_SPEECH_BIND_HOST = DEFAULT_LOCAL_SPEECH_HOST;
export const DEFAULT_LOCAL_SPEECH_HEALTH_HOST = DEFAULT_LOCAL_SPEECH_HOST;
export const DEFAULT_LOCAL_SPEECH_PORT = 8796;
export const DEFAULT_SPEECH_HOST_MODE = "cli";
export const DEFAULT_LOCAL_SPEECH_WHISPER_MODEL = "openai/whisper-large-v3";
export const DEFAULT_DESKTOP_LOCAL_SPEECH_WHISPER_MODEL = "openai/whisper-small";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const frontendPackageDir = path.resolve(__dirname, "../..");

export function resolveSpeechHostMode(value = process.env.INSTAFY_SPEECH_HOST_MODE) {
  const normalized = normalizeOptionalString(value)?.toLowerCase() ?? null;
  if (normalized === "desktop" || normalized === "cli" || normalized === "server") {
    return normalized;
  }
  return DEFAULT_SPEECH_HOST_MODE;
}

export function resolveDefaultLocalSpeechWhisperModel(env = process.env) {
  const explicitModel = normalizeOptionalString(env.LOCAL_SPEECH_WHISPER_MODEL);
  if (explicitModel) {
    return explicitModel;
  }
  return resolveSpeechHostMode(env.INSTAFY_SPEECH_HOST_MODE) === "desktop"
    ? DEFAULT_DESKTOP_LOCAL_SPEECH_WHISPER_MODEL
    : DEFAULT_LOCAL_SPEECH_WHISPER_MODEL;
}

export function resolveLocalSpeechPort(value = process.env.LOCAL_SPEECH_PORT) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOCAL_SPEECH_PORT;
}

export function buildLocalSpeechServiceBaseUrl({
  host = DEFAULT_LOCAL_SPEECH_HOST,
  port = DEFAULT_LOCAL_SPEECH_PORT,
} = {}) {
  return `http://${host}:${port}`;
}

export function buildLocalSpeechServiceUrls({
  host = DEFAULT_LOCAL_SPEECH_HOST,
  port = DEFAULT_LOCAL_SPEECH_PORT,
} = {}) {
  const baseUrl = buildLocalSpeechServiceBaseUrl({ host, port });
  return {
    baseUrl,
    healthUrl: `${baseUrl}/health`,
    warmupUrl: `${baseUrl}/warmup`,
    voicesUrl: `${baseUrl}/voices`,
    transcriptionUrl: `${baseUrl}/transcribe`,
    synthesisUrl: `${baseUrl}/synthesize`,
  };
}

function resolveLegacySpeechHost(env = process.env) {
  const legacyHost = normalizeOptionalString(env.LOCAL_SPEECH_HOST);
  return legacyHost && legacyHost !== "0.0.0.0" ? legacyHost : null;
}

export function resolveLocalSpeechServiceConfig(env = process.env) {
  const bindHost =
    normalizeOptionalString(env.LOCAL_SPEECH_BIND_HOST) ??
    normalizeOptionalString(env.LOCAL_SPEECH_HOST) ??
    DEFAULT_LOCAL_SPEECH_BIND_HOST;
  const healthHost =
    normalizeOptionalString(env.LOCAL_SPEECH_HEALTH_HOST) ??
    (bindHost === "0.0.0.0" ? DEFAULT_LOCAL_SPEECH_HEALTH_HOST : bindHost);
  const publicHost =
    normalizeOptionalString(env.LOCAL_SPEECH_PUBLIC_HOST) ??
    resolveLegacySpeechHost(env) ??
    (bindHost === "0.0.0.0" ? healthHost : bindHost);
  const port = resolveLocalSpeechPort(env.LOCAL_SPEECH_PORT);
  return {
    hostMode: resolveSpeechHostMode(env.INSTAFY_SPEECH_HOST_MODE),
    host: publicHost,
    bindHost,
    publicHost,
    healthHost,
    port,
    ...buildLocalSpeechServiceUrls({ host: publicHost, port }),
    healthUrl: `${buildLocalSpeechServiceBaseUrl({ host: healthHost, port })}/health`,
  };
}

export function buildLocalSpeechServiceCommand({
  packageDir = frontendPackageDir,
  hostMode = DEFAULT_SPEECH_HOST_MODE,
} = {}) {
  return `pnpm --dir ${packageDir} ${
    hostMode === "server" ? "dev:speech-host:server" : "dev:speech-service"
  }`;
}
