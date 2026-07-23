import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLocalSpeechServiceCommand,
  frontendPackageDir,
  resolveDefaultLocalSpeechWhisperModel,
  resolveLocalSpeechServiceConfig,
} from "./shared/speech-host-config.mjs";
import {
  isOpenAiAudioSpeechUrl,
  resolveTranscriptionBackendConfig,
} from "./shared/openai-speech-backend.mjs";
import {
  buildManagedSpeechRuntimeEnv,
  DEFAULT_MANAGED_IMAGEIO_FFMPEG_VERSION,
  DEFAULT_MANAGED_LIBROSA_VERSION,
  DEFAULT_MANAGED_PYTHON_VERSION,
  DEFAULT_MANAGED_SOUNDFILE_VERSION,
  DEFAULT_MANAGED_SOXR_VERSION,
  DEFAULT_MANAGED_UV_VERSION,
  DEFAULT_MANAGED_WHISPER_PACKAGE_VERSION,
  assertManagedUvInstallerIntegrity,
  ensureManagedSpeechRuntimeCacheDirs,
  pathExists,
  readVerifiedManagedUvInstaller,
  readManagedSpeechToolchainMetadata,
  removeManagedSpeechToolchain,
  resolveManagedSpeechHome,
  resolveManagedSpeechOnly,
  resolveManagedSpeechToolchainPaths,
  resolveManagedSpeechToolchainStatus,
  resolveManagedUvInstallerArtifact,
  writeVerifiedManagedUvInstaller,
  writeManagedSpeechToolchainMetadata,
} from "./shared/speech-managed-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localSpeechServiceScriptPath = path.join(__dirname, "local-speech-service.mjs");
const homeDir = os.homedir();
const commonUserBinDirs = [path.join(homeDir, ".local", "bin")];
const defaultWhisperBin = process.env.LOCAL_SPEECH_WHISPER_BIN || "insanely-fast-whisper";
const defaultWhisperModel = resolveDefaultLocalSpeechWhisperModel(process.env);
const defaultWhisperDeviceId =
  process.env.LOCAL_SPEECH_WHISPER_DEVICE_ID || (process.platform === "darwin" ? "mps" : "0");
const defaultWhisperBatchSize =
  process.env.LOCAL_SPEECH_WHISPER_BATCH_SIZE || (process.platform === "darwin" ? "4" : "24");
const defaultWhisperFlash = process.env.LOCAL_SPEECH_WHISPER_FLASH === "true";
const defaultWhisperLanguage = normalizeOptionalString(process.env.LOCAL_SPEECH_WHISPER_LANGUAGE);
const defaultOpenAiTranscriptionModel =
  normalizeOptionalString(process.env.LOCAL_SPEECH_TRANSCRIPTION_OPENAI_MODEL) ?? "gpt-4o-transcribe";
const managedSpeechHome = resolveManagedSpeechHome(process.env);
const managedSpeechOnly = resolveManagedSpeechOnly(process.env);
const stableSpeechBootstrapTempRoot =
  normalizeOptionalString(process.env.INSTAFY_SPEECH_BOOTSTRAP_TEMP_ROOT) ??
  normalizeOptionalString(process.env.INSTAFY_SPEECH_TEMP_ROOT) ??
  path.join(managedSpeechHome, "tmp", "bootstrap");
const managedUvVersion = process.env.INSTAFY_MANAGED_UV_VERSION || DEFAULT_MANAGED_UV_VERSION;
const managedPythonVersion = process.env.INSTAFY_MANAGED_PYTHON_VERSION || DEFAULT_MANAGED_PYTHON_VERSION;
const managedWhisperVersion =
  process.env.INSTAFY_MANAGED_WHISPER_PACKAGE_VERSION || DEFAULT_MANAGED_WHISPER_PACKAGE_VERSION;
const managedImageioFfmpegVersion =
  process.env.INSTAFY_MANAGED_IMAGEIO_FFMPEG_VERSION || DEFAULT_MANAGED_IMAGEIO_FFMPEG_VERSION;
const managedLibrosaVersion =
  process.env.INSTAFY_MANAGED_LIBROSA_VERSION || DEFAULT_MANAGED_LIBROSA_VERSION;
const managedSoundfileVersion =
  process.env.INSTAFY_MANAGED_SOUNDFILE_VERSION || DEFAULT_MANAGED_SOUNDFILE_VERSION;
const managedSoxrVersion = process.env.INSTAFY_MANAGED_SOXR_VERSION || DEFAULT_MANAGED_SOXR_VERSION;
const managedUvInstallerArtifact = resolveManagedUvInstallerArtifact(
  managedUvVersion,
  process.platform,
);
const configuredBundledUvInstallerPath =
  normalizeOptionalString(process.env.INSTAFY_SPEECH_BUNDLED_UV_INSTALLER_PATH) ?? null;
