import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Browser, Page } from "@playwright/test";
import {
  createProviderHostClient,
  DEFAULT_PROVIDER_HOST_BASE_URL,
} from "../../../../provider-client/index.js";

export const DEFAULT_SPEECH_SERVICE_BASE_URL = "http://127.0.0.1:8796";
export const SPEECH_TOOL_ENDPOINT_PATH = "/providers/speech/tools/call";

export type SpeechToolCall = {
  kind: "request" | "response";
  name: string;
  body?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
};

export type ManagedService = {
  name: string;
  child: ChildProcessWithoutNullStreams;
};

type HostedVoiceCaptureTestOptions = {
  audioDataUrl: string;
  fileName?: string;
  readyDelayMs?: number;
  finalDelayMs?: number;
  transcriptText?: string;
  timeoutMs?: number;
};

function execFileAsync(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

function resolveFrontendRoot(candidateRoot: string) {
  const normalized = path.resolve(candidateRoot);
  if (normalized.endsWith(`${path.sep}packages${path.sep}frontend`)) {
    return normalized;
  }
  return path.join(normalized, "packages", "frontend");
}

export function resolveStableSpeechTempRoot(repoRoot: string) {
  return path.join(path.resolve(repoRoot), "tmp", "playwright-speech");
}

export async function createStableSpeechTempDir(options: {
  repoRoot: string;
  prefix: string;
}) {
  const tempRoot = resolveStableSpeechTempRoot(options.repoRoot);
  await fs.mkdir(tempRoot, { recursive: true });
  return await fs.mkdtemp(path.join(tempRoot, `${options.prefix}-`));
}

export async function buildStableSpeechBrowserEnv(repoRoot: string) {
  const tempRoot = resolveStableSpeechTempRoot(repoRoot);
  await fs.mkdir(tempRoot, { recursive: true });
  return {
    ...process.env,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
  };
}

export function parseDataUrl(dataUrl: string) {
  if (!dataUrl.startsWith("data:")) {
    throw new Error("Expected a data URL.");
  }
  const separatorIndex = dataUrl.indexOf(",");
  if (separatorIndex <= 0) {
    throw new Error("Invalid data URL payload.");
  }
  const header = dataUrl.slice(5, separatorIndex);
  const payload = dataUrl.slice(separatorIndex + 1);
  const isBase64 = header.endsWith(";base64");
  const mimeType = (isBase64 ? header.slice(0, -7) : header).trim() || "application/octet-stream";
  const buffer = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  return {
    mimeType,
    buffer,
  };
}

export function guessExtensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("aiff")) {
    return ".aiff";
  }
  if (normalized.includes("wav")) {
    return ".wav";
  }
  if (normalized.includes("mpeg")) {
    return ".mp3";
  }
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("mp4")) {
    return ".m4a";
  }
  return ".bin";
}

export async function runCommand(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "unknown"}): ${stderr.trim()}`));
    });
  });
}

export async function probeAudioFile(filePath: string) {
  return await new Promise<{ durationSeconds: number | null; streams: number }>((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-show_streams",
        "-of",
        "json",
        filePath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed (${code ?? "unknown"}): ${stderr.trim()}`));
        return;
      }
      const parsed = JSON.parse(stdout) as {
        format?: { duration?: string };
        streams?: unknown[];
      };
      resolve({
        durationSeconds: parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : null,
        streams: Array.isArray(parsed.streams) ? parsed.streams.length : 0,
      });
    });
  });
}

