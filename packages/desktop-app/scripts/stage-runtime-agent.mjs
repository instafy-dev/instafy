import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const runtimeAgentRoot = path.join(repoRoot, "packages", "runtime-agent");
const filename = process.platform === "win32" ? "runtime-agent.exe" : "runtime-agent";
const hostFilename = process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
const outputDir = path.join(packageRoot, "build", "runtime-agent");
const explicit = process.env.INSTAFY_RUNTIME_AGENT_PREBUILT?.trim();
let builtSource;

function resolveSourceSha() {
  const explicitSha = (process.env.GITHUB_SHA || process.env.INSTAFY_SOURCE_SHA || "")
    .trim()
    .toLowerCase();
  if (explicitSha) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(explicitSha)) {
      throw new Error("GITHUB_SHA/INSTAFY_SOURCE_SHA must be a full Git commit SHA.");
    }
    return explicitSha;
  }

  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  const sourceSha = result.stdout.trim().toLowerCase();
  if (result.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha)) {
    throw new Error("Unable to resolve the full source Git SHA for the bundled runtime-agent.");
  }
  return sourceSha;
}

if (!explicit) {
  const helper = path.join(repoRoot, "scripts", "runtime-cargo.mjs");
  const hostProbe = spawnSync(process.execPath, [helper, "--print-host-target"], {
    cwd: repoRoot, env: process.env, encoding: "utf8",
  });
  if (hostProbe.error) throw hostProbe.error;
  if (hostProbe.status !== 0) throw new Error(`Unable to resolve the native Rust target: ${hostProbe.stderr}`);
  const target = hostProbe.stdout.trim();
  const targetArch = target.startsWith("aarch64-") ? "arm64" : target.startsWith("x86_64-") ? "x64" : null;
  const targetPlatform = target.endsWith("-apple-darwin") ? "darwin"
    : target.endsWith("-pc-windows-msvc") ? "win32"
      : /-unknown-linux-(gnu|musl)$/.test(target) ? "linux" : null;
  if (targetArch !== process.arch || targetPlatform !== process.platform) {
    throw new Error(`Rust host ${target} does not match native Desktop ${process.platform}/${process.arch}; use a matching native toolchain or an explicitly staged prebuilt pair.`);
  }
  // Pin both paths so inherited Cargo target/target-dir settings cannot make
  // us hash and ship an older executable left in the default output folder.
  const targetDir = path.join(runtimeAgentRoot, "target");
  builtSource = path.join(targetDir, target, "release", filename);
  const result = spawnSync(
    process.execPath,
    [
      helper,
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(runtimeAgentRoot, "Cargo.toml"),
      "--target", target,
      "--target-dir", targetDir,
      "--bins",
    ],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const source = path.resolve(
  explicit || builtSource,
);
const sourceStats = fs.lstatSync(source);
if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
  throw new Error(`runtime-agent build output is not a regular file: ${source}`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
const destination = path.join(outputDir, filename);
fs.copyFileSync(source, destination);
if (process.platform !== "win32") fs.chmodSync(destination, 0o755);

const bundledStats = fs.statSync(destination);
const sha256 = createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
const hostSource = path.join(path.dirname(source), hostFilename);
const hostStats = fs.lstatSync(hostSource);
if (!hostStats.isFile() || hostStats.isSymbolicLink()) {
  throw new Error(`code-mode host build output is not a regular file: ${hostSource}`);
}
const hostDestination = path.join(outputDir, hostFilename);
fs.copyFileSync(hostSource, hostDestination);
if (process.platform !== "win32") fs.chmodSync(hostDestination, 0o755);
const manifest = {
  schemaVersion: 3,
  filename,
  platform: process.platform,
  arch: process.arch,
  sizeBytes: bundledStats.size,
  sha256,
  sourceSha: resolveSourceSha(),
  codeModeHost: {
    filename: hostFilename,
    sizeBytes: hostStats.size,
    sha256: createHash("sha256").update(fs.readFileSync(hostDestination)).digest("hex"),
  },
};
fs.writeFileSync(
  path.join(outputDir, "runtime-agent-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(
  `[instafy-desktop] Staged verified runtime-agent (${process.platform}/${process.arch}, ${bundledStats.size} bytes).`,
);
