#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createProviderHostClient,
  DEFAULT_PROVIDER_HOST_BASE_URL,
} from "../../provider-client/index.js";
import {
  fetchSpeechServiceHealth,
  getSpeechServiceReadiness,
  waitForSpeechServiceReady,
} from "./shared/speech-service-health.mjs";
import { parseAudioDataUrl, guessAudioFileExtension } from "./shared/audio-artifact.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const frontendRoot = path.join(repoRoot, "packages", "frontend");
const outputDir = path.join(repoRoot, "packages", "frontend", "test-results", "speech-fixtures");
const speechTempRoot = path.join(repoRoot, "tmp", "speech-fixture-check");
const speechFixtureScratchRoot = path.join(speechTempRoot, "fixtures");
const repoOpenAiEnvPath = path.join(repoRoot, ".env.openai");
const providerHostBaseUrl = process.env.INSTAFY_SPEECH_PROVIDER_HOST_URL || DEFAULT_PROVIDER_HOST_BASE_URL;
const speechServiceBaseUrl = process.env.INSTAFY_SPEECH_SERVICE_URL || "http://127.0.0.1:8796";
const fallbackProbeModel = process.env.INSTAFY_SPEECH_FIXTURE_PROBE_MODEL || "openai/whisper-large-v3";
const fallbackProbeLanguage = process.env.INSTAFY_SPEECH_FIXTURE_PROBE_LANGUAGE || "en";
const remoteControlModel =
  process.env.INSTAFY_SPEECH_FIXTURE_REMOTE_CONTROL_MODEL || "gpt-4o-transcribe";
const remoteControlLanguage =
  process.env.INSTAFY_SPEECH_FIXTURE_REMOTE_CONTROL_LANGUAGE || "en";
const fixtureTranscriptionModel =
  process.env.INSTAFY_SPEECH_FIXTURE_TRANSCRIPTION_MODEL ||
  process.env.LOCAL_SPEECH_WHISPER_MODEL ||
  fallbackProbeModel;

const fixtures = [
  { id: "wake-up-nash", text: "Wake up, Nash.", expected: /wake up[\s,]+nash/i },
  { id: "stop-all-motion", text: "Stop all motion.", expected: /stop all motion/i },
  { id: "look-at-me", text: "Look at me.", expected: /look at me/i },
];

function fixtureMatches(id, transcript) {
  const fixture = fixtures.find((entry) => entry.id === id);
  return fixture ? fixture.expected.test(transcript) : false;
}

function isLocalTranscriptionQualityMismatch(entry) {
  return (
    entry.matched === false &&
    entry.audioPath &&
    entry.remoteControl?.ok === true &&
    typeof entry.remoteControl.text === "string" &&
    fixtureMatches(entry.id, entry.remoteControl.text)
  );
}

function isTruthyEnv(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function log(message) {
  console.log(`[speech-fixture-check] ${message}`);
}

async function readEnvFileValue(filePath, key) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.startsWith(`${key}=`)) {
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
  } catch {
    return null;
  }
  return null;
}

async function resolveOpenAiApiKey() {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) {
    return {
      value: envKey,
      source: "OPENAI_API_KEY",
    };
  }
  const envFileKey = await readEnvFileValue(repoOpenAiEnvPath, "OPENAI_API_KEY");
  if (envFileKey) {
    return {
      value: envFileKey,
      source: repoOpenAiEnvPath,
    };
  }
  return null;
}