export async function waitForHealthyJson(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "GET",
      });
      if (response.ok) {
        return await response.json();
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function isHealthy(url: string) {
  try {
    const response = await fetch(url, {
      method: "GET",
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchSpeechServiceHealth(url: string) {
  const response = await fetch(url, {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`Speech service health probe failed (${response.status} ${response.statusText}).`);
  }
  const payload = await response.json();
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

function getSpeechServiceReadiness(payload: Record<string, unknown>) {
  const transcription =
    payload.transcription && typeof payload.transcription === "object"
      ? payload.transcription as Record<string, unknown>
      : null;
  const synthesis =
    payload.synthesis && typeof payload.synthesis === "object"
      ? payload.synthesis as Record<string, unknown>
      : null;
  return {
    ready: transcription?.ready === true && synthesis?.ready === true,
    transcriptionStatus:
      typeof transcription?.status === "string" ? transcription.status : "unknown",
    synthesisStatus:
      typeof synthesis?.status === "string" ? synthesis.status : "unknown",
    lastError:
      typeof transcription?.lastError === "string" && transcription.lastError.trim().length > 0
        ? transcription.lastError.trim()
        : typeof synthesis?.lastError === "string" && synthesis.lastError.trim().length > 0
          ? synthesis.lastError.trim()
          : null,
  };
}

async function waitForSpeechServiceReady(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const payload = await fetchSpeechServiceHealth(url);
      const readiness = getSpeechServiceReadiness(payload);
      if (readiness.ready) {
        return payload;
      }
      lastError = readiness.lastError ??
        `transcription=${readiness.transcriptionStatus}, synthesis=${readiness.synthesisStatus}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for speech service readiness at ${url}: ${lastError}`);
}

async function describeListeningProcess(port: string) {
  try {
    const { stdout: lsofStdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    const pidLine = lsofStdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("p"));
    if (!pidLine) {
      return null;
    }
    const pid = Number.parseInt(pidLine.slice(1), 10);
    if (!Number.isFinite(pid)) {
      return null;
    }
    const { stdout: psStdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    return {
      pid,
      command: psStdout.trim(),
    };
  } catch {
    return null;
  }
}

function isStaleSpeechReadiness(readiness: ReturnType<typeof getSpeechServiceReadiness>) {
  const lastError = readiness.lastError ?? "";
  return (
    lastError.includes("ENOENT") &&
    lastError.includes(`${path.sep}tmp${path.sep}`) &&
    lastError.includes("automation-browsers")
  );
}

async function recycleStaleSpeechService(port: string) {
  const listeningProcess = await describeListeningProcess(port);
  if (!listeningProcess || !listeningProcess.command.includes("local-speech-service.mjs")) {
    return false;
  }
  try {
    process.kill(listeningProcess.pid, "SIGTERM");
  } catch {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return true;
}

async function spawnManagedService(options: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  healthUrl: string;
}) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdio: "pipe",
  });
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${options.name}] ${chunk.toString("utf8")}`);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(`[${options.name}] ${text}`);
  });
  try {
    await waitForHealthyJson(options.healthUrl, 30_000);
    return {
      name: options.name,
      child,
    } satisfies ManagedService;
  } catch (error) {
    const details = stderr.trim();
    if (details.includes("EADDRINUSE")) {
      await waitForHealthyJson(options.healthUrl, 30_000);
      return null;
    }
    throw error;
  }
}

export async function ensureSpeechServices(repoRoot: string) {
  const managed: ManagedService[] = [];
  const frontendRoot = resolveFrontendRoot(repoRoot);
  const speechServicePort = new URL(DEFAULT_SPEECH_SERVICE_BASE_URL).port || "8796";
  const speechTempRoot = path.join(repoRoot, "tmp", "playwright-local-speech");

  let speechServiceReady = false;
  let speechServiceReachable = false;
  let speechServicePayload: Record<string, unknown> | null = null;
  try {
    const payload = await fetchSpeechServiceHealth(`${DEFAULT_SPEECH_SERVICE_BASE_URL}/health`);
    speechServicePayload = payload;
    speechServiceReachable = true;
    const readiness = getSpeechServiceReadiness(payload);
    speechServiceReady = readiness.ready;
  } catch {
    speechServiceReady = false;
    speechServiceReachable = false;
  }

  if (speechServiceReachable && !speechServiceReady) {
    const readiness = speechServicePayload ? getSpeechServiceReadiness(speechServicePayload) : null;
    if (readiness && isStaleSpeechReadiness(readiness)) {
      if (await recycleStaleSpeechService(speechServicePort)) {
        speechServiceReachable = false;
        speechServicePayload = null;
      }
    }
  }

  if (speechServiceReachable && !speechServiceReady) {
    try {
      await waitForSpeechServiceReady(`${DEFAULT_SPEECH_SERVICE_BASE_URL}/health`, 30_000);
      speechServiceReady = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT") && message.includes("automation-browsers")) {
        if (await recycleStaleSpeechService(speechServicePort)) {
          speechServiceReachable = false;
          speechServicePayload = null;
        }
      } else {
        throw error;
      }
    }
  }

  if (!speechServiceReachable) {
    const speechService = await spawnManagedService({
      name: "local-speech-service",
      command: "node",
      args: ["./scripts/local-speech-service.mjs"],
      cwd: frontendRoot,
      env: {
        INSTAFY_SPEECH_TEMP_ROOT: speechTempRoot,
        LOCAL_SPEECH_WHISPER_MODEL: process.env.LOCAL_SPEECH_WHISPER_MODEL || "openai/whisper-small",
      },
      healthUrl: `${DEFAULT_SPEECH_SERVICE_BASE_URL}/health`,
    });
    if (speechService) {
      managed.push(speechService);
    }
    await waitForSpeechServiceReady(`${DEFAULT_SPEECH_SERVICE_BASE_URL}/health`, 30_000);
    speechServiceReachable = true;
    speechServiceReady = true;
  }

  if (!speechServiceReady) {
    throw new Error(
      `Speech service on ${DEFAULT_SPEECH_SERVICE_BASE_URL} is reachable but not ready for transcription.`
    );
  }

  if (!(await isHealthy(`${DEFAULT_PROVIDER_HOST_BASE_URL}/health`))) {
    const providerHost = await spawnManagedService({
      name: "local-provider-host",
      command: "node",
      args: ["./scripts/local-provider-host.mjs"],
      cwd: frontendRoot,
      env: {
        INSTAFY_SPEECH_TRANSCRIPTION_URL:
          process.env.INSTAFY_SPEECH_TRANSCRIPTION_URL ||
          `${DEFAULT_SPEECH_SERVICE_BASE_URL}/transcribe`,
        INSTAFY_SPEECH_SYNTHESIS_URL:
          process.env.INSTAFY_SPEECH_SYNTHESIS_URL ||
          `${DEFAULT_SPEECH_SERVICE_BASE_URL}/synthesize`,
      },
      healthUrl: `${DEFAULT_PROVIDER_HOST_BASE_URL}/health`,
    });
    if (providerHost) {
      managed.push(providerHost);
    }
  }

  await waitForHealthyJson(`${DEFAULT_PROVIDER_HOST_BASE_URL}/health`, 30_000);
  return managed;
}

export async function warmSpeechTranscription(options: {
  audioDataUrl: string;
  fileName?: string;
  baseUrl?: string;
}) {
  const providerClient = createProviderHostClient({
    baseUrl: options.baseUrl ?? DEFAULT_PROVIDER_HOST_BASE_URL,
  });
  const startedAt = Date.now();
  const result = await providerClient.callProviderTool(
    "speech",
    "instafy.speech.transcribe_audio",
    {
      audioDataUrl: options.audioDataUrl,
      fileName: options.fileName ?? "speech-smoke-warmup.aiff",
    },
  );
  const value = (result as { value?: Record<string, unknown> }).value;
  const text =
    typeof value?.text === "string"
      ? value.text
      : typeof value?.transcript === "string"
        ? value.transcript
        : null;
  return {
    text,
    durationMs: Date.now() - startedAt,
  };
}

export async function stopManagedServices(services: ManagedService[]) {
  await Promise.all(
    services.map(async (service) => {
      if (service.child.exitCode !== null) {
        return;
      }
      service.child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (service.child.exitCode === null) {
            service.child.kill("SIGKILL");
          }
          resolve(undefined);
        }, 2_000);
        service.child.once("exit", () => {
          clearTimeout(timeout);
          resolve(undefined);
        });
      });
    }),
  );
}

async function raceWithTimeout(task: Promise<unknown>, timeoutMs: number) {
  return await Promise.race([
    task.then(() => "completed"),
    new Promise<"timed_out">((resolve) => {
      setTimeout(() => resolve("timed_out"), timeoutMs);
    }),
  ]);
}

export async function closeManagedBrowser(
  browser: Browser | null | undefined,
  options: {
    label?: string;
    timeoutMs?: number;
  } = {},
) {
  if (!browser) {
    return;
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const label = options.label ?? "managed-browser";
  const contexts = browser.contexts();
  const contextCloseResult = await raceWithTimeout(
    Promise.all(
      contexts.map(async (context) => {
        await context.close().catch(() => {});
      }),
    ),
    timeoutMs,
  );
  if (contextCloseResult === "timed_out") {
    console.warn(`[${label}] Timed out while closing browser contexts.`);
  }
  const browserCloseResult = await raceWithTimeout(
    browser.close().catch(() => {}),
    timeoutMs,
  );
  if (browserCloseResult === "timed_out") {
    console.warn(`[${label}] Timed out while closing browser.`);
  }
}

export async function synthesizeFakeMicAudio(options: {
  outputDir: string;
  promptText: string;
  voice?: string | null;
  filePrefix: string;
  baseUrl?: string;
}) {
  const providerClient = createProviderHostClient({
    baseUrl: options.baseUrl ?? DEFAULT_PROVIDER_HOST_BASE_URL,
  });
  const synthResult = await providerClient.callProviderTool("speech", "instafy.speech.synthesize_speech", {
    text: options.promptText,
    voice: options.voice ?? undefined,
  });
  const value = (synthResult as { value?: Record<string, unknown> }).value;
  const audioDataUrl =
    typeof value?.audioDataUrl === "string"
      ? value.audioDataUrl
      : typeof value?.audio_data_url === "string"
        ? value.audio_data_url
        : null;
  if (!audioDataUrl) {
    throw new Error("Speech provider did not return synthesized audio for the fake microphone input.");
  }
  const { buffer, mimeType } = parseDataUrl(audioDataUrl);
  const sourcePath = path.join(
    options.outputDir,
    `${options.filePrefix}${guessExtensionFromMimeType(mimeType)}`,
  );
  const wavPath = path.join(options.outputDir, `${options.filePrefix}.wav`);
  await fs.writeFile(sourcePath, buffer);
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    sourcePath,
    "-ac",
    "1",
    "-ar",
    "48000",
    "-sample_fmt",
    "s16",
    wavPath,
  ]);
  return {
    audioDataUrl,
    sourcePath,
    wavPath,
  };
}

export function attachSpeechToolCapture(page: Page, speechToolCalls: SpeechToolCall[]) {
  page.on("request", (request) => {
    try {
      const url = new URL(request.url());
      if (request.method() !== "POST" || url.pathname !== SPEECH_TOOL_ENDPOINT_PATH) {
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown> | undefined;
      const name = typeof body?.name === "string" ? body.name : "unknown";
      speechToolCalls.push({
        kind: "request",
        name,
        body: body ?? null,
      });
    } catch {
      // ignore request capture failures
    }
  });
  page.on("response", async (response) => {
    try {
      const url = new URL(response.url());
      if (response.request().method() !== "POST" || url.pathname !== SPEECH_TOOL_ENDPOINT_PATH) {
        return;
      }
      const requestBody = response.request().postDataJSON() as Record<string, unknown> | undefined;
      const name = typeof requestBody?.name === "string" ? requestBody.name : "unknown";
      const body = (await response.json()) as Record<string, unknown>;
      speechToolCalls.push({
        kind: "response",
        name,
        response: body,
      });
    } catch {
      // ignore response capture failures
    }
  });
}

export async function configureHostedVoiceCaptureTest(
  page: Page,
  options: HostedVoiceCaptureTestOptions,
) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  await page.waitForFunction(
    () =>
      typeof (
        window as Window & {
          __INSTAFY_HOSTED_VOICE_CAPTURE_TEST__?: {
            configure?: (config: Record<string, unknown>) => Promise<boolean>;
          };
        }
      ).__INSTAFY_HOSTED_VOICE_CAPTURE_TEST__?.configure === "function",
    undefined,
    {
      timeout: timeoutMs,
    },
  );

  const configured = await page.evaluate(
    async (config) => {
      const helper = (
        window as Window & {
          __INSTAFY_HOSTED_VOICE_CAPTURE_TEST__?: {
            configure?: (options: {
              audioDataUrl: string;
              fileName?: string;
              readyDelayMs?: number;
              finalDelayMs?: number;
            }) => Promise<boolean>;
            clear?: () => Promise<boolean>;
          };
        }
      ).__INSTAFY_HOSTED_VOICE_CAPTURE_TEST__;
      if (!helper?.configure) {
        return false;
      }
      await helper.clear?.();
      return await helper.configure({
        audioDataUrl: config.audioDataUrl,
        fileName: config.fileName,
        readyDelayMs: config.readyDelayMs,
        finalDelayMs: config.finalDelayMs,
        transcriptText: config.transcriptText,
      });
    },
    {
      audioDataUrl: options.audioDataUrl,
      fileName: options.fileName,
      readyDelayMs: options.readyDelayMs,
      finalDelayMs: options.finalDelayMs,
      transcriptText: options.transcriptText,
    },
  );

  if (!configured) {
    throw new Error("Hosted voice capture test helper was unavailable.");
  }
}
