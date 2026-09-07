import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { modulePathToImportUrl } from "./module-import-url.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(packageRoot, "release");
const requireSignedArtifacts = process.env.INSTAFY_REQUIRE_SIGNED_DESKTOP_ARTIFACTS === "1";
const { resolveVerifiedBundledRuntimeAgent } = await import(
  modulePathToImportUrl(path.join(packageRoot, "dist", "bundledRuntimeAgent.js")),
);

function walk(directory, predicate, depth = 0) {
  if (depth > 10 || !fs.existsSync(directory)) return [];
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(entryPath, predicate, depth + 1));
    } else if (entry.isFile() && predicate(entryPath, entry.name)) {
      results.push(entryPath);
    }
  }
  return results;
}

function requireSingleFile(root, predicate, label) {
  const matches = walk(root, predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}; found ${matches.length} under ${root}.`);
  }
  return matches[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? "signal"}${
        options.capture ? `: ${result.stderr || result.stdout}` : ""
      }`,
    );
  }
  return result;
}

function detachVerificationDiskImage(mountRoot) {
  const detach = (force) =>
    spawnSync("hdiutil", ["detach", ...(force ? ["-force"] : []), mountRoot], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const normal = detach(false);
  if (!normal.error && normal.status === 0) return;

  // Spotlight/Finder can briefly retain handles after the verifier reads the
  // app bundle. This is a private, read-only, throwaway mount, so a forced
  // detach is the safe bounded cleanup fallback rather than a release failure.
  const forced = detach(true);
  if (forced.error) throw forced.error;
  if (forced.status !== 0) {
    throw new Error(
      `hdiutil detach -force ${mountRoot} failed with status ${
        forced.status ?? "signal"
      }: ${forced.stderr || forced.stdout}`,
    );
  }
  console.warn("[instafy-desktop] Forced detach of the temporary DMG verification mount.");
}

function unquoteYamlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function parseUpdaterFiles(metadataPath) {
  const entries = [];
  let current = null;
  for (const line of fs.readFileSync(metadataPath, "utf8").split(/\r?\n/)) {
    const url = /^\s*-\s+url:\s*(.+?)\s*$/.exec(line);
    if (url) {
      current = { url: unquoteYamlScalar(url[1]) };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const sha512 = /^\s+sha512:\s*(.+?)\s*$/.exec(line);
    if (sha512 && !current.sha512) {
      current.sha512 = unquoteYamlScalar(sha512[1]);
      continue;
    }
    const size = /^\s+size:\s*(\d+)\s*$/.exec(line);
    if (size && !current.size) current.size = Number.parseInt(size[1], 10);
  }
  if (
    entries.length === 0 ||
    entries.some(
      (entry) =>
        typeof entry.url !== "string" ||
        typeof entry.sha512 !== "string" ||
        !Number.isSafeInteger(entry.size),
    )
  ) {
    throw new Error(`Updater metadata has incomplete files entries: ${metadataPath}`);
  }
  return entries;
}

function artifactBasename(url) {
  const withoutQuery = url.split(/[?#]/, 1)[0];
  const decoded = decodeURIComponent(path.posix.basename(withoutQuery));
  if (!decoded || decoded === "." || decoded === ".." || decoded.includes(path.sep)) {
    throw new Error(`Unsafe updater artifact URL: ${url}`);
  }
  return decoded;
}

function sha512File(filePath) {
  return createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
}

function verifyUpdaterMetadata(metadataName) {
  const metadataPath = requireSingleFile(
    releaseRoot,
    (_filePath, name) => name === metadataName,
    metadataName,
  );
  for (const entry of parseUpdaterFiles(metadataPath)) {
    const name = artifactBasename(entry.url);
    const artifactPath = requireSingleFile(
      releaseRoot,
      (_filePath, candidate) => candidate === name,
      `artifact referenced by ${metadataName}: ${name}`,
    );
    const stats = fs.statSync(artifactPath);
    if (stats.size !== entry.size) {
      throw new Error(`${metadataName} size does not match ${name}.`);
    }
    if (sha512File(artifactPath) !== entry.sha512) {
      throw new Error(`${metadataName} SHA-512 does not match ${name}.`);
    }
  }
  console.log(`[instafy-desktop] Verified updater checksums from ${metadataName}.`);
}

async function verifyRuntimeUnder(root) {
  const manifestPath = requireSingleFile(
    root,
    (_filePath, name) => name === "runtime-agent-manifest.json",
    "extracted runtime-agent manifest",
  );
  const resourcesPath = path.dirname(path.dirname(manifestPath));
  const executablePath = await resolveVerifiedBundledRuntimeAgent({ resourcesPath });
  const hostPath = path.join(path.dirname(executablePath),
    process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host");
  const hostProbe = run(hostPath, ["--version"], { capture: true, timeout: 20_000 });
  if (!hostProbe.stdout.trim().startsWith("codex-code-mode-host ")) {
    throw new Error("Extracted code-mode host returned an invalid version string.");
  }
  const probe = run(executablePath, ["--version"], { capture: true, timeout: 20_000 });
  if (!probe.stdout.trim().startsWith("runtime-agent ")) {
    throw new Error(`Extracted runtime-agent returned an invalid version string: ${probe.stdout}`);
  }
  return executablePath;
}

function findSingleMacApp(root) {
  const apps = [];
  const visit = (directory, depth = 0) => {
    if (depth > 8 || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.name.endsWith(".app")) apps.push(entryPath);
      else visit(entryPath, depth + 1);
    }
  };
  visit(root);
  if (apps.length !== 1) {
    throw new Error(`Expected exactly one extracted macOS app; found ${apps.length} under ${root}.`);
  }
  return apps[0];
}

function verifySignedMacAppUnder(root) {
  if (!requireSignedArtifacts) return;
  const appPath = findSingleMacApp(root);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
}

function verifyWindowsAuthenticode(filePath) {
  if (!requireSignedArtifacts) return;
  run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$signature = Get-AuthenticodeSignature -LiteralPath $env:INSTAFY_VERIFY_FILE; if ($signature.Status -ne 'Valid') { throw \"Invalid Authenticode signature: $($signature.Status)\" }",
    ],
    { env: { ...process.env, INSTAFY_VERIFY_FILE: filePath } },
  );
}

async function verifyMacArtifacts() {
  verifyUpdaterMetadata("latest-mac.yml");
  const dmg = requireSingleFile(releaseRoot, (_path, name) => name.endsWith(".dmg"), "macOS DMG");
  const zip = requireSingleFile(
    releaseRoot,
    (_path, name) => name.endsWith("-mac-arm64.zip") || name.endsWith("-mac-x64.zip"),
    "architecture-qualified macOS ZIP",
  );
  run("hdiutil", ["verify", dmg]);

  const zipRoot = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-desktop-zip-"));
  const mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-desktop-dmg-"));
  let mounted = false;
  try {
    run("ditto", ["-x", "-k", zip, zipRoot]);
    await verifyRuntimeUnder(zipRoot);
    verifySignedMacAppUnder(zipRoot);
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, dmg]);
    mounted = true;
    await verifyRuntimeUnder(mountRoot);
    verifySignedMacAppUnder(mountRoot);
  } finally {
    if (mounted) detachVerificationDiskImage(mountRoot);
    fs.rmSync(zipRoot, { recursive: true, force: true });
    fs.rmSync(mountRoot, { recursive: true, force: true });
  }
}

async function verifyWindowsArtifacts() {
  verifyUpdaterMetadata("latest.yml");
  const installer = requireSingleFile(
    releaseRoot,
    (_path, name) => name.endsWith("-win.exe"),
    "Windows NSIS installer",
  );
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-desktop-nsis-"));
  try {
    run("7z", ["x", "-y", `-o${extractionRoot}`, installer]);
    for (const nested of walk(extractionRoot, (_path, name) => name.endsWith(".7z"))) {
      run("7z", ["x", "-y", `-o${path.dirname(nested)}`, nested]);
    }
    const runtimePath = await verifyRuntimeUnder(extractionRoot);
    verifyWindowsAuthenticode(runtimePath);
    verifyWindowsAuthenticode(path.join(path.dirname(runtimePath), "codex-code-mode-host.exe"));
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

async function verifyLinuxArtifacts() {
  verifyUpdaterMetadata("latest-linux.yml");
  const appImage = requireSingleFile(
    releaseRoot,
    (_path, name) => name.endsWith("-linux.AppImage"),
    "Linux AppImage",
  );
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-desktop-appimage-"));
  try {
    run(appImage, ["--appimage-extract"], { cwd: extractionRoot });
    await verifyRuntimeUnder(extractionRoot);
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}

if (process.platform === "darwin") await verifyMacArtifacts();
else if (process.platform === "win32") await verifyWindowsArtifacts();
else if (process.platform === "linux") await verifyLinuxArtifacts();
else throw new Error(`Unsupported desktop release verification platform: ${process.platform}`);

console.log(`[instafy-desktop] Verified final ${process.platform}/${process.arch} release artifacts.`);
