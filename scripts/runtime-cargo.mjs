#!/usr/bin/env node
// Codex's sandbox-enabled V8 needs its matching archive AND generated bindings.
// Keep artifact names/checksum rules aligned with codex/scripts/codex_package/v8.py.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = "ptrcomp_sandbox_release";
const targets = new Set([
  "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl",
  "x86_64-apple-darwin", "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc",
]);

export function resolvedV8Version(lockText) {
  const versions = new Set();
  for (const block of lockText.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    if (/^name\s*=\s*"v8"\s*$/m.test(block)) {
      const version = block.match(/^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m)?.[1];
      if (!version) throw new Error("Invalid resolved V8 version in the pinned Codex Cargo.lock.");
      versions.add(version);
    }
  }
  if (versions.size !== 1) throw new Error("Expected exactly one resolved V8 version in the pinned Codex Cargo.lock.");
  return [...versions][0];
}

export function artifactNames(target) {
  if (!targets.has(target)) throw new Error(`No Codex-built V8 artifact target: ${target}. Use a supported --target or V8_FROM_SOURCE=1.`);
  return {
    archive: target.endsWith("-pc-windows-msvc")
      ? `rusty_v8_${profile}_${target}.lib.gz`
      : `librusty_v8_${profile}_${target}.a.gz`,
    binding: `src_binding_${profile}_${target}.rs`,
    checksums: `rusty_v8_${profile}_${target}.sha256`,
  };
}

export function parseChecksums(text, names) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length !== names.length) throw new Error("Expected exactly two V8 artifact checksums.");
  const checksums = new Map();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})\s+([^\s]+)\s*$/);
    if (!match || !names.includes(match[2]) || checksums.has(match[2])) {
      throw new Error("Invalid, duplicate, or unexpected V8 artifact checksum.");
    }
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

export function resolveTarget(args, env, run = spawnSync) {
  const explicit = [];
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    if (args[i] === "--target") explicit.push(args[++i]);
    else if (args[i].startsWith("--target=")) explicit.push(args[i].slice(9));
  }
  if (explicit.length > 1) throw new Error("Build one V8 target at a time.");
  if (explicit.length && !explicit[0]) throw new Error("--target requires a Rust target triple.");
  let target = explicit[0] || env.CARGO_BUILD_TARGET;
  if (!target) {
    const toolchain = !env.RUSTC && args[0]?.startsWith("+") ? [args[0]] : [];
    const result = run(env.RUSTC || "rustc", [...toolchain, "-vV"], { env, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Unable to determine rustc's host target.");
    target = result.stdout.match(/^host: (\S+)$/m)?.[1];
  }
  artifactNames(target);
  return target;
}

export function resolveHostTarget(env = process.env, run = spawnSync) {
  return resolveTarget([], { ...env, CARGO_BUILD_TARGET: undefined }, run);
}

function targetConfigIsAmbiguous(text) {
  let inBuild = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Detect settings only; Cargo remains the TOML parser. Includes and escaped
    // keys cannot be resolved safely here and require an explicit target.
    const assignment = line.indexOf("=");
    if (assignment >= 0 && line.slice(0, assignment).includes("\\")) return true;
    if (/^(?:include|"include"|'include')\s*=/.test(line)) return true;
    if (/^(?:build|"build"|'build')\s*\.\s*(?:target|"target"|'target')\s*=/.test(line)) return true;
    if (/^(?:build|"build"|'build')\s*\.\s*"[^"=]*\\/.test(line)) return true;
    if (/^(?:build|"build"|'build')\s*=/.test(line)) return true;
    if (line.startsWith("[")) {
      if (line.includes("\\")) return true;
      inBuild = /^\[\s*(?:build|"build"|'build')\s*\]/.test(line);
    } else if (inBuild && /^(?:target|"target"|'target')\s*=/.test(line)) {
      return true;
    } else if (inBuild && line.startsWith('"') && line.includes("\\")) {
      return true;
    }
  }
  return false;
}

