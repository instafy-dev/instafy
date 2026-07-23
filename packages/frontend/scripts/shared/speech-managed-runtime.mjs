import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "./audio-artifact.mjs";

const DEFAULT_MANAGED_SPEECH_HOME = path.join(os.homedir(), ".instafy", "speech-host");
export const DEFAULT_MANAGED_UV_VERSION = "0.11.6";
const MANAGED_UV_INSTALLER_RELEASE_ROOT =
  "https://github.com/astral-sh/uv/releases/download";
// These digests come from the official GitHub asset metadata for uv's immutable
// 0.11.6 release. A version bump must add reviewed upstream asset digests here;
// an environment override alone can never authorize new installer bytes.
const MANAGED_UV_INSTALLER_ARTIFACTS = Object.freeze({
  "0.11.6": Object.freeze({
    posix: Object.freeze({
      fileName: "install.sh",
      releaseFileName: "uv-installer.sh",
      sha256: "02f6fdf8077f97f7bbd901de06054a65e7aefbd54432c8a83784d42a3e360a45",
    }),
    win32: Object.freeze({
      fileName: "install.ps1",
      releaseFileName: "uv-installer.ps1",
      sha256: "46da9313591884d09aa4f06f7f78f74154ea01a8012d425ed090163d4799295c",
    }),
  }),
});
export const DEFAULT_MANAGED_PYTHON_VERSION = "3.12";
export const DEFAULT_MANAGED_WHISPER_PACKAGE_VERSION = "0.0.15";
export const DEFAULT_MANAGED_IMAGEIO_FFMPEG_VERSION = "0.6.0";
export const DEFAULT_MANAGED_LIBROSA_VERSION = "0.11.0";
export const DEFAULT_MANAGED_SOUNDFILE_VERSION = "0.13.1";
export const DEFAULT_MANAGED_SOXR_VERSION = "1.0.0";

function isWindows() {
  return process.platform === "win32";
}

function normalizeManagedUvVersion(value) {
  return normalizeOptionalString(value);
}

function normalizeManagedUvPlatform(platform) {
  return platform === "win32" ? "win32" : "posix";
}

export function listManagedUvInstallerArtifacts(
  version = DEFAULT_MANAGED_UV_VERSION,
) {
  const normalizedVersion = normalizeManagedUvVersion(version);
  const release = normalizedVersion
    ? MANAGED_UV_INSTALLER_ARTIFACTS[normalizedVersion]
    : null;
  if (!release) {
    return [];
  }
  return Object.entries(release).map(([platform, artifact]) =>
    Object.freeze({
      ...artifact,
      platform,
      version: normalizedVersion,
      url: `${MANAGED_UV_INSTALLER_RELEASE_ROOT}/${normalizedVersion}/${artifact.releaseFileName}`,
    }),
  );
}

export function resolveManagedUvInstallerArtifact(
  version = DEFAULT_MANAGED_UV_VERSION,
  platform = process.platform,
) {
  const normalizedPlatform = normalizeManagedUvPlatform(platform);
  return (
    listManagedUvInstallerArtifacts(version).find(
      (artifact) => artifact.platform === normalizedPlatform,
    ) ?? null
  );
}

export function calculateManagedUvInstallerSha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function assertManagedUvInstallerIntegrity(content, artifact) {
  if (
    !artifact ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256)
  ) {
    throw new Error(
      "Managed uv installer has no source-controlled SHA-256 trust anchor.",
    );
  }
  const actualSha256 = calculateManagedUvInstallerSha256(content);
  if (actualSha256 !== artifact.sha256) {
    throw new Error(
      `Managed uv installer integrity check failed for ${artifact.url ?? artifact.fileName ?? "unknown source"}: expected sha256:${artifact.sha256}, received sha256:${actualSha256}.`,
    );
  }
  return actualSha256;
}

export async function readVerifiedManagedUvInstaller(filePath, artifact) {
  const content = await fs.readFile(filePath);
  assertManagedUvInstallerIntegrity(content, artifact);
  return content;
}

export async function writeVerifiedManagedUvInstaller(
  filePath,
  content,
  artifact,
) {
  const sha256 = assertManagedUvInstallerIntegrity(content, artifact);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, content, {
      flag: "wx",
      mode: 0o755,
    });
    await fs.rename(temporaryPath, filePath).catch(async (error) => {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) {
        throw error;
      }
      await fs.rm(filePath, { force: true });
      await fs.rename(temporaryPath, filePath);
    });
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return sha256;
}

export function resolveManagedSpeechHome(env = process.env) {
  return (
    normalizeOptionalString(env.INSTAFY_SPEECH_HOST_HOME) ??
    normalizeOptionalString(env.LOCAL_SPEECH_MANAGED_HOME) ??
    DEFAULT_MANAGED_SPEECH_HOME
  );
}

