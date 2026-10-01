import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUNDLED_RUNTIME_AGENT_DIRECTORY = "runtime-agent";
export const BUNDLED_RUNTIME_AGENT_MANIFEST = "runtime-agent-manifest.json";

type BundledBinary = {
  filename: string;
  sizeBytes: number;
  sha256: string;
};

type RuntimeAgentManifest = BundledBinary & {
  schemaVersion: 3;
  platform: NodeJS.Platform;
  arch: string;
  // Code-mode-only models (the default) run every tool in this host, which
  // runtime-agent requires next to its own binary.
  codeModeHost: BundledBinary;
  sourceSha: string;
};

function isBundledBinary(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binary = value as Partial<BundledBinary>;
  return (
    typeof binary.filename === "string" &&
    /^[a-zA-Z0-9._-]+$/.test(binary.filename) &&
    Number.isSafeInteger(binary.sizeBytes) &&
    (binary.sizeBytes ?? 0) > 0 &&
    typeof binary.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(binary.sha256)
  );
}

function requireManifest(value: unknown): RuntimeAgentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bundled runtime-agent manifest must be an object.");
  }
  const manifest = value as Partial<RuntimeAgentManifest>;
  if (
    manifest.schemaVersion !== 3 ||
    !isBundledBinary(manifest) ||
    !isBundledBinary(manifest.codeModeHost) ||
    typeof manifest.platform !== "string" ||
    typeof manifest.arch !== "string" ||
    typeof manifest.sourceSha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceSha)
  ) {
    throw new Error("Bundled runtime-agent manifest is invalid.");
  }
  return manifest as RuntimeAgentManifest;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function resolveVerifiedBundledRuntimeAgent(options: {
  resourcesPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const bundleDir = path.join(options.resourcesPath, BUNDLED_RUNTIME_AGENT_DIRECTORY);
  const manifestPath = path.join(bundleDir, BUNDLED_RUNTIME_AGENT_MANIFEST);

  let raw: string;
  try {
    const manifestStats = await fs.promises.lstat(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > 64 * 1024) {
      throw new Error("manifest is not a small regular file");
    }
    raw = await fs.promises.readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `Packaged Personal Browser runtime manifest is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Packaged Personal Browser runtime manifest is not valid JSON.");
  }
  const manifest = requireManifest(parsed);
  const suffix = platform === "win32" ? ".exe" : "";
  if (
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    manifest.filename !== `runtime-agent${suffix}` ||
    manifest.codeModeHost.filename !== `codex-code-mode-host${suffix}`
  ) {
    throw new Error(
      `Packaged Personal Browser runtime targets ${manifest.platform}/${manifest.arch}, not ${platform}/${arch}.`,
    );
  }

  const executablePath = await verifyBundledBinary(bundleDir, manifest, platform, "executable");
  await verifyBundledBinary(bundleDir, manifest.codeModeHost, platform, "code-mode host");
  return executablePath;
}

async function verifyBundledBinary(
  bundleDir: string,
  binary: BundledBinary,
  platform: NodeJS.Platform,
  label: string,
): Promise<string> {
  const binaryPath = path.join(bundleDir, binary.filename);
  const stats = await fs.promises.lstat(binaryPath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Packaged Personal Browser runtime ${label} is missing or unsafe.`);
  }
  if (stats.size !== binary.sizeBytes) {
    throw new Error(`Packaged Personal Browser runtime ${label} size does not match its manifest.`);
  }
  if (platform !== "win32" && (stats.mode & 0o111) === 0) {
    throw new Error(`Packaged Personal Browser runtime ${label} is not executable.`);
  }
  if ((await sha256File(binaryPath)) !== binary.sha256) {
    throw new Error(`Packaged Personal Browser runtime ${label} failed checksum verification.`);
  }
  return binaryPath;
}
