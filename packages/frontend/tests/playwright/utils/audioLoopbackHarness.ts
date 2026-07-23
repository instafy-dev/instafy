import path from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const SWITCH_AUDIO_SOURCE_BIN =
  process.env.INSTAFY_TEST_SWITCH_AUDIO_SOURCE_BIN?.trim() ||
  "/opt/homebrew/bin/SwitchAudioSource";
const FFMPEG_BIN = process.env.INSTAFY_TEST_FFMPEG_BIN?.trim() || "ffmpeg";
const FFPROBE_BIN = process.env.INSTAFY_TEST_FFPROBE_BIN?.trim() || "ffprobe";
const DEFAULT_LOOPBACK_DEVICE_NAME =
  process.env.INSTAFY_TEST_AUDIO_LOOPBACK_DEVICE?.trim() || "BlackHole 2ch";
const LOOPBACK_CAPTURE_ENABLED =
  process.env.INSTAFY_TEST_AUDIO_LOOPBACK === "1" ||
  process.env.INSTAFY_TEST_AUDIO_LOOPBACK === "true";
const LOOPBACK_CAPTURE_MIN_DURATION_SECONDS = Number.parseFloat(
  process.env.INSTAFY_TEST_AUDIO_LOOPBACK_MIN_DURATION_SECONDS?.trim() || "0.4",
);
const LOOPBACK_CAPTURE_MIN_MAX_DB = Number.parseFloat(
  process.env.INSTAFY_TEST_AUDIO_LOOPBACK_MIN_MAX_DB?.trim() || "-55",
);

type SwitchAudioSourceDevice = {
  name: string;
  type: string;
  id?: string;
  uid?: string;
};

export type AudioLoopbackCaptureResult = {
  capturePath: string;
  durationSeconds: number | null;
  maxVolumeDb: number | null;
  meanVolumeDb: number | null;
};

export type AudioLoopbackCaptureHandle = {
  capturePath: string;
  inputDeviceName: string;
  outputDeviceName: string;
  stop: () => Promise<AudioLoopbackCaptureResult>;
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

function parseDeviceJsonLines(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SwitchAudioSourceDevice);
}

function parseVolumeDb(value: string | undefined) {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "-inf") {
    return Number.NEGATIVE_INFINITY;
  }
  const numeric = Number.parseFloat(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

async function listAudioSources(type: "input" | "output") {
  const { stdout } = await execFileAsync(SWITCH_AUDIO_SOURCE_BIN, ["-a", "-t", type, "-f", "json"]);
  return parseDeviceJsonLines(stdout);
}

async function readCurrentOutputSource() {
  const { stdout } = await execFileAsync(SWITCH_AUDIO_SOURCE_BIN, ["-c", "-t", "output", "-f", "json"]);
  const [device] = parseDeviceJsonLines(stdout);
  return device ?? null;
}

async function setCurrentOutputSource(deviceName: string) {
  await execFileAsync(SWITCH_AUDIO_SOURCE_BIN, ["-t", "output", "-s", deviceName]);
}

async function probeAudioFile(filePath: string) {
  const { stdout } = await execFileAsync(FFPROBE_BIN, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
  };
  return parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : null;
}

async function analyzeCapturedAudio(filePath: string): Promise<AudioLoopbackCaptureResult> {
  const durationSeconds = await probeAudioFile(filePath).catch(() => null);
  const { stderr } = await execFileAsync(FFMPEG_BIN, [
    "-hide_banner",
    "-i",
    filePath,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const maxMatch = stderr.match(/max_volume:\s*([-\w.]+)\s*dB/i);
  const meanMatch = stderr.match(/mean_volume:\s*([-\w.]+)\s*dB/i);
  return {
    capturePath: filePath,
    durationSeconds,
    maxVolumeDb: parseVolumeDb(maxMatch?.[1]),
    meanVolumeDb: parseVolumeDb(meanMatch?.[1]),
  };
}

function createUnavailableError(message: string) {
  return new Error(`Audio loopback unavailable: ${message}`);
}

export function audioLoopbackTestingEnabled() {
  return LOOPBACK_CAPTURE_ENABLED;
}

export function assertAudioLoopbackCaptureLooksValid(result: AudioLoopbackCaptureResult) {
  if ((result.durationSeconds ?? 0) < LOOPBACK_CAPTURE_MIN_DURATION_SECONDS) {
    throw new Error(
      `Audio loopback capture was too short (${result.durationSeconds ?? 0}s < ${LOOPBACK_CAPTURE_MIN_DURATION_SECONDS}s).`,
    );
  }
  if ((result.maxVolumeDb ?? Number.NEGATIVE_INFINITY) < LOOPBACK_CAPTURE_MIN_MAX_DB) {
    throw new Error(
      `Audio loopback capture looked silent (max ${result.maxVolumeDb ?? Number.NEGATIVE_INFINITY} dB < ${LOOPBACK_CAPTURE_MIN_MAX_DB} dB).`,
    );
  }
}

export async function startAudioLoopbackCaptureIfEnabled(options: {
  outputDir: string;
  filePrefix: string;
}): Promise<AudioLoopbackCaptureHandle | null> {
  if (!LOOPBACK_CAPTURE_ENABLED) {
    return null;
  }

  const outputSources = await listAudioSources("output").catch(() => []);
  const inputSources = await listAudioSources("input").catch(() => []);
  const outputDevice = outputSources.find((device) => device.name === DEFAULT_LOOPBACK_DEVICE_NAME) ?? null;
  const inputDevice = inputSources.find((device) => device.name === DEFAULT_LOOPBACK_DEVICE_NAME) ?? null;
  if (!outputDevice || !inputDevice) {
    throw createUnavailableError(
      `Expected input/output device "${DEFAULT_LOOPBACK_DEVICE_NAME}" was not found. Install BlackHole and reboot.`,
    );
  }

  const previousOutput = await readCurrentOutputSource();
  if (!previousOutput?.name) {
    throw createUnavailableError("Could not determine the current macOS output source.");
  }

  await setCurrentOutputSource(outputDevice.name);

  const capturePath = path.join(options.outputDir, `${options.filePrefix}-loopback.wav`);
  const child = spawn(
    FFMPEG_BIN,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "avfoundation",
      "-i",
      `:${inputDevice.name}`,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      capturePath,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const closePromise = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 255) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg loopback capture failed (${code ?? "unknown"}): ${stderr.trim()}`));
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 400));

  let stopPromise: Promise<AudioLoopbackCaptureResult> | null = null;
  const stop = async () => {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = (async () => {
      try {
        if (!child.killed) {
          child.kill("SIGINT");
        }
        await closePromise;
      } finally {
        await setCurrentOutputSource(previousOutput.name).catch(() => undefined);
      }
      return await analyzeCapturedAudio(capturePath);
    })();
    return stopPromise;
  };

  return {
    capturePath,
    inputDeviceName: inputDevice.name,
    outputDeviceName: outputDevice.name,
    stop,
  };
}
