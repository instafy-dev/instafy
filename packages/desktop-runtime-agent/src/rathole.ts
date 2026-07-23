import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

// Keep the Desktop tunnel client on the same default rathole line as the
// self-hosted tunnel broker stack. Newer client builds drifted protocol/service
// handling on macOS arm64 and broke self-hosted tunnel handshakes.
const DEFAULT_VERSION = process.env.RATHOLE_VERSION ?? "v0.5.0";
const DEFAULT_CACHE_DIR =
  process.env.RATHOLE_CACHE_DIR ?? path.join(os.homedir(), ".instafy", "rathole");

export const DEFAULT_RATHOLE_VERSION = DEFAULT_VERSION;
export const DEFAULT_RATHOLE_CACHE_DIR = DEFAULT_CACHE_DIR;

interface EnsureOptions {
  version?: string;
  cacheDir?: string;
  logger?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

type InstallPlan =
  | { method: "download"; assetName: string; binaryName: string }
  | { method: "cargo"; binaryName: string };

export async function ensureRatholeBinary(options: EnsureOptions = {}): Promise<string> {
  const logger = options.logger ?? (() => {});
  const versionInput = (options.version ?? DEFAULT_VERSION).trim() || "latest";
  const cacheRoot = path.resolve(options.cacheDir ?? DEFAULT_CACHE_DIR);

  const plan = resolveInstallPlan();
  if (plan.method === "cargo") {
    return ensureRatholeViaCargo({
      version: versionInput,
      cacheRoot,
      binaryName: plan.binaryName,
      logger,
    });
  }

  const tag = normalizeGithubTag(versionInput);
  const targetDir = path.join(cacheRoot, tag, plan.assetName.replace(/\.zip$/i, ""));
  const binaryPath = path.join(targetDir, plan.binaryName);

  try {
    await fs.promises.access(binaryPath, fs.constants.X_OK);
    return binaryPath;
  } catch {
    // continue and attempt download
  }

  await fs.promises.mkdir(targetDir, { recursive: true });

  const downloadUrl = buildDownloadUrl(plan.assetName, tag);
  logger(`Downloading rathole (${plan.assetName}) from ${downloadUrl}`);
  const tempFile = path.join(targetDir, `${plan.assetName}.${Date.now()}.download`);

  try {
    await downloadFile(downloadUrl, tempFile, options.fetchImpl);
    await extractZip(tempFile, targetDir);
  } finally {
    await safeUnlink(tempFile);
  }

  if (!(await fileExists(binaryPath))) {
    throw new Error(`rathole binary missing after extraction (${binaryPath})`);
  }

  if (process.platform !== "win32") {
    await fs.promises.chmod(binaryPath, 0o755);
  }

  logger(`rathole ready at ${binaryPath}`);
  return binaryPath;
}

export interface CachedRatholeBinary {
  version: string;
  binaryPath: string;
  assetName: string;
  size: number;
  modifiedAt: string;
}

export async function listCachedRatholeBinaries(
  options: { cacheDir?: string } = {},
): Promise<CachedRatholeBinary[]> {
  const cacheRoot = path.resolve(options.cacheDir ?? DEFAULT_CACHE_DIR);
  try {
    const versionEntries = await fs.promises.readdir(cacheRoot, { withFileTypes: true });
    const binaries: CachedRatholeBinary[] = [];
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory()) {
        continue;
      }
      const version = versionEntry.name;
      const versionPath = path.join(cacheRoot, version);
      const candidates = await collectRatholeBinaries(versionPath);
      for (const candidate of candidates) {
        const stats = await fs.promises.stat(candidate);
        binaries.push({
          version,
          binaryPath: candidate,
          assetName: path.relative(versionPath, path.dirname(candidate)) || ".",
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        });
      }
    }
    return binaries.sort((a, b) => a.version.localeCompare(b.version));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function purgeRatholeCache(
  options: { cacheDir?: string; version?: string } = {},
): Promise<number> {
  const cacheRoot = path.resolve(options.cacheDir ?? DEFAULT_CACHE_DIR);
  try {
    const targets =
      options.version && options.version.trim().length > 0
        ? [path.join(cacheRoot, options.version.trim())]
        : (await fs.promises
            .readdir(cacheRoot)
            .then((entries) => entries.map((entry) => path.join(cacheRoot, entry))));

    let removed = 0;
    for (const target of targets) {
      const exists = await fs.promises
        .access(target)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        continue;
      }
      await fs.promises.rm(target, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function resolveInstallPlan(): InstallPlan {
  const arch = process.arch;
  const platform = process.platform;

  if (platform === "darwin" && arch === "arm64") {
    return {
      method: "download",
      assetName: "rathole-x86_64-apple-darwin.zip",
      binaryName: "rathole",
    };
  }

  if (platform === "darwin") {
    if (arch !== "x64") {
      throw new Error(
        `Unsupported platform ${platform}/${arch} for prebuilt rathole; set RATHOLE_BIN or install via cargo.`,
      );
    }
    return {
      method: "download",
      assetName: "rathole-x86_64-apple-darwin.zip",
      binaryName: "rathole",
    };
  }

  if (platform === "linux") {
    if (arch === "arm64") {
      return {
        method: "download",
        assetName: "rathole-aarch64-unknown-linux-musl.zip",
        binaryName: "rathole",
      };
    }
    if (arch === "x64") {
      return {
        method: "download",
        assetName: "rathole-x86_64-unknown-linux-gnu.zip",
        binaryName: "rathole",
      };
    }
    throw new Error(
      `Unsupported platform ${platform}/${arch}. Set RATHOLE_BIN to a valid executable.`,
    );
  }

  if (platform === "win32") {
    if (arch !== "x64") {
      throw new Error(
        `Unsupported platform ${platform}/${arch}. Set RATHOLE_BIN to a valid executable.`,
      );
    }
    return {
      method: "download",
      assetName: "rathole-x86_64-pc-windows-msvc.zip",
      binaryName: "rathole.exe",
    };
  }

  throw new Error(
    `Unsupported platform ${platform}/${arch}. Set RATHOLE_BIN to a valid executable.`,
  );
}

function normalizeGithubTag(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "latest") {
    return "latest";
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function buildDownloadUrl(assetName: string, tag: string): string {
  const base =
    tag === "latest"
      ? "https://github.com/rapiz1/rathole/releases/latest/download"
      : `https://github.com/rapiz1/rathole/releases/download/${tag}`;
  return `${base}/${assetName}`;
}

async function downloadFile(url: string, destination: string, fetchImpl?: typeof fetch) {
  const fetcher = fetchImpl ?? fetch;
  const response = await fetcher(url);
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`failed to download rathole (${response.status}): ${text}`);
  }
  const nodeStream =
    typeof Readable.fromWeb === "function"
      ? Readable.fromWeb(response.body as unknown as ReadableStream)
      : (response.body as unknown as Readable);
  await pipeline(nodeStream, fs.createWriteStream(destination));
}

async function extractZip(archivePath: string, targetDir: string): Promise<void> {
  const cmd = process.platform === "win32" ? "powershell.exe" : "unzip";
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${escapePowershellString(archivePath)}' -DestinationPath '${escapePowershellString(
            targetDir,
          )}' -Force`,
        ]
      : ["-o", archivePath, "-d", targetDir];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code ?? -1}`));
      }
    });
  });
}

function escapePowershellString(value: string): string {
  return value.replace(/'/g, "''");
}

async function ensureRatholeViaCargo(params: {
  version: string;
  cacheRoot: string;
  binaryName: string;
  logger: (message: string) => void;
}): Promise<string> {
  const tag = normalizeGithubTag(params.version);
  const installRoot = path.join(params.cacheRoot, tag, "cargo");
  const binPath = path.join(installRoot, "bin", params.binaryName);

  try {
    await fs.promises.access(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    // continue
  }

  await fs.promises.mkdir(installRoot, { recursive: true });
  const crateVersion =
    tag === "latest" ? null : tag.replace(/^v/, "").trim() || null;

  params.logger(
    crateVersion
      ? `Installing rathole ${crateVersion} via cargo (arm64 macOS fallback)...`
      : "Installing rathole via cargo (arm64 macOS fallback)...",
  );

  const argsLocked = ["install", "rathole", "--locked", "--root", installRoot];
  const argsUnlocked = ["install", "rathole", "--root", installRoot];
  if (crateVersion) {
    argsLocked.push("--version", crateVersion);
    argsUnlocked.push("--version", crateVersion);
  }

  const runCargoInstall = async (args: string[]) =>
    await new Promise<void>((resolve, reject) => {
      const child = spawn("cargo", args, { stdio: "inherit" });
      child.on("error", (error) => {
        reject(
          new Error(
            `failed to run cargo install for rathole (${String(error)}). Install Rust/cargo or set RATHOLE_BIN.`,
          ),
        );
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`cargo install exited with code ${code ?? -1}`));
        }
      });
    });

  try {
    await runCargoInstall(argsLocked);
  } catch (error) {
    params.logger(
      `cargo install --locked failed (${error instanceof Error ? error.message : String(error)}); retrying without --locked...`,
    );
    await runCargoInstall(argsUnlocked);
  }

  if (!(await fileExists(binPath))) {
    throw new Error(`rathole binary missing after cargo install (${binPath})`);
  }

  return binPath;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
}

async function collectRatholeBinaries(root: string, depth = 0): Promise<string[]> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const binaries: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && isBinaryName(entry.name)) {
      binaries.push(entryPath);
    } else if (entry.isDirectory() && depth < 2) {
      const nested = await collectRatholeBinaries(entryPath, depth + 1);
      binaries.push(...nested);
    }
  }
  return binaries;
}

function isBinaryName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "rathole" || lower === "rathole.exe";
}
