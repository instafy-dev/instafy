#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseRegistration } from "./lib/otaReleaseHelpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [key, inlineValue] = arg.split("=", 2);
    if (inlineValue !== undefined) {
      options.set(key, inlineValue);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      options.set(key, "true");
      continue;
    }
    options.set(key, value);
    index += 1;
  }
  return options;
}

function repoRelative(targetPath) {
  return path.relative(repoRoot, targetPath) || ".";
}

function writeGitHubOutputs(outputPath, values) {
  if (!outputPath) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = args.get("--manifest");
const artifactUrl = args.get("--artifact-url");
const platform = args.get("--platform");
const channel = args.get("--channel");
const nativeVersion = args.get("--native-version");

if (!manifestPath || !artifactUrl || !platform || !channel || !nativeVersion) {
  console.error(
    "[ota:release-payload] Required args: --manifest --artifact-url --platform --channel --native-version"
  );
  process.exit(1);
}

const resolvedManifestPath = path.resolve(repoRoot, manifestPath);
const manifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
const signature = args.has("--signature") ? args.get("--signature") || null : undefined;
const payload = buildReleaseRegistration({
  manifest,
  artifactUrl,
  platform,
  channel,
  nativeVersion,
  minSupportedNativeVersion: args.get("--min-supported-native-version") || nativeVersion,
  rolloutPercentage: Number.parseInt(args.get("--rollout-percentage") || "100", 10),
  status: args.get("--status") || "draft",
  notes: args.get("--notes") || null,
  publishedAt: args.get("--published-at") || new Date().toISOString(),
  publishedBy: args.get("--published-by") || "github-actions",
  signature,
});

const outPath = path.resolve(
  repoRoot,
  args.get("--out") ||
    path.join(path.dirname(resolvedManifestPath), `${platform}-${channel}-${manifest.bundle_version}.release.json`)
);

fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

writeGitHubOutputs(process.env.GITHUB_OUTPUT, {
  ota_release_payload_path: repoRelative(outPath),
  ota_release_id: payload.release_id,
});

console.log(`[ota:release-payload] release_id=${payload.release_id}`);
console.log(`[ota:release-payload] payload=${repoRelative(outPath)}`);
