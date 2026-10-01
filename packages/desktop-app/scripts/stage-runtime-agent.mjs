import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const runtimeAgentRoot = path.join(repoRoot, "packages", "runtime-agent");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const filename = `runtime-agent${executableSuffix}`;
// Code-mode-only models (gpt-6-luna, gpt-5.6-sol, the default) run every tool in this
// out-of-process V8 host, which runtime-agent requires next to its own binary.
const codeModeHostFilename = `codex-code-mode-host${executableSuffix}`;
const outputDir = path.join(packageRoot, "build", "runtime-agent");
// A prebuilt runtime-agent must have the code-mode host beside it.
const explicit = process.env.INSTAFY_RUNTIME_AGENT_PREBUILT?.trim();

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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

// The host links V8 with its sandbox enabled, which only Codex publishes prebuilt. Fetch it
// (checked against the checksums pinned in the codex checkout) unless the caller already
// points the v8 build script at one.
function rustyV8Environment() {
  if (process.env.RUSTY_V8_ARCHIVE && process.env.RUSTY_V8_SRC_BINDING_PATH) return {};
  const rustc = run("rustc", ["-vV"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const host = rustc.stdout.match(/^host: (\S+)$/m)?.[1];
  if (!host) throw new Error("Unable to resolve the Rust host target for the V8 fetch.");
  const fetched = run(
    "bash",
    [
      path.join(repoRoot, "scripts", "fetch-rusty-v8.sh"),
      host,
      path.join(packageRoot, "build", "rusty-v8"),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const environment = {};
  for (const line of fetched.stdout.split(/\r?\n/)) {
    const match = line.match(/^(RUSTY_V8_ARCHIVE|RUSTY_V8_SRC_BINDING_PATH)=(.+)$/);
    if (match) environment[match[1]] = match[2];
  }
  if (!environment.RUSTY_V8_ARCHIVE || !environment.RUSTY_V8_SRC_BINDING_PATH) {
    throw new Error("fetch-rusty-v8.sh did not report the V8 archive and binding paths.");
  }
  return environment;
}

if (!explicit) {
  run(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(runtimeAgentRoot, "Cargo.toml"),
      "--features",
      "code-mode-host",
      "-p",
      "runtime-agent",
      "-p",
      "codex-code-mode-host",
    ],
    { env: { ...process.env, ...rustyV8Environment() } },
  );
}

const source = path.resolve(
  explicit || path.join(runtimeAgentRoot, "target", "release", filename),
);
const hostSource = path.join(path.dirname(source), codeModeHostFilename);
for (const file of [source, hostSource]) {
  const stats = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`runtime-agent build output is missing or not a regular file: ${file}`);
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
const destination = path.join(outputDir, filename);
const hostDestination = path.join(outputDir, codeModeHostFilename);
fs.copyFileSync(source, destination);
fs.copyFileSync(hostSource, hostDestination);
if (process.platform !== "win32") {
  fs.chmodSync(destination, 0o755);
  fs.chmodSync(hostDestination, 0o755);
}

function describe(file) {
  return {
    sizeBytes: fs.statSync(file).size,
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  };
}

const bundled = describe(destination);
const manifest = {
  schemaVersion: 3,
  filename,
  platform: process.platform,
  arch: process.arch,
  sizeBytes: bundled.sizeBytes,
  sha256: bundled.sha256,
  codeModeHost: { filename: codeModeHostFilename, ...describe(hostDestination) },
  sourceSha: resolveSourceSha(),
};
fs.writeFileSync(
  path.join(outputDir, "runtime-agent-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(
  `[instafy-desktop] Staged verified runtime-agent and code-mode host (${process.platform}/${process.arch}, ${bundled.sizeBytes} + ${manifest.codeModeHost.sizeBytes} bytes).`,
);