export function resolveManagedSpeechOnly(env = process.env) {
  const value =
    normalizeOptionalString(env.LOCAL_SPEECH_MANAGED_RUNTIME_ONLY) ??
    normalizeOptionalString(env.INSTAFY_SPEECH_MANAGED_RUNTIME_ONLY) ??
    null;
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveManagedSpeechToolchainPaths(env = process.env) {
  const home = resolveManagedSpeechHome(env);
  const managedUvVersion =
    normalizeOptionalString(env.INSTAFY_MANAGED_UV_VERSION) ?? DEFAULT_MANAGED_UV_VERSION;
  const venvDir = path.join(home, "venv");
  const venvBinDir = isWindows() ? path.join(venvDir, "Scripts") : path.join(venvDir, "bin");
  const binDir = path.join(home, "bin");
  const downloadsDir = path.join(home, "downloads");
  const cacheRootDir = path.join(home, "cache");
  const uvCacheDir = path.join(cacheRootDir, "uv");
  const runtimeCacheDir = path.join(cacheRootDir, "runtime");
  const huggingfaceHome = path.join(runtimeCacheDir, "huggingface");
  const huggingfaceHubCache = path.join(huggingfaceHome, "hub");
  const transformersCache = path.join(huggingfaceHome, "transformers");
  const pythonInstallDir = path.join(home, "python");
  return {
    home,
    venvDir,
    venvBinDir,
    binDir,
    downloadsDir,
    cacheDir: uvCacheDir,
    cacheRootDir,
    uvCacheDir,
    runtimeCacheDir,
    huggingfaceHome,
    huggingfaceHubCache,
    transformersCache,
    xdgCacheHome: runtimeCacheDir,
    pythonInstallDir,
    pythonPath: path.join(venvBinDir, isWindows() ? "python.exe" : "python3"),
    pipPath: path.join(venvBinDir, isWindows() ? "pip.exe" : "pip"),
    whisperPath: path.join(venvBinDir, isWindows() ? "insanely-fast-whisper.exe" : "insanely-fast-whisper"),
    ffmpegPath: path.join(binDir, isWindows() ? "ffmpeg.exe" : "ffmpeg"),
    uvPath: path.join(binDir, isWindows() ? "uv.exe" : "uv"),
    uvInstallerPath: path.join(downloadsDir, isWindows() ? `uv-install-${managedUvVersion}.ps1` : `uv-install-${managedUvVersion}.sh`),
    metadataPath: path.join(home, "toolchain.json"),
  };
}

export function buildManagedSpeechRuntimeEnv(env = process.env) {
  const paths = resolveManagedSpeechToolchainPaths(env);
  return {
    HF_HOME: paths.huggingfaceHome,
    HUGGINGFACE_HUB_CACHE: paths.huggingfaceHubCache,
    TRANSFORMERS_CACHE: paths.transformersCache,
    XDG_CACHE_HOME: paths.xdgCacheHome,
  };
}

export async function ensureManagedSpeechRuntimeCacheDirs(env = process.env) {
  const paths = resolveManagedSpeechToolchainPaths(env);
  await Promise.all([
    fs.mkdir(paths.cacheRootDir, { recursive: true }),
    fs.mkdir(paths.uvCacheDir, { recursive: true }),
    fs.mkdir(paths.runtimeCacheDir, { recursive: true }),
    fs.mkdir(paths.huggingfaceHome, { recursive: true }),
    fs.mkdir(paths.huggingfaceHubCache, { recursive: true }),
    fs.mkdir(paths.transformersCache, { recursive: true }),
  ]);
  return paths;
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readManagedSpeechToolchainMetadata(env = process.env) {
  const { metadataPath } = resolveManagedSpeechToolchainPaths(env);
  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeManagedSpeechToolchainMetadata(payload, env = process.env) {
  const { home, metadataPath } = resolveManagedSpeechToolchainPaths(env);
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function removeManagedSpeechToolchain(env = process.env) {
  const { home } = resolveManagedSpeechToolchainPaths(env);
  await fs.rm(home, { recursive: true, force: true });
}

async function directoryHasEntries(targetPath) {
  try {
    const entries = await fs.readdir(targetPath);
    return entries.some((entry) => entry !== ".DS_Store");
  } catch {
    return false;
  }
}

async function resolveManagedSpeechModelCacheReady(paths) {
  if (await directoryHasEntries(paths.huggingfaceHubCache)) {
    return true;
  }
  return await directoryHasEntries(paths.transformersCache);
}

export async function resolveManagedSpeechToolchainStatus(env = process.env) {
  const paths = resolveManagedSpeechToolchainPaths(env);
  const [pythonAvailable, whisperAvailable, ffmpegAvailable, uvAvailable, modelCacheReady, metadata] = await Promise.all([
    pathExists(paths.pythonPath),
    pathExists(paths.whisperPath),
    pathExists(paths.ffmpegPath),
    pathExists(paths.uvPath),
    resolveManagedSpeechModelCacheReady(paths),
    readManagedSpeechToolchainMetadata(env),
  ]);
  return {
    ...paths,
    pythonAvailable,
    whisperAvailable,
    ffmpegAvailable,
    uvAvailable,
    modelCacheReady,
    available: whisperAvailable && ffmpegAvailable,
    metadata,
  };
}