const bundledUvInstallerPath =
  configuredBundledUvInstallerPath ??
  (managedUvInstallerArtifact
    ? path.join(
        __dirname,
        "vendor",
        "uv",
        managedUvVersion,
        managedUvInstallerArtifact.fileName,
      )
    : null);

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveSynthesisEngine() {
  if (normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_BACKEND_URL)) {
    return "proxy";
  }
  if (process.platform === "darwin") {
    return "mac_say";
  }
  return "unknown";
}

function extractSynthesisProbeDetail(rawText) {
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

function resolveStrictRoundtripSupport(synthesisEngine, backendProbe = null) {
  if (synthesisEngine === "proxy") {
    if (backendProbe?.configured && backendProbe.supported === false) {
      return {
        supported: false,
        reason:
          backendProbe.detail ??
          "The configured HTTP synthesis backend did not accept a probe request, so strict speech-fixture roundtrips are not supported.",
      };
    }
    return {
      supported: true,
      reason: null,
    };
  }
  if (synthesisEngine === "mac_say") {
    return {
      supported: false,
      reason:
        "The host is using the macOS say fallback for synthesis. That is fine for ad-hoc playback, but it is not treated as a strict speech-fixture quality gate.",
    };
  }
  return {
    supported: false,
    reason: "No non-fallback speech synthesis backend is configured.",
  };
}

async function probeConfiguredSynthesisBackend(url) {
  const normalizedUrl = normalizeOptionalString(url);
  if (!normalizedUrl) {
    return {
      configured: false,
      reachable: false,
      supported: false,
      url: null,
      detail: "HTTP synthesis backend is not configured.",
    };
  }

  const timeout = createTimeoutSignal(4_000);
  try {
    const payload = isOpenAiAudioSpeechUrl(normalizedUrl)
      ? {
          model:
            normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_OPENAI_MODEL) ?? "gpt-4o-mini-tts",
          voice:
            normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_OPENAI_VOICE) ?? "cedar",
          input: "Instafy synthesis backend probe.",
          response_format: "wav",
        }
      : {
          text: "Instafy synthesis backend probe.",
          format: "wav",
        };
    const headers = {
      "content-type": "application/json",
    };
    const authToken = normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_BACKEND_TOKEN);
    if (authToken) {
      headers.authorization = `Bearer ${authToken}`;
    }

    const response = await fetch(normalizedUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: timeout.signal,
    });
    const rawText = await response.text();
    const detail = extractSynthesisProbeDetail(rawText);
    return {
      configured: true,
      reachable: response.ok,
      supported: response.ok,
      statusCode: response.status,
      url: normalizedUrl,
      detail: response.ok
        ? "HTTP synthesis backend accepted a probe request."
        : `HTTP synthesis backend probe failed (${response.status})${detail ? `: ${detail}` : "."}`,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      supported: false,
      url: normalizedUrl,
      detail:
        error instanceof Error ? error.message : "HTTP synthesis backend probe failed.",
    };
  } finally {
    timeout.dispose();
  }
}

function describeSpeechBootstrapActor(hostMode) {
  if (hostMode === "desktop") {
    return "Desktop repair";
  }
  if (hostMode === "server") {
    return "Server speech bootstrap";
  }
  return "Speech bootstrap";
}

function summarizeSpeechServiceHealthPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const transcription =
    payload.transcription && typeof payload.transcription === "object"
      ? payload.transcription
      : null;
  const synthesis =
    payload.synthesis && typeof payload.synthesis === "object"
      ? payload.synthesis
      : null;
  const transcriptionStatus = normalizeOptionalString(transcription?.status) ?? null;
  const synthesisStatus = normalizeOptionalString(synthesis?.status) ?? null;
  const failureDetail =
    normalizeOptionalString(transcription?.lastError) ??
    normalizeOptionalString(synthesis?.lastError) ??
    null;

  if (failureDetail) {
    return failureDetail;
  }
  if (transcriptionStatus === "warming") {
    return "Speech transcription is warming up.";
  }
  if (transcriptionStatus && synthesisStatus) {
    return `Speech service status: transcription=${transcriptionStatus}, synthesis=${synthesisStatus}.`;
  }
  return null;
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
    },
  };
}

