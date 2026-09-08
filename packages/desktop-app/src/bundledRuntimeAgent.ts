import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUNDLED_RUNTIME_AGENT_DIRECTORY = "runtime-agent";
export const BUNDLED_RUNTIME_AGENT_MANIFEST = "runtime-agent-manifest.json";

type RuntimeExecutable = {
  filename: string;
  sizeBytes: number;
  sha256: string;
};

type RuntimeAgentManifest = RuntimeExecutable & {
  schemaVersion: 3;
  platform: NodeJS.Platform;
  arch: string;
  sourceSha: string;
  codeModeHost: RuntimeExecutable;
};

function validExecutable(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const executable = value as Partial<RuntimeExecutable>;
  return typeof executable.filename === "string" &&
    /^[a-zA-Z0-9._-]+$/.test(executable.filename) &&
    Number.isSafeInteger(executable.sizeBytes) && (executable.sizeBytes ?? 0) > 0 &&
    typeof executable.sha256 === "string" && /^[a-f0-9]{64}$/.test(executable.sha256);
}

function requireManifest(value: unknown): RuntimeAgentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bundled runtime-agent manifest must be an object.");
  }
  const manifest = value as Partial<RuntimeAgentManifest>;
  if (
    manifest.schemaVersion !== 3 ||
    !validExecutable(manifest) ||
    !validExecutable(manifest.codeModeHost) ||
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
  const expectedFilename = platform === "win32" ? "runtime-agent.exe" : "runtime-agent";
  const expectedHostFilename = platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
  if (
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    manifest.filename !== expectedFilename ||
    manifest.codeModeHost.filename !== expectedHostFilename
  ) {
    throw new Error(
      `Packaged Personal Browser runtime targets ${manifest.platform}/${manifest.arch}, not ${platform}/${arch}.`,
    );
  }

  for (const executable of [manifest, manifest.codeModeHost]) {
    await verifyExecutable(path.join(bundleDir, executable.filename), executable, platform);
  }
  return path.join(bundleDir, manifest.filename);
}

async function verifyExecutable(
  executablePath: string,
  executable: RuntimeExecutable,
  platform: NodeJS.Platform,
): Promise<void> {
  const executableStats = await fs.promises.lstat(executablePath).catch(() => null);
  if (!executableStats?.isFile() || executableStats.isSymbolicLink()) {
    throw new Error("Packaged Personal Browser runtime executable is missing or unsafe.");
  }
  if (executableStats.size !== executable.sizeBytes) {
    throw new Error("Packaged Personal Browser runtime executable size does not match its manifest.");
  }
  if (platform !== "win32" && (executableStats.mode & 0o111) === 0) {
    throw new Error("Packaged Personal Browser runtime executable is not executable.");
  }
  if ((await sha256File(executablePath)) !== executable.sha256) {
    throw new Error("Packaged Personal Browser runtime executable failed checksum verification.");
  }
}