async function waitForHealthyJson(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
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

async function isHealthy(url) {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function spawnManagedService({ name, command, args, cwd, env, healthUrl }) {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "pipe",
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk.toString("utf8")}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk.toString("utf8")}`);
  });
  await waitForHealthyJson(healthUrl);
  return child;
}

async function ensureSpeechServices() {
  const children = [];
  let speechServiceReady = false;

  let existingPayload = null;
  try {
    existingPayload = await fetchSpeechServiceHealth(`${speechServiceBaseUrl}/health`);
  } catch {
    existingPayload = null;
  }

  if (existingPayload) {
    const readiness = getSpeechServiceReadiness(existingPayload);
    if (readiness.ready) {
      speechServiceReady = true;
    } else if (readiness.transcriptionReady || readiness.synthesisReady) {
      log(
        `Reusing existing speech service in degraded state (transcription=${readiness.transcriptionStatus}, synthesis=${readiness.synthesisStatus})`,
      );
      speechServiceReady = true;
    } else {
      await waitForSpeechServiceReady(`${speechServiceBaseUrl}/health`);
      speechServiceReady = true;
    }
  }

  if (!speechServiceReady) {
    log("Starting local speech service");
    const child = await spawnManagedService({
      name: "local-speech-service",
      command: "node",
      args: ["./scripts/local-speech-service.mjs"],
      cwd: frontendRoot,
      env: {
        INSTAFY_SPEECH_TEMP_ROOT: speechTempRoot,
        LOCAL_SPEECH_WHISPER_MODEL: fixtureTranscriptionModel,
      },
      healthUrl: `${speechServiceBaseUrl}/health`,
    });
    await waitForSpeechServiceReady(`${speechServiceBaseUrl}/health`);
    children.push(child);
  }

  if (!(await isHealthy(`${providerHostBaseUrl}/health`))) {
    log("Starting local provider host");
    children.push(
      await spawnManagedService({
        name: "local-provider-host",
        command: "node",
        args: ["./scripts/local-provider-host.mjs"],
        cwd: frontendRoot,
        env: {
          INSTAFY_SPEECH_TRANSCRIPTION_URL:
            process.env.INSTAFY_SPEECH_TRANSCRIPTION_URL || `${speechServiceBaseUrl}/transcribe`,
          INSTAFY_SPEECH_SYNTHESIS_URL:
            process.env.INSTAFY_SPEECH_SYNTHESIS_URL || `${speechServiceBaseUrl}/synthesize`,
        },
        healthUrl: `${providerHostBaseUrl}/health`,
      }),
    );
  }

  return children;
}

async function stopManagedServices(children) {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) {
            resolve(undefined);
            return;
          }
          child.kill("SIGTERM");
          const timeout = setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
            resolve(undefined);
          }, 2_000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve(undefined);
          });
        }),
    ),
  );
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
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

async function buildAudioDataUrl(filePath, mimeType) {
  const buffer = await fs.readFile(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function writeAudioFixture(filePathBase, audioDataUrl) {
  const { buffer, mimeType } = parseAudioDataUrl(audioDataUrl);
  const ext = guessAudioFileExtension(mimeType, ".bin");
  const outputPath = `${filePathBase}${ext}`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  const wavPath =
    outputPath.toLowerCase() === `${filePathBase}.wav`.toLowerCase()
      ? `${filePathBase}.normalized.wav`
      : `${filePathBase}.wav`;
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    outputPath,
    "-ac",
    "1",
    "-ar",
    "48000",
    "-sample_fmt",
    "s16",
    wavPath,
  ]);
  const wavDataUrl = await buildAudioDataUrl(wavPath, "audio/wav");
  return { outputPath, mimeType, buffer, wavPath, wavDataUrl };
}

async function runDirectTranscriptionProbe({ audioDataUrl, fileName, model, language }) {
  const response = await fetch(`${speechServiceBaseUrl}/transcribe`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audioDataUrl,
      fileName,
      model,
      language,
    }),
  });
  const rawText = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    model,
    language,
    text:
      typeof payload?.text === "string"
        ? payload.text
        : typeof payload?.transcript === "string"
          ? payload.transcript
          : null,
    error: typeof payload?.error === "string" ? payload.error : null,
    payload,
    rawText,
  };
}

async function runRemoteTranscriptionControl({ audioPath, model, language, apiKey }) {
  const formData = new FormData();
  const buffer = await fs.readFile(audioPath);
  formData.append("file", new Blob([buffer], { type: "audio/wav" }), path.basename(audioPath));
  formData.append("model", model);
  if (language) {
    formData.append("language", language);
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  const rawText = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    model,
    language,
    text:
      typeof payload?.text === "string"
        ? payload.text
        : typeof payload?.transcript === "string"
          ? payload.transcript
          : null,
    error:
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.error?.message === "string"
          ? payload.error.message
          : null,
    payload,
    rawText,
  };
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(speechFixtureScratchRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(speechFixtureScratchRoot, "instafy-speech-fixtures-"));
  const children = await ensureSpeechServices();
  const remoteControlApiKey = await resolveOpenAiApiKey();
  const healthPayload = await fetchSpeechServiceHealth(`${speechServiceBaseUrl}/health`);
  const synthesisEngine =
    typeof healthPayload?.synthesis?.engine === "string" ? healthPayload.synthesis.engine : null;
  const transcriptionModel =
    typeof healthPayload?.transcription?.model === "string" ? healthPayload.transcription.model : null;
  const strictMode = isTruthyEnv(process.env.INSTAFY_SPEECH_FIXTURE_STRICT);
  const enforceFixtureRoundtrip = strictMode || synthesisEngine !== "macos_say";
  const providerClient = createProviderHostClient({ baseUrl: providerHostBaseUrl });
  const results = [];
  if (remoteControlApiKey) {
    log(`Remote control transcription enabled via ${remoteControlApiKey.source}`);
  }

  try {
    for (const fixture of fixtures) {
      const basePath = path.join(outputDir, fixture.id);
      let audioDataUrl = null;
      let outputPath = null;
      let wavPath = null;
      let wavDataUrl = null;
      let transcript = "";
      let transcriptPath = null;
      let transcriptRawPath = null;
      let matched = false;
      let errorStage = null;
      let error = null;
      let remoteControl = null;
      let remoteControlPath = null;

      try {
        log(`Synthesizing ${fixture.id}`);
        const synthResult = await providerClient.callProviderTool(
          "speech",
          "instafy.speech.synthesize_speech",
          { text: fixture.text },
        );
        const synthValue = synthResult.value;
        audioDataUrl =
          typeof synthValue?.audioDataUrl === "string"
            ? synthValue.audioDataUrl
            : typeof synthValue?.audio_data_url === "string"
              ? synthValue.audio_data_url
              : null;
        if (!audioDataUrl) {
          throw new Error(`Speech provider did not return audio for ${fixture.id}.`);
        }

        const audioArtifact = await writeAudioFixture(basePath, audioDataUrl);
        outputPath = audioArtifact.outputPath;
        wavPath = audioArtifact.wavPath;
        wavDataUrl = audioArtifact.wavDataUrl;
        log(`Wrote ${outputPath}`);

        const transcribeResult = await providerClient.callProviderTool(
          "speech",
          "instafy.speech.transcribe_audio",
          {
            audioDataUrl: wavDataUrl,
            fileName: path.basename(wavPath),
          },
        );
        transcriptRawPath = path.join(outputDir, `${fixture.id}.json`);
        await fs.writeFile(
          transcriptRawPath,
          `${JSON.stringify(transcribeResult.value ?? null, null, 2)}\n`,
          "utf8",
        );
        transcript =
          typeof transcribeResult.value?.text === "string"
            ? transcribeResult.value.text
            : typeof transcribeResult.value?.transcript === "string"
              ? transcribeResult.value.transcript
              : "";
        transcriptPath = path.join(outputDir, `${fixture.id}.txt`);
        await fs.writeFile(transcriptPath, `${transcript.trim()}\n`, "utf8");
        matched = fixture.expected.test(transcript);
      } catch (cause) {
        errorStage = outputPath ? "transcription" : "synthesis";
        error = cause instanceof Error ? cause.message : String(cause);
        log(`${errorStage} failed for ${fixture.id}: ${error}`);
      }

      let probe = null;
      let probePath = null;
      if ((errorStage === "transcription" || !matched) && synthesisEngine === "macos_say" && wavDataUrl) {
        probe = await runDirectTranscriptionProbe({
          audioDataUrl: wavDataUrl,
          fileName: path.basename(wavPath),
          model: fallbackProbeModel,
          language: fallbackProbeLanguage,
        });
        probePath = path.join(outputDir, `${fixture.id}.probe.json`);
        await fs.writeFile(probePath, `${JSON.stringify(probe, null, 2)}\n`, "utf8");
      }
      if ((errorStage === "transcription" || !matched) && remoteControlApiKey && outputPath) {
        remoteControl = await runRemoteTranscriptionControl({
          audioPath: outputPath,
          model: remoteControlModel,
          language: remoteControlLanguage,
          apiKey: remoteControlApiKey.value,
        });
        remoteControlPath = path.join(outputDir, `${fixture.id}.control.json`);
        await fs.writeFile(remoteControlPath, `${JSON.stringify(remoteControl, null, 2)}\n`, "utf8");
      }
      results.push({
        id: fixture.id,
        text: fixture.text,
        transcript,
        expected: String(fixture.expected),
        matched,
        audioPath: outputPath,
        wavPath,
        transcriptPath,
        transcriptRawPath,
        errorStage,
        error,
        probePath,
        probe,
        remoteControlPath,
        remoteControl,
      });
      if (matched) {
        log(`Transcript ok for ${fixture.id}: ${transcript.trim()}`);
      } else if (error) {
        log(`Fixture failed for ${fixture.id}: ${errorStage} -> ${error}`);
        if (remoteControl) {
          log(
            `Remote ${remoteControl.model}/${remoteControl.language} control for ${fixture.id}: ${
              remoteControl.text
                ? JSON.stringify(remoteControl.text)
                : remoteControl.error
                  ? `error=${remoteControl.error}`
                  : `status=${remoteControl.status}`
            }`,
          );
        }
      } else {
        log(
          `Transcript mismatch for ${fixture.id}: ${JSON.stringify(transcript)} (expected ${fixture.expected})`,
        );
        if (probe) {
          log(
            `Direct ${probe.model}/${probe.language} probe for ${fixture.id}: ${
              probe.text ? JSON.stringify(probe.text) : probe.error ? `error=${probe.error}` : `status=${probe.status}`
            }`,
          );
        }
        if (remoteControl) {
          log(
            `Remote ${remoteControl.model}/${remoteControl.language} control for ${fixture.id}: ${
              remoteControl.text
                ? JSON.stringify(remoteControl.text)
                : remoteControl.error
                  ? `error=${remoteControl.error}`
                  : `status=${remoteControl.status}`
            }`,
          );
        }
      }
    }

    const failures = results.filter((entry) => !entry.matched);
    const localTranscriptionQualityMismatch = failures.some((entry) =>
      isLocalTranscriptionQualityMismatch(entry),
    );
    let guidance = null;
    if (failures.length === 0) {
      guidance = null;
    } else if (
      failures.some((entry) => entry.errorStage === "synthesis") &&
      synthesisEngine === "proxy"
    ) {
      guidance =
        "The configured HTTP synthesis backend failed before any transcription roundtrip could be checked. Inspect the per-fixture error fields and the speech bootstrap check output for the backend probe result.";
    } else if (localTranscriptionQualityMismatch) {
      guidance = enforceFixtureRoundtrip
        ? "The synthesized audio is intelligible and the remote transcription control matched, but the local Whisper lane still misread the same fixtures. Investigate the local transcription model/device/runtime rather than the HTTP TTS backend."
        : "Speech fixture mismatches are currently coming from the local Whisper lane, not from the synthesized audio itself. The remote transcription control matched these fixtures.";
    } else if (!enforceFixtureRoundtrip) {
      guidance =
        "Speech fixture mismatches are informational while the local speech service is using the macOS say fallback. Configure LOCAL_SPEECH_TTS_BACKEND_URL or set INSTAFY_SPEECH_FIXTURE_STRICT=1 to enforce roundtrip accuracy. For macOS fallback mismatches, inspect the *.probe.json files to compare the normal provider-host result with a direct whisper-large-v3 probe.";
    }

    const summaryPath = path.join(outputDir, "summary.json");
    const summary = {
      status:
        failures.length === 0
          ? "passed"
          : enforceFixtureRoundtrip
            ? "failed"
            : "informational_mismatch",
      strictMode,
      enforceFixtureRoundtrip,
      speechService: {
        baseUrl: speechServiceBaseUrl,
        synthesisEngine,
        transcriptionModel,
      },
      failureKinds: Array.from(
        new Set(
          failures.flatMap((entry) => {
            const kinds = [];
            if (entry.errorStage) {
              kinds.push(entry.errorStage);
            } else if (!entry.matched && entry.audioPath) {
              kinds.push("transcription");
            }
            if (isLocalTranscriptionQualityMismatch(entry)) {
              kinds.push("local_transcription_quality");
            }
            return kinds;
          }),
        ),
      ),
      guidance,
      results,
    };
    await fs.writeFile(`${summaryPath}`, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    log(`Speech fixtures written to ${outputDir}`);
    log(`Summary: ${summaryPath}`);

    if (failures.length > 0) {
      const message = `Speech fixture mismatches: ${failures.map((entry) => entry.id).join(", ")}`;
      if (enforceFixtureRoundtrip) {
        throw new Error(message);
      }
      log(`${message} (informational only while synthesis engine=${synthesisEngine ?? "unknown"})`);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await stopManagedServices(children);
  }
}

await main();