function createShellCommand(command) {
  return process.platform === "win32" ? ["cmd", ["/c", command]] : ["zsh", ["-lc", command]];
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

function createSilentWavBuffer({ durationMs = 320, sampleRate = 16_000 } = {}) {
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

function buildManagedUvEnv(toolchainPaths, env = process.env) {
  return {
    ...env,
    UV_UNMANAGED_INSTALL: toolchainPaths.binDir,
    UV_PYTHON_INSTALL_DIR: toolchainPaths.pythonInstallDir,
    UV_MANAGED_PYTHON: "1",
    UV_CACHE_DIR: toolchainPaths.uvCacheDir,
    ...buildManagedSpeechRuntimeEnv(env),
  };
}

export function buildManagedUvInstallerEnv(
  toolchainPaths,
  sourceEnv = process.env,
) {
  const env = buildManagedUvEnv(toolchainPaths, sourceEnv);
  for (const name of [
    "INSTALLER_DOWNLOAD_URL",
    "UV_DOWNLOAD_URL",
    "UV_INSTALLER_GHE_BASE_URL",
    "UV_INSTALLER_GITHUB_BASE_URL",
  ]) {
    delete env[name];
  }
  return {
    ...env,
    UV_NO_MODIFY_PATH: "1",
  };
}

async function ensureManagedTranscriptionRuntime({ dryRun, commandsRun }) {
  const toolchainPaths = resolveManagedSpeechToolchainPaths(process.env);
  await fs.mkdir(toolchainPaths.home, { recursive: true });
  await fs.mkdir(toolchainPaths.binDir, { recursive: true });
  await fs.mkdir(toolchainPaths.downloadsDir, { recursive: true });
  await ensureManagedSpeechRuntimeCacheDirs(process.env);
  let installerSource = normalizeOptionalString((await readManagedSpeechToolchainMetadata(process.env))?.uvInstallerSource) ?? null;

  if (!(await pathExists(toolchainPaths.uvPath))) {
    if (!managedUvInstallerArtifact) {
      return {
        ok: false,
        error: `Managed uv ${managedUvVersion} has no source-controlled installer trust anchor. Refusing to download or execute an unverified installer.`,
      };
    }
    const installerUrl = managedUvInstallerArtifact.url;
    const installerCommand = `download ${installerUrl} -> ${toolchainPaths.uvInstallerPath}`;
    commandsRun.push(installerCommand);
    commandsRun.push(
      `verify sha256:${managedUvInstallerArtifact.sha256} ${toolchainPaths.uvInstallerPath}`,
    );
    if (!dryRun) {
      if (!(await pathExists(toolchainPaths.uvInstallerPath))) {
        if (bundledUvInstallerPath && (await pathExists(bundledUvInstallerPath))) {
          let bundledInstallerContent;
          try {
            bundledInstallerContent = await readVerifiedManagedUvInstaller(
              bundledUvInstallerPath,
              managedUvInstallerArtifact,
            );
          } catch (error) {
            return {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Bundled uv installer failed its integrity check.",
            };
          }
          await writeVerifiedManagedUvInstaller(
            toolchainPaths.uvInstallerPath,
            bundledInstallerContent,
            managedUvInstallerArtifact,
          );
          installerSource = "bundled";
          commandsRun.push(`bundle ${bundledUvInstallerPath} -> ${toolchainPaths.uvInstallerPath}`);
        } else {
          const installerResponse = await fetch(installerUrl, {
            headers: {
              "cache-control": "no-store",
            },
          });
          if (!installerResponse.ok) {
            return {
              ok: false,
              error: `Failed to download uv installer (${installerResponse.status}).`,
            };
          }
          const installerContent = Buffer.from(
            await installerResponse.arrayBuffer(),
          );
          try {
            assertManagedUvInstallerIntegrity(
              installerContent,
              managedUvInstallerArtifact,
            );
          } catch (error) {
            return {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Downloaded uv installer failed its integrity check.",
            };
          }
          await writeVerifiedManagedUvInstaller(
            toolchainPaths.uvInstallerPath,
            installerContent,
            managedUvInstallerArtifact,
          );
          installerSource = "downloaded";
        }
      } else {
        try {
          await readVerifiedManagedUvInstaller(
            toolchainPaths.uvInstallerPath,
            managedUvInstallerArtifact,
          );
          installerSource = "cached";
          commandsRun.push(`reuse ${toolchainPaths.uvInstallerPath}`);
        } catch (error) {
          return {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Cached uv installer failed its integrity check.",
          };
        }
      }
      try {
        await readVerifiedManagedUvInstaller(
          toolchainPaths.uvInstallerPath,
          managedUvInstallerArtifact,
        );
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Managed uv installer failed its pre-execution integrity check.",
        };
      }
      const installerInvocation =
        process.platform === "win32"
          ? {
              command: "powershell.exe",
              args: [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                toolchainPaths.uvInstallerPath,
              ],
            }
          : {
              command: "sh",
              args: [toolchainPaths.uvInstallerPath],
            };
      const result = await runCommand(installerInvocation.command, installerInvocation.args, {
        env: buildManagedUvInstallerEnv(toolchainPaths),
      });
      if (!result.ok || !(await pathExists(toolchainPaths.uvPath))) {
        return {
          ok: false,
          error:
            result.stderr.trim() ||
            result.stdout.trim() ||
            "Managed speech install could not install uv into Instafy app data.",
        };
      }
    }
  }

  const installSteps = [];
  if (!(await pathExists(toolchainPaths.pythonPath))) {
    installSteps.push({
      command: toolchainPaths.uvPath,
      args: ["python", "install", managedPythonVersion],
      env: buildManagedUvEnv(toolchainPaths),
    });
    installSteps.push({
      command: toolchainPaths.uvPath,
      args: ["venv", toolchainPaths.venvDir, "--python", managedPythonVersion],
      env: {
        ...buildManagedUvEnv(toolchainPaths),
        // Clean bootstrap and repair paths can leave behind an incomplete venv directory.
        // Clearing it makes the managed install deterministic instead of failing on reuse.
        UV_VENV_CLEAR: "1",
      },
    });
  }
  installSteps.push({
    command: toolchainPaths.uvPath,
    args: [
      "pip",
      "install",
      "--python",
      toolchainPaths.pythonPath,
      "--upgrade",
      `insanely-fast-whisper==${managedWhisperVersion}`,
      `imageio-ffmpeg==${managedImageioFfmpegVersion}`,
      `librosa==${managedLibrosaVersion}`,
      `soundfile==${managedSoundfileVersion}`,
      `soxr==${managedSoxrVersion}`,
    ],
    env: buildManagedUvEnv(toolchainPaths),
  });

  for (const step of installSteps) {
    commandsRun.push(formatManagedCommand(step.command, step.args));
    if (dryRun) {
      continue;
    }
    let result = await runCommand(step.command, step.args, {
      env: step.env ?? process.env,
    });
    if (shouldRetryManagedUvInstallWithoutCache(step, result)) {
      result = await retryManagedInstallStepWithoutCache({
        step,
        toolchainPaths,
        commandsRun,
      });
    }
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.stderr.trim() || result.stdout.trim() || `Managed speech install failed while running ${step.command}.`,
      };
    }
    if (
      step.command === toolchainPaths.uvPath &&
      step.args[0] === "venv" &&
      !(await pathExists(toolchainPaths.pythonPath))
    ) {
      return {
        ok: false,
        error: `Managed speech install created ${toolchainPaths.venvDir}, but ${toolchainPaths.pythonPath} is still missing.`,
      };
    }
  }

  const uninstallTorchcodecArgs = [
    "pip",
    "uninstall",
    "--python",
    toolchainPaths.pythonPath,
    "torchcodec",
  ];
  commandsRun.push(formatManagedCommand(toolchainPaths.uvPath, uninstallTorchcodecArgs));
  if (!dryRun) {
    const uninstallTorchcodec = await runCommand(toolchainPaths.uvPath, uninstallTorchcodecArgs, {
      env: buildManagedUvEnv(toolchainPaths),
    });
    if (!uninstallTorchcodec.ok) {
      return {
        ok: false,
        error:
          uninstallTorchcodec.stderr.trim() ||
          uninstallTorchcodec.stdout.trim() ||
          "Managed speech install could not disable torchcodec.",
      };
    }
  }

  const ffmpegResolveArgs = [
    "-c",
    "import imageio_ffmpeg,sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())",
  ];
  commandsRun.push(formatManagedCommand(toolchainPaths.pythonPath, ffmpegResolveArgs));
  if (!dryRun) {
    const ffmpegResolve = await runCommand(toolchainPaths.pythonPath, ffmpegResolveArgs);
    const resolvedFfmpegPath = normalizeOptionalString(ffmpegResolve.stdout);
    if (!ffmpegResolve.ok || !resolvedFfmpegPath) {
      return {
        ok: false,
        error:
          ffmpegResolve.stderr.trim() ||
          ffmpegResolve.stdout.trim() ||
          "Managed speech install could not resolve the bundled ffmpeg binary.",
      };
    }
    const runtimeVersions = await readManagedSpeechRuntimeVersions({
      pythonPath: toolchainPaths.pythonPath,
      uvPath: toolchainPaths.uvPath,
    });
    await fs.copyFile(resolvedFfmpegPath, toolchainPaths.ffmpegPath);
    await fs.chmod(toolchainPaths.ffmpegPath, 0o755).catch(() => undefined);
    await writeManagedSpeechToolchainMetadata(
      {
        home: toolchainPaths.home,
        uvPath: toolchainPaths.uvPath,
        pythonPath: toolchainPaths.pythonPath,
        whisperPath: toolchainPaths.whisperPath,
        ffmpegPath: toolchainPaths.ffmpegPath,
        pythonInstallDir: toolchainPaths.pythonInstallDir,
        cacheDir: toolchainPaths.cacheDir,
        cacheRootDir: toolchainPaths.cacheRootDir,
        uvCacheDir: toolchainPaths.uvCacheDir,
        runtimeCacheDir: toolchainPaths.runtimeCacheDir,
        huggingfaceHome: toolchainPaths.huggingfaceHome,
        huggingfaceHubCache: toolchainPaths.huggingfaceHubCache,
        transformersCache: toolchainPaths.transformersCache,
        xdgCacheHome: toolchainPaths.xdgCacheHome,
        uvInstallerPath: toolchainPaths.uvInstallerPath,
        uvInstallerSource: installerSource,
        uvInstallerSha256: managedUvInstallerArtifact?.sha256 ?? null,
        uvInstallerUrl: managedUvInstallerArtifact?.url ?? null,
        installedAt: new Date().toISOString(),
        provider: "instafy-managed",
        uvVersion: runtimeVersions.uvVersion ?? managedUvVersion,
        pythonVersion: runtimeVersions.pythonVersion ?? managedPythonVersion,
        whisperVersion: runtimeVersions.whisperVersion ?? managedWhisperVersion,
        imageioFfmpegVersion: runtimeVersions.imageioFfmpegVersion ?? managedImageioFfmpegVersion,
      },
      process.env,
    );

    const prewarmResult = await prewarmManagedSpeechModel({
      dryRun,
      commandsRun,
      toolchainPaths,
    });
    if (!prewarmResult.ok) {
      return prewarmResult;
    }
  }

  return { ok: true };
}

