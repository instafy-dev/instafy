const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { describeSkillPacks } = require("./skill-pack-tree.cjs");

const MANIFEST_FILENAME = "runtime-agent-manifest.json";
const STAGED_SKILL_PACKS = path.resolve(__dirname, "..", "build", "runtime-agent", "skill-packs");
const SOURCE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function packagedPlatform(electronPlatformName) {
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") return "darwin";
  if (electronPlatformName === "win32") return "win32";
  if (electronPlatformName === "linux") return "linux";
  throw new Error(`Unsupported packaged runtime platform: ${electronPlatformName}`);
}

function resolvePackagedRuntimeBundle(context) {
  const platform = packagedPlatform(context.electronPlatformName);
  const resourcesPath =
    platform === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  const directory = path.join(resourcesPath, "runtime-agent");
  const suffix = platform === "win32" ? ".exe" : "";
  const filename = `runtime-agent${suffix}`;
  const codeModeHostFilename = `codex-code-mode-host${suffix}`;
  return {
    directory,
    executablePath: path.join(directory, filename),
    filename,
    codeModeHostPath: path.join(directory, codeModeHostFilename),
    codeModeHostFilename,
    manifestPath: path.join(directory, MANIFEST_FILENAME),
    platform,
  };
}

// Size and checksum of a packaged binary, refusing anything but a regular file.
function describeBinary(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Unsafe packaged ${label}: ${filePath}`);
  }
  return {
    sizeBytes: stats.size,
    sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
  };
}

function requireStagedManifest(manifestPath, expected) {
  const stats = fs.lstatSync(manifestPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
    throw new Error(`Unsafe staged runtime-agent manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    !manifest ||
    manifest.schemaVersion !== 3 ||
    manifest.filename !== expected.filename ||
    manifest.codeModeHost?.filename !== expected.codeModeHostFilename ||
    manifest.platform !== expected.platform ||
    typeof manifest.arch !== "string" ||
    !Array.isArray(manifest.skillPacks) ||
    !SOURCE_SHA_PATTERN.test(manifest.sourceSha || "")
  ) {
    throw new Error(`Invalid staged runtime-agent manifest: ${manifestPath}`);
  }
  return manifest;
}

// electron-builder leaves some file names out of everything it copies, extraResources included
// (.gitkeep, .gitignore, .npmignore and the like), so a pack holding one arrived without it and
// failed its manifest. Copy back exactly the staged files missing from a packaged pack. A pack that
// is missing as a whole is not restored, and a file that is present but different is left alone,
// so both still fail the checks below.
function restoreDroppedSkillPackFiles(stagedRoot, packagedRoot) {
  if (!fs.existsSync(stagedRoot) || !fs.existsSync(packagedRoot)) return [];
  const restored = [];
  const walk = (packDir, rel) => {
    for (const entry of fs.readdirSync(path.join(stagedRoot, packDir, rel), { withFileTypes: true })) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Staged skill pack ${packDir} holds a link: ${child}`);
      if (entry.isDirectory()) {
        walk(packDir, child);
      } else if (entry.isFile()) {
        const source = path.join(stagedRoot, packDir, child);
        const target = path.join(packagedRoot, packDir, child);
        if (fs.existsSync(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, fs.statSync(source).mode & 0o777);
        restored.push(path.join(packDir, child));
      }
    }
  };
  for (const entry of fs.readdirSync(stagedRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(packagedRoot, entry.name))) walk(entry.name, "");
  }
  return restored;
}

// The packaged skill packs, each checked against its manifest, must be exactly the staged ones.
function requirePackagedSkillPacks(directory, staged) {
  const packaged = describeSkillPacks(path.join(directory, "skill-packs"));
  const expected = [...staged].sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(packaged) !== JSON.stringify(expected)) {
    throw new Error(
      `Packaged skill packs ${JSON.stringify(packaged)} differ from the staged ${JSON.stringify(expected)}`,
    );
  }
  return packaged;
}

function finalizeRuntimeAgentManifest(context, { stagedSkillPacksRoot = STAGED_SKILL_PACKS } = {}) {
  const bundle = resolvePackagedRuntimeBundle(context);
  const staged = requireStagedManifest(bundle.manifestPath, bundle);
  const restored = restoreDroppedSkillPackFiles(stagedSkillPacksRoot, path.join(bundle.directory, "skill-packs"));
  if (restored.length > 0) {
    console.log(`[instafy-desktop] Restored skill pack files electron-builder left out: ${restored.join(", ")}`);
  }
  const skillPacks = requirePackagedSkillPacks(bundle.directory, staged.skillPacks);
  const manifest = {
    schemaVersion: 3,
    filename: bundle.filename,
    platform: bundle.platform,
    arch: staged.arch,
    ...describeBinary(bundle.executablePath, "runtime-agent executable"),
    codeModeHost: {
      filename: bundle.codeModeHostFilename,
      ...describeBinary(bundle.codeModeHostPath, "code-mode host"),
    },
    skillPacks,
    sourceSha: staged.sourceSha,
  };
  const temporaryPath = `${bundle.manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  fs.renameSync(temporaryPath, bundle.manifestPath);
  console.log(
    `[instafy-desktop] Finalized packaged runtime-agent manifest (${manifest.platform}/${manifest.arch}, source=${manifest.sourceSha}).`,
  );
  return { ...bundle, manifest };
}

async function afterPack(context) {
  finalizeRuntimeAgentManifest(context);
}

module.exports = afterPack;
module.exports.finalizeRuntimeAgentManifest = finalizeRuntimeAgentManifest;
module.exports.resolvePackagedRuntimeBundle = resolvePackagedRuntimeBundle;
