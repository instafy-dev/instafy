#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MANAGED_UV_VERSION,
  listManagedUvInstallerArtifacts,
  writeVerifiedManagedUvInstaller,
} from "../../frontend/scripts/shared/speech-managed-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const distScriptRoot = path.join(packageRoot, "dist", "frontend-scripts");

export async function downloadManagedUvInstallerArtifact({
  artifact,
  outputRoot = distScriptRoot,
  fetchImpl = globalThis.fetch,
}) {
  if (!artifact || typeof artifact.url !== "string") {
    throw new Error("Managed uv installer artifact metadata is missing.");
  }
  const response = await fetchImpl(artifact.url, {
    headers: {
      "cache-control": "no-store",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download bundled uv installer (${response.status}) from ${artifact.url}.`,
    );
  }
  const installerContent = Buffer.from(await response.arrayBuffer());
  const targetPath = path.join(
    outputRoot,
    "vendor",
    "uv",
    artifact.version,
    artifact.fileName,
  );
  const sha256 = await writeVerifiedManagedUvInstaller(
    targetPath,
    installerContent,
    artifact,
  );
  return {
    sha256,
    sourceUrl: artifact.url,
    targetPath,
  };
}

export async function downloadSpeechBootstrapAssets({
  managedUvVersion = DEFAULT_MANAGED_UV_VERSION,
  outputRoot = distScriptRoot,
  fetchImpl = globalThis.fetch,
} = {}) {
  const artifacts = listManagedUvInstallerArtifacts(managedUvVersion);
  if (artifacts.length === 0) {
    throw new Error(
      `Managed uv ${managedUvVersion} has no source-controlled installer trust anchors.`,
    );
  }
  return Promise.all(
    artifacts.map((artifact) =>
      downloadManagedUvInstallerArtifact({
        artifact,
        outputRoot,
        fetchImpl,
      }),
    ),
  );
}

async function main() {
  const results = await downloadSpeechBootstrapAssets();
  for (const result of results) {
    console.log(
      `Bundled verified Desktop speech bootstrap asset at ${result.targetPath} (sha256:${result.sha256})`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
