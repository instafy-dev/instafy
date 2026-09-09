#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, fetch } from "undici";
import {
  DEFAULT_MANAGED_UV_VERSION,
  listManagedUvInstallerArtifacts,
  writeVerifiedManagedUvInstaller,
} from "../../frontend/scripts/shared/speech-managed-runtime.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");
const distScriptRoot = path.join(packageRoot, "dist", "frontend-scripts");

async function withDownloadFetch(fetchImpl, download) {
  if (fetchImpl !== undefined) return download(fetchImpl);

  // Own this invocation's connections without changing fetch for other callers.
  // Undici 6 also supports Node 20, whose built-in fetch ignores proxy env vars.
  const dispatcher = new EnvHttpProxyAgent();
  try {
    const result = await download((url, init) =>
      fetch(url, { ...init, dispatcher }),
    );
    await dispatcher.close();
    return result;
  } catch (error) {
    // Abort remaining parallel downloads as well as releasing idle connections.
    await dispatcher.destroy();
    throw error;
  }
}

async function downloadArtifact({ artifact, outputRoot, fetchImpl }) {
  if (!artifact || typeof artifact.url !== "string") {
    throw new Error("Managed uv installer artifact metadata is missing.");
  }
  const response = await fetchImpl(artifact.url, {
    headers: {
      "cache-control": "no-store",
    },
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } finally {
      throw new Error(
        `Failed to download bundled uv installer (${response.status}) from ${artifact.url}.`,
      );
    }
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

export async function downloadManagedUvInstallerArtifact({
  artifact,
  outputRoot = distScriptRoot,
  fetchImpl,
}) {
  return withDownloadFetch(fetchImpl, (downloadFetch) =>
    downloadArtifact({ artifact, outputRoot, fetchImpl: downloadFetch }),
  );
}

export async function downloadSpeechBootstrapAssets({
  managedUvVersion = DEFAULT_MANAGED_UV_VERSION,
  outputRoot = distScriptRoot,
  fetchImpl,
} = {}) {
  const artifacts = listManagedUvInstallerArtifacts(managedUvVersion);
  if (artifacts.length === 0) {
    throw new Error(
      `Managed uv ${managedUvVersion} has no source-controlled installer trust anchors.`,
    );
  }
  return withDownloadFetch(fetchImpl, (downloadFetch) =>
    Promise.all(
      artifacts.map((artifact) =>
        downloadArtifact({
          artifact,
          outputRoot,
          fetchImpl: downloadFetch,
        }),
      ),
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