async function removeManagedTranscriptionRuntime({ dryRun, commandsRun }) {
  commandsRun.push(`rm -rf ${managedSpeechHome}`);
  if (!dryRun) {
    await removeManagedSpeechToolchain(process.env);
  }
  return { ok: true };
}

async function resolveCommandInfo(command) {
  const [shell, args] = createShellCommand(`command -v ${command}`);
  const result = await runCommand(shell, args);
  let resolvedPath = result.ok ? normalizeOptionalString(result.stdout) : null;
  if (!resolvedPath) {
    for (const candidateDir of commonUserBinDirs) {
      const candidatePath = path.join(candidateDir, command);
      const candidateExists = await fs
        .access(candidatePath)
        .then(() => true)
        .catch(() => false);
      if (candidateExists) {
        resolvedPath = candidatePath;
        break;
      }
    }
  }
  return {
    command,
    available: Boolean(resolvedPath),
    path: resolvedPath,
  };
}

async function resolvePreferredCommandInfo(command, preferredPaths = []) {
  for (const preferredPath of preferredPaths) {
    if (!preferredPath) {
      continue;
    }
    if (await pathExists(preferredPath)) {
      return {
        command,
        available: true,
        path: preferredPath,
        managed: true,
      };
    }
  }
  if (managedSpeechOnly) {
    return {
      command,
      available: false,
      path: null,
      managed: true,
    };
  }
  const fallback = await resolveCommandInfo(command);
  return {
    ...fallback,
    managed: false,
  };
}