export async function validateTargetConfiguration(args, env, cwd = process.cwd()) {
  let explicitTarget = false;
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    if (args[i] === "--target" || args[i].startsWith("--target=")) explicitTarget = true;
    const config = args[i] === "--config" ? args[++i]
      : args[i].startsWith("--config=") ? args[i].slice(9) : undefined;
    if (config !== undefined && (!config.includes("=") || targetConfigIsAmbiguous(config))) {
      throw new Error("runtime-cargo cannot infer target settings from --config files/includes or build.target overrides; use --target or CARGO_BUILD_TARGET instead.");
    }
  }
  if (explicitTarget || env.CARGO_BUILD_TARGET) return;
  const directories = new Set([path.resolve(env.CARGO_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".cargo"))]);
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    directories.add(path.join(directory, ".cargo"));
    if (path.dirname(directory) === directory) break;
  }
  for (const directory of directories) {
    for (const filename of ["config", "config.toml"]) {
      const configPath = path.join(directory, filename);
      let text;
      try { text = await readFile(configPath, "utf8"); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) continue; throw error; }
      if (targetConfigIsAmbiguous(text)) {
        throw new Error(`Inherited Cargo target settings in ${configPath} require explicit --target or CARGO_BUILD_TARGET so Cargo and V8 use the same architecture.`);
      }
    }
  }
}

async function hasChecksum(filename, expected) {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest("hex") === expected;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function responseFor(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`V8 artifact download failed: HTTP ${response.status} (${url}).`);
  return response;
}

async function downloadVerified(url, destination, digest, fetchImpl) {
  if (await hasChecksum(destination, digest)) return;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const response = await responseFor(url, fetchImpl);
    // writeFile accepts an async iterable, so large archives are streamed to disk.
    await writeFile(temporary, response.body, { flag: "wx" });
    if (!await hasChecksum(temporary, digest)) throw new Error(`V8 artifact failed SHA-256 verification: ${path.basename(destination)}.`);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function resolveV8Environment({
  args = [], env = process.env, root = repoRoot,
  cwd = process.cwd(),
  cacheRoot = env.INSTAFY_RUSTY_V8_CACHE || path.join(os.tmpdir(), "instafy-rusty-v8"),
  fetchImpl = fetch, run = spawnSync,
} = {}) {
  if (["true", "1", "yes"].includes(env.V8_FROM_SOURCE)) return {};
  if (env.RUSTY_V8_ARCHIVE && env.RUSTY_V8_SRC_BINDING_PATH) return {};
  if (env.RUSTY_V8_ARCHIVE || env.RUSTY_V8_SRC_BINDING_PATH) {
    throw new Error("Set RUSTY_V8_ARCHIVE and RUSTY_V8_SRC_BINDING_PATH together.");
  }
  await validateTargetConfiguration(args, env, cwd);
  const target = resolveTarget(args, env, run);
  const version = resolvedV8Version(await readFile(path.join(root, "codex", "codex-rs", "Cargo.lock"), "utf8"));
  const names = artifactNames(target);
  const baseUrl = `https://github.com/openai/codex/releases/download/rusty-v8-v${version}`;
  const directory = path.resolve(cacheRoot, `rusty-v8-${version}-${target}`);
  await mkdir(directory, { recursive: true });
  // Refresh the small manifest each invocation and verify cached files against it.
  const response = await responseFor(`${baseUrl}/${names.checksums}`, fetchImpl);
  let manifest = "";
  for await (const chunk of response.body) {
    manifest += Buffer.from(chunk).toString("utf8");
    if (manifest.length > 4096) throw new Error("V8 checksum manifest is too large.");
  }
  const checksums = parseChecksums(manifest, [names.archive, names.binding]);
  for (const filename of [names.archive, names.binding]) {
    await downloadVerified(`${baseUrl}/${filename}`, path.join(directory, filename), checksums.get(filename), fetchImpl);
  }
  return {
    RUSTY_V8_ARCHIVE: path.join(directory, names.archive),
    RUSTY_V8_SRC_BINDING_PATH: path.join(directory, names.binding),
  };
}

export async function runRuntimeCargo(args, { env = process.env, run = spawnSync, cwd = process.cwd(), ...options } = {}) {
  if (!args.length) throw new Error("Usage: node scripts/runtime-cargo.mjs <cargo arguments>");
  const overrides = await resolveV8Environment({ args, env, run, cwd, ...options });
  const result = run("cargo", args, { cwd, env: { ...env, ...overrides }, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Cargo terminated by ${result.signal}.`);
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--print-host-target") console.log(resolveHostTarget());
    else process.exitCode = await runRuntimeCargo(args);
  } catch (error) {
    console.error(`[runtime-cargo] ${error.message}`);
    process.exitCode = 1;
  }
}
