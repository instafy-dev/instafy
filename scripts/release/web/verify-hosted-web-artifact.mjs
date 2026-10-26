#!/usr/bin/env node
// Gate for the built hosted web artifact, before it is sealed:
// - dist is a real directory with index.html and at least two regular files;
// - no symbolic links, special files, source maps or environment files;
// - instafy-build.json is exactly {schemaVersion:2, releaseId} for the commit;
// - the bundle carries the release commit and all three hosted feature modules
//   (so a build that silently fell back to the public manifest is refused);
// - no private paths, hosts, networks, package markers or credential shapes.
//
// Usage: node verify-hosted-web-artifact.mjs <dist> <source-sha>

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { computeHostedReleaseId } from "./release-id.mjs";

const PRODUCT = ["kno", "sh"].join("");
export const REQUIRED_FEATURE_MODULE_IDS = Object.freeze([
  "instafy.public-core",
  `${PRODUCT}.frontend`,
  "instafy.hosted-performance",
]);

const FORBIDDEN_CONTENT = Object.freeze([
  ["absolute personal filesystem path", new RegExp(["\\/Us", "ers\\/[A-Za-z0-9._-]+"].join(""), "u")],
  ["internal network address", new RegExp(["(?:^|[^0-9])10", "\\.42\\."].join(""), "u")],
  ["internal hostname", new RegExp(["inter", "nal\\.instafy\\.dev"].join(""), "iu")],
  ["GitHub token", new RegExp(["gh[pousr]_[A-Za-z0-9]{36,}", ["github", "_pat_[A-Za-z0-9_]{60,}"].join("")].join("|"), "u")],
  ["OpenAI API key", /(?:^|[^A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/u],
  ["private key material", new RegExp(["-----BEGIN (?:EC |OPENSSH |RSA )?PRI", "VATE KEY-----"].join(""), "u")],
  ["browser-exposed service-role identifier", /\bVITE_[A-Z0-9_]*SERVICE_ROLE(?:_[A-Z0-9_]+)?\b/iu],
  ["server-side service-role identifier", /\bSUPABASE_SERVICE_ROLE_KEY\b/u],
  ["Supabase secret key", new RegExp(["sb_", "secret_"].join(""), "u")],
  ["private package marker", new RegExp([["operator", "console"], ["org", "credits"], ["infra", "pulumi"], [PRODUCT, "contract"]].map((parts) => parts.join("-")).join("|"), "iu")],
  [
    "private source path",
    new RegExp(
      [["\\.private", "-deps[/\\\\]"], ["instafy-", "inter", "nal[/\\\\]"], ["[/\\\\]overlays[/\\\\]"], ["packages[/\\\\]frontend[/\\\\]hosted[/\\\\]"]]
        .map((parts) => parts.join(""))
        .join("|"),
      "iu",
    ),
  ],
  ["private environment directory identifier", /\bINSTAFY_ENV_DIR\b/u],
]);

function fail(message) {
  throw new Error(message);
}

function walk(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) fail(`The hosted web artifact contains a symbolic link: ${relativePath}`);
      if (stat.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!stat.isFile()) fail(`The hosted web artifact contains a non-regular file: ${relativePath}`);
      if (relativePath.endsWith(".map")) fail(`The hosted web artifact contains a source map: ${relativePath}`);
      if (/(?:^|\/)\.env(?:\.|$)/u.test(relativePath)) fail(`The hosted web artifact contains an environment file: ${relativePath}`);
      files.push({ absolutePath, relativePath });
    }
  }
  return files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1));
}

export function verifyHostedWebArtifact({ distPath, sourceSha }) {
  const releaseId = computeHostedReleaseId(sourceSha);
  const root = path.resolve(distPath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("The hosted web artifact root must be a real directory");
  if (!fs.lstatSync(path.join(root, "index.html")).isFile()) fail("The hosted web artifact is missing index.html");
  for (const reserved of ["_worker.js", "functions"]) {
    if (fs.existsSync(path.join(root, reserved))) fail(`The hosted web artifact must not deploy Pages Functions or a worker: ${reserved}`);
  }

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(root, "instafy-build.json"), "utf8"));
  } catch {
    fail("instafy-build.json is missing or invalid");
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(["releaseId", "schemaVersion"]) ||
    metadata.schemaVersion !== 2 ||
    metadata.releaseId !== releaseId
  ) {
    fail("instafy-build.json is not the exact release metadata for this commit");
  }

  const files = walk(root);
  if (files.length < 2) fail("The hosted web artifact is unexpectedly empty");
  let carriesSource = false;
  const modules = new Set();
  for (const file of files) {
    const contents = fs.readFileSync(file.absolutePath).toString("utf8");
    for (const [label, pattern] of FORBIDDEN_CONTENT) {
      if (pattern.test(contents)) fail(`The hosted web artifact contains ${label} in ${file.relativePath}`);
    }
    carriesSource ||= contents.includes(sourceSha);
    if (/^assets\/[^/]+\.js$/u.test(file.relativePath)) {
      for (const id of REQUIRED_FEATURE_MODULE_IDS) {
        if (contents.includes(`"${id}"`)) modules.add(id);
      }
    }
  }
  if (!carriesSource) fail("The hosted web artifact does not carry its release commit");
  const missing = REQUIRED_FEATURE_MODULE_IDS.filter((id) => !modules.has(id));
  if (missing.length > 0) fail(`The hosted web artifact lacks feature modules: ${missing.join(", ")}`);
  return { releaseId, files: files.map((file) => file.relativePath) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) fail("Usage: verify-hosted-web-artifact.mjs <dist> <source-sha>");
    const result = verifyHostedWebArtifact({ distPath: process.argv[2], sourceSha: process.argv[3] });
    console.log(`[web-release] Hosted web artifact gate passed (${result.files.length} files; release ${result.releaseId}).`);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
