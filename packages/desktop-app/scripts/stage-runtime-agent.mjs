import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const runtimeAgentRoot = path.join(repoRoot, "packages", "runtime-agent");
const filename = process.platform === "win32" ? "runtime-agent.exe" : "runtime-agent";
const outputDir = path.join(packageRoot, "build", "runtime-agent");
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

if (!explicit) {
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(runtimeAgentRoot, "Cargo.toml"),
      "--bin",
      "runtime-agent",
    ],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const source = path.resolve(
  explicit || path.join(runtimeAgentRoot, "target", "release", filename),
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

// The Rust release profile keeps these binaries symbolicateable on purpose and
// says so: "Keep release binaries symbolicateable until packaging has archived
// the sidecar symbols and stripped the binaries." Packaging is here, and until
// now it only copied. Everything downstream pays for that: the binary is
// hashed for signing, embedded in the app, uploaded to Apple and scanned by
// the notary service, and finally downloaded by every user on every update.
//
// Archive first, then strip, then hash — so the manifest describes the binary
// that actually ships. Symbols go outside build/runtime-agent, because
// extraResources copies that directory with a runtime-agent* filter and would
// otherwise bundle them right back in.
const unstrippedBytes = fs.statSync(destination).size;
if (process.platform === "darwin") {
  const symbolsDir = path.join(packageRoot, "build", "runtime-agent-symbols");
  fs.rmSync(symbolsDir, { recursive: true, force: true });
  fs.mkdirSync(symbolsDir, { recursive: true });
  fs.copyFileSync(destination, path.join(symbolsDir, `${filename}.unstripped`));

  // -S drops debug symbols, -x drops non-external local symbols. Dynamic
  // linking only needs the external ones, which both flags preserve.
  const stripped = spawnSync("strip", ["-S", "-x", destination], {
    encoding: "utf8",
  });
  if (stripped.error || stripped.status !== 0) {
    // Shipping unstripped is what happened before this existed, so it is a
    // regression in size rather than a broken build. Say so rather than
    // failing a release that is otherwise fine.
    console.warn(
      `[instafy-desktop] Could not strip the runtime agent; shipping it unstripped. ${
        stripped.error?.message ?? stripped.stderr ?? ""
      }`.trim(),
    );
  } else {
    fs.chmodSync(destination, 0o755);
    const strippedBytes = fs.statSync(destination).size;
    const saved = unstrippedBytes - strippedBytes;
    console.log(
      `[instafy-desktop] Stripped the runtime agent: ${unstrippedBytes} -> ${strippedBytes} bytes ` +
        `(${saved} smaller); symbols archived in build/runtime-agent-symbols.`,
    );
  }
}

const bundledStats = fs.statSync(destination);
const sha256 = createHash("sha256").update(fs.readFileSync(destination)).digest("hex");
const manifest = {
  schemaVersion: 2,
  filename,
  platform: process.platform,
  arch: process.arch,
  sizeBytes: bundledStats.size,
  sha256,
  sourceSha: resolveSourceSha(),
};
fs.writeFileSync(
  path.join(outputDir, "runtime-agent-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(
  `[instafy-desktop] Staged verified runtime-agent (${process.platform}/${process.arch}, ${bundledStats.size} bytes).`,
);