function formatManagedCommand(command, args) {
  return [command, ...args].join(" ");
}

function shouldRetryManagedUvInstallWithoutCache(step, result) {
  if (!step || !Array.isArray(step.args) || step.command == null || !result || result.ok) {
    return false;
  }
  const usesUvPipInstall =
    typeof step.command === "string" &&
    path.basename(step.command) === "uv" &&
    step.args[0] === "pip" &&
    step.args[1] === "install";
  if (!usesUvPipInstall) {
    return false;
  }
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  return (
    output.includes("failed to extract archive") ||
    output.includes("i/o operation failed during extraction") ||
    output.includes("no such file or directory (os error 2)")
  );
}

async function retryManagedInstallStepWithoutCache({ step, toolchainPaths, commandsRun }) {
  commandsRun.push(`rm -rf ${toolchainPaths.uvCacheDir}`);
  await fs.rm(toolchainPaths.uvCacheDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(toolchainPaths.uvCacheDir, { recursive: true });
  commandsRun.push(`retry(no-cache) ${formatManagedCommand(step.command, step.args)}`);
  return await runCommand(step.command, step.args, {
    env: {
      ...(step.env ?? process.env),
      UV_NO_CACHE: "1",
      UV_CACHE_DIR: toolchainPaths.uvCacheDir,
    },
  });
}

async function prewarmManagedSpeechModel({ dryRun, commandsRun, toolchainPaths }) {
  await fs.mkdir(stableSpeechBootstrapTempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(
    path.join(stableSpeechBootstrapTempRoot, "instafy-speech-bootstrap-warmup-"),
  );
  const inputPath = path.join(tempDir, "warmup.wav");
  const outputPath = path.join(tempDir, "warmup.json");

  try {
    await ensureManagedSpeechRuntimeCacheDirs(process.env);
    await fs.writeFile(inputPath, createSilentWavBuffer());

    const args = [
      "--file-name",
      inputPath,
      "--transcript-path",
      outputPath,
      "--device-id",
      defaultWhisperDeviceId,
      "--model-name",
      defaultWhisperModel,
      "--batch-size",
      defaultWhisperBatchSize,
    ];
    if (defaultWhisperFlash) {
      args.push("--flash", "True");
    }
    if (defaultWhisperLanguage) {
      args.push("--language", defaultWhisperLanguage);
    }

    commandsRun.push(formatManagedCommand(toolchainPaths.whisperPath, args));
    if (dryRun) {
      return { ok: true };
    }

    const managedPathEntries = [toolchainPaths.binDir, process.env.PATH].filter(Boolean);
    const result = await runCommand(toolchainPaths.whisperPath, args, {
      env: {
        ...process.env,
        ...buildManagedSpeechRuntimeEnv(process.env),
        PATH: managedPathEntries.join(path.delimiter),
      },
    });
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.stderr.trim() ||
          result.stdout.trim() ||
          "Managed speech install could not prewarm the Whisper model cache.",
      };
    }
    return { ok: true };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readManagedSpeechRuntimeVersions({ pythonPath, uvPath }) {
  const uvVersionResult = await runCommand(uvPath, ["--version"]);
  const uvVersion = normalizeOptionalString(uvVersionResult.stdout)?.split(/\s+/)[1] ?? null;

  const pythonVersionResult = await runCommand(pythonPath, [
    "-c",
    [
      "import importlib.metadata as metadata",
      "import json",
      "import sys",
      "def package_version(name):",
      "    try:",
      "        return metadata.version(name)",
      "    except Exception:",
      "        return None",
      "payload = {",
      '    "pythonVersion": sys.version.split()[0],',
      '    "whisperVersion": package_version("insanely-fast-whisper"),',
      '    "imageioFfmpegVersion": package_version("imageio-ffmpeg"),',
      "}",
      "print(json.dumps(payload))",
    ].join("\n"),
  ]);

  let parsed = null;
  try {
    if (!pythonVersionResult.ok) {
      throw new Error("managed python version probe failed");
    }
    parsed = JSON.parse(pythonVersionResult.stdout);
  } catch {
    parsed = null;
  }

  return {
    uvVersion,
    pythonVersion: normalizeOptionalString(parsed?.pythonVersion),
    whisperVersion: normalizeOptionalString(parsed?.whisperVersion),
    imageioFfmpegVersion: normalizeOptionalString(parsed?.imageioFfmpegVersion),
  };
}

async function probeServiceHealth(url) {
  const normalizedUrl = normalizeOptionalString(url);
  if (!normalizedUrl) {
    return {
      configured: false,
      reachable: false,
      url: null,
      detail: "Speech service URL is not configured.",
      payload: null,
    };
  }

  const timeout = createTimeoutSignal(1500);
  try {
    const response = await fetch(normalizedUrl, {
      method: "GET",
      signal: timeout.signal,
    });
    const payload = response.ok ? await response.json().catch(() => null) : null;
    const payloadDetail = summarizeSpeechServiceHealthPayload(payload);
    return {
      configured: true,
      reachable: response.ok,
      statusCode: response.status,
      url: normalizedUrl,
      detail:
        response.ok
          ? payloadDetail ?? "Speech service is reachable."
          : `Health probe failed (${response.status}).`,
      payload,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      url: normalizedUrl,
      detail: error instanceof Error ? error.message : "Speech service health probe failed.",
      payload: null,
    };
  } finally {
    timeout.dispose();
  }
}

function buildAction(id, label, command, options = {}) {
  return {
    id,
    label,
    command,
    available: options.available !== false,
    required: options.required === true,
    installed: options.installed === true,
    detail: normalizeOptionalString(options.detail),
  };
}

export async function getSpeechBackendDependencyStatus() {
  const localSpeechService = resolveLocalSpeechServiceConfig(process.env);
  const managedToolchain = await resolveManagedSpeechToolchainStatus(process.env);
  const [nodeInfo, pythonInfo, whisperInfo, ffmpegInfo, macSayInfo] =
    await Promise.all([
    resolveCommandInfo(process.execPath),
    resolveCommandInfo("python3"),
    resolvePreferredCommandInfo(defaultWhisperBin, [
      normalizeOptionalString(process.env.LOCAL_SPEECH_WHISPER_BIN),
      managedToolchain.whisperAvailable ? managedToolchain.whisperPath : null,
    ]),
    resolvePreferredCommandInfo("ffmpeg", [
      normalizeOptionalString(process.env.LOCAL_SPEECH_FFMPEG_BIN),
      managedToolchain.ffmpegAvailable ? managedToolchain.ffmpegPath : null,
    ]),
    process.platform === "darwin"
      ? resolveCommandInfo("say")
      : Promise.resolve({
          command: "say",
          available: false,
          path: null,
        }),
    ]);

  const serviceHealth = await probeServiceHealth(
    normalizeOptionalString(process.env.LOCAL_SPEECH_SERVICE_HEALTH_URL) || localSpeechService.healthUrl,
  );

  const transcriptionUrl = normalizeOptionalString(process.env.INSTAFY_SPEECH_TRANSCRIPTION_URL);
  const transcriptionBackend = resolveTranscriptionBackendConfig(process.env);
  const transcriptionBackendUrl = transcriptionBackend.url;
  const synthesisUrl = normalizeOptionalString(process.env.INSTAFY_SPEECH_SYNTHESIS_URL);
  const synthesisBackendUrl = normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_BACKEND_URL);
  const synthesisBackendProbe = await probeConfiguredSynthesisBackend(
    synthesisBackendUrl,
  );
  const localServiceCommand = buildLocalSpeechServiceCommand({
    packageDir: frontendPackageDir,
    hostMode: localSpeechService.hostMode,
  });
  const bootstrapActor = describeSpeechBootstrapActor(localSpeechService.hostMode);
  const localServiceScriptExists = await fs
    .access(localSpeechServiceScriptPath)
    .then(() => true)
    .catch(() => false);

  const transcriptionRuntimeReady = whisperInfo.available && ffmpegInfo.available;
  const transcriptionReady = transcriptionBackendUrl
    ? true
    : transcriptionRuntimeReady && managedToolchain.modelCacheReady;
  const synthesisReady = synthesisBackendUrl
    ? synthesisBackendProbe.supported
    : Boolean(synthesisUrl) || macSayInfo.available;
  const synthesisEngine = resolveSynthesisEngine();
  const strictRoundtrip = resolveStrictRoundtripSupport(synthesisEngine, synthesisBackendProbe);

  const actions = [];
  if (!transcriptionReady) {
    actions.push(
      buildAction("install_transcription", "Install managed transcription runtime", "Instafy-managed speech runtime install", {
        available: true,
        required: true,
        installed: managedToolchain.available,
        detail: "Instafy can install and manage uv, Python, the transcription runtime, the uv package cache, and the first Whisper model warmup in its own speech-host directory.",
      }),
    );
  }
  if (managedToolchain.available) {
    actions.push(
      buildAction("remove_transcription", "Remove downloaded speech runtime", `rm -rf ${managedSpeechHome}`, {
        available: true,
        required: false,
        installed: true,
        detail: "Deletes the Instafy-managed uv, Python, transcription runtime, ffmpeg, and uv cache from the speech-host directory.",
      }),
    );
  }
  if (localServiceScriptExists) {
    actions.push(
      buildAction(
        "start_local_service",
        localSpeechService.hostMode === "server" ? "Start server speech host" : "Start local speech service",
        localServiceCommand,
        {
        required: !serviceHealth.reachable,
        detail:
          localSpeechService.hostMode === "server"
            ? "Runs the shared server-mode host that exposes /transcribe, /synthesize, and the speech provider contract."
            : "Runs the local wrapper that exposes /transcribe and /synthesize for the speech provider.",
      }),
    );
  }

  return {
    supported: process.platform === "darwin" || process.platform === "linux",
    platform: process.platform,
    arch: process.arch,
    localService: {
      scriptPath: localSpeechServiceScriptPath,
      scriptExists: localServiceScriptExists,
      command: localServiceCommand,
      health: serviceHealth,
      defaultUrls: {
        transcription: localSpeechService.transcriptionUrl,
        synthesis: localSpeechService.synthesisUrl,
        health: localSpeechService.healthUrl,
      },
    },
    dependencies: {
      node: {
        available: nodeInfo.available,
        path: nodeInfo.path,
        version: process.version,
      },
      python3: pythonInfo,
      managedRuntime: {
        available: managedToolchain.available,
        home: managedToolchain.home,
        cacheDir: managedToolchain.cacheDir,
        cacheRootDir: managedToolchain.cacheRootDir,
        uvCacheDir: managedToolchain.uvCacheDir,
        runtimeCacheDir: managedToolchain.runtimeCacheDir,
        huggingfaceHome: managedToolchain.huggingfaceHome,
        huggingfaceHubCache: managedToolchain.huggingfaceHubCache,
        transformersCache: managedToolchain.transformersCache,
        xdgCacheHome: managedToolchain.xdgCacheHome,
        modelCacheReady: managedToolchain.modelCacheReady,
        uvInstallerPath: managedToolchain.uvInstallerPath,
        uvInstallerSource: normalizeOptionalString(managedToolchain.metadata?.uvInstallerSource),
        uvPath: managedToolchain.uvAvailable ? managedToolchain.uvPath : null,
        pythonPath: managedToolchain.pythonAvailable ? managedToolchain.pythonPath : null,
        whisperPath: managedToolchain.whisperAvailable ? managedToolchain.whisperPath : null,
        ffmpegPath: managedToolchain.ffmpegAvailable ? managedToolchain.ffmpegPath : null,
        installedAt: normalizeOptionalString(managedToolchain.metadata?.installedAt),
        uvVersion: normalizeOptionalString(managedToolchain.metadata?.uvVersion),
        pythonVersion: normalizeOptionalString(managedToolchain.metadata?.pythonVersion),
        whisperVersion: normalizeOptionalString(managedToolchain.metadata?.whisperVersion),
        imageioFfmpegVersion: normalizeOptionalString(managedToolchain.metadata?.imageioFfmpegVersion),
      },
      whisper: {
        command: defaultWhisperBin,
        available: whisperInfo.available,
        path: whisperInfo.path,
        managed: whisperInfo.managed,
      },
      ffmpeg: {
        command: "ffmpeg",
        available: ffmpegInfo.available,
        path: ffmpegInfo.path,
        managed: ffmpegInfo.managed,
      },
      macSay: {
        command: "say",
        available: macSayInfo.available,
        path: macSayInfo.path,
      },
    },
    transcription: {
      configured: Boolean(transcriptionUrl) || Boolean(transcriptionBackendUrl),
      url: transcriptionUrl ?? transcriptionBackendUrl,
      ready: transcriptionReady,
      engine: transcriptionBackendUrl ? "proxy" : "insanely-fast-whisper",
      model: transcriptionBackendUrl ? defaultOpenAiTranscriptionModel : defaultWhisperModel,
      deviceId: transcriptionBackendUrl ? null : defaultWhisperDeviceId,
      installState: transcriptionReady
        ? "ready"
        : transcriptionBackendUrl
          ? "backend_probe_failed"
        : !managedToolchain.uvAvailable
          ? "needs_uv"
          : !managedToolchain.pythonAvailable
            ? "needs_python"
          : !whisperInfo.available
            ? "needs_install"
          : !ffmpegInfo.available
            ? "missing_ffmpeg"
            : "needs_model_cache",
    },
    synthesis: {
      configured: Boolean(synthesisUrl) || Boolean(synthesisBackendUrl),
      url: synthesisUrl ?? synthesisBackendUrl,
      ready: synthesisReady,
      engine: synthesisEngine,
      defaultVoice: normalizeOptionalString(process.env.LOCAL_SPEECH_TTS_SAY_VOICE),
      installState: synthesisReady
        ? "ready"
        : synthesisBackendUrl
          ? "backend_probe_failed"
          : "not_configured",
      strictRoundtripSupported: strictRoundtrip.supported,
      strictRoundtripReason: strictRoundtrip.reason,
      backendProbe: synthesisBackendProbe,
    },
    nextSteps: [
      !managedToolchain.uvAvailable
        ? `${bootstrapActor} will install uv ${managedUvVersion} into ${managedSpeechHome}.`
        : null,
      !managedToolchain.pythonAvailable
        ? `${bootstrapActor} will install managed Python ${managedPythonVersion} into ${managedSpeechHome}.`
        : null,
      !transcriptionRuntimeReady
        ? `Run the managed speech bootstrap to install transcription tools under ${managedSpeechHome}.`
        : null,
      managedToolchain.available && !managedToolchain.modelCacheReady
        ? `The first successful transcription warmup will cache the Whisper model under ${managedToolchain.huggingfaceHubCache}.`
        : null,
      !serviceHealth.reachable
        ? localSpeechService.hostMode === "server"
          ? `Start the shared server speech host with \`${localServiceCommand}\`.`
          : `Start the local speech service with \`${localServiceCommand}\`.`
        : null,
      !transcriptionUrl && !transcriptionBackendUrl
        ? `Set INSTAFY_SPEECH_TRANSCRIPTION_URL=${localSpeechService.transcriptionUrl}.`
        : null,
      !synthesisUrl ? `Set INSTAFY_SPEECH_SYNTHESIS_URL=${localSpeechService.synthesisUrl}.` : null,
      synthesisEngine === "proxy" && synthesisBackendProbe.configured && synthesisBackendProbe.supported === false
        ? `Fix or replace LOCAL_SPEECH_TTS_BACKEND_URL (${synthesisBackendProbe.url}) before treating speech fixtures as a strict quality gate. ${synthesisBackendProbe.detail}`
        : null,
      !strictRoundtrip.supported && synthesisEngine !== "proxy"
        ? "Configure LOCAL_SPEECH_TTS_BACKEND_URL to a real HTTP synthesis backend before using speech fixtures as a strict quality gate."
        : null,
    ].filter(Boolean),
    actions,
  };
}

function createBootstrapResult(status, extra = {}) {
  return {
    ok: true,
    action: extra.action ?? "check",
    dryRun: extra.dryRun === true,
    commandsRun: extra.commandsRun ?? [],
    status,
  };
}

export async function runSpeechBackendBootstrap({
  action = "check",
  dryRun = false,
} = {}) {
  const commandsRun = [];
  const initialStatus = await getSpeechBackendDependencyStatus();

  if (action === "check") {
    return createBootstrapResult(initialStatus, { action, dryRun, commandsRun });
  }

  if (action !== "install_transcription" && action !== "remove_transcription") {
    return {
      ok: false,
      action,
      dryRun,
      error: `Unsupported speech bootstrap action: ${action}`,
      status: initialStatus,
    };
  }

  const managedRuntimeAction =
    action === "install_transcription"
      ? await ensureManagedTranscriptionRuntime({
          dryRun,
          commandsRun,
        })
      : await removeManagedTranscriptionRuntime({
          dryRun,
          commandsRun,
        });
  if (!managedRuntimeAction.ok) {
    return {
      ok: false,
      action,
      dryRun,
      commandsRun,
      error:
        managedRuntimeAction.error ??
        (action === "remove_transcription"
          ? "Managed speech runtime removal failed."
          : "Managed speech runtime install failed."),
      status: await getSpeechBackendDependencyStatus(),
    };
  }

  return createBootstrapResult(await getSpeechBackendDependencyStatus(), {
    action,
    dryRun,
    commandsRun,
  });
}
