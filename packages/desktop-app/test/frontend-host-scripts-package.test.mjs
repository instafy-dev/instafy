import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  downloadManagedUvInstallerArtifact,
  downloadSpeechBootstrapAssets,
} from "../scripts/download-speech-bootstrap-assets.mjs";
import {
  DESKTOP_FRONTEND_RUNTIME_FILES,
  syncFrontendHostScripts,
} from "../scripts/sync-frontend-host-scripts.mjs";
import {
  assertManagedUvInstallerIntegrity,
  listManagedUvInstallerArtifacts,
  readVerifiedManagedUvInstaller,
  resolveManagedUvInstallerArtifact,
  writeVerifiedManagedUvInstaller,
} from "../../frontend/scripts/shared/speech-managed-runtime.mjs";
import { buildManagedUvInstallerEnv } from "../../frontend/scripts/speech-backend-bootstrap.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..");
const frontendScriptRoot = path.resolve(packageRoot, "..", "frontend", "scripts");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function createTestUvInstallerArtifact(content) {
  return {
    fileName: "install.sh",
    platform: "posix",
    releaseFileName: "uv-installer.sh",
    sha256: sha256(content),
    url: "https://example.test/uv-installer.sh",
    version: "test",
  };
}

function createFetchResponse(content, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async arrayBuffer() {
      return content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      );
    },
  };
}

async function listFiles(directory, relativeDirectory = "") {
  const entries = await fs.readdir(path.join(directory, relativeDirectory), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relativePath)));
    } else {
      assert.equal(entry.isFile(), true, `unexpected packaged entry: ${relativePath}`);
      files.push(relativePath);
    }
  }
  return files.sort();
}

test("Desktop packages only its allowlisted frontend runtime closure", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-runtime-files-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const outputRoot = path.join(tempRoot, "frontend-scripts");

  await syncFrontendHostScripts({
    runtimeSourceDir: frontendScriptRoot,
    runtimeTargetDir: outputRoot,
  });

  const packagedFiles = await listFiles(outputRoot);
  assert.deepEqual(packagedFiles, [...DESKTOP_FRONTEND_RUNTIME_FILES].sort());

  for (const required of [
    "local-speech-service.mjs",
    "speech-backend-bootstrap.mjs",
    "local-provider-host.mjs",
    "local-provider-host-server.mjs",
    "local-provider-registry.mjs",
    "local-provider-feature-module.mjs",
    "current-local-provider-registry.mjs",
    "public-local-provider-feature-manifest.mjs",
    "public-core-local-provider-feature-module.mjs",
    "providers/camera-provider.mjs",
    "providers/local-device-toggle-provider.mjs",
    "providers/speech-provider.mjs",
    "shared/audio-artifact.mjs",
    "shared/openai-speech-backend.mjs",
    "shared/speech-host-config.mjs",
    "shared/speech-managed-runtime.mjs",
    "local-provider-host.config.json",
  ]) {
    assert.equal(packagedFiles.includes(required), true, `missing runtime file: ${required}`);
  }

  for (const forbidden of [
    "dev.mjs",
    "dev-prod.mjs",
    "playwright-test.mjs",
    "local-provider-feature-manifest-selector.mjs",
    "local-provider-feature-module.test.mjs",
    "local-provider-host-server.test.mjs",
    "prod-ui-smoke.mjs",
    "prod-cross-client-chat-smoke.mjs",
    "speech-fixture-check.mjs",
  ]) {
    assert.equal(packagedFiles.includes(forbidden), false, `packaged non-runtime script: ${forbidden}`);
  }

  const manifest = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  for (const dependency of [
    "@instafy/provider-client",
    "@instafy/provider-contract",
    "@instafy/sdk",
  ]) {
    assert.equal(
      manifest.dependencies?.[dependency],
      "workspace:*",
      `missing Desktop runtime package dependency: ${dependency}`,
    );
  }
});

test("Desktop packaging fails closed on an unallowlisted runtime dependency", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "instafy-desktop-runtime-closure-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(tempRoot, "source");
  const outputRoot = path.join(tempRoot, "output");

  for (const file of DESKTOP_FRONTEND_RUNTIME_FILES) {
    const filePath = path.join(sourceRoot, ...file.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, file.endsWith(".json") ? "{}\n" : "", "utf8");
  }
  await fs.writeFile(
    path.join(sourceRoot, "local-speech-service.mjs"),
    'import "./not-allowlisted.mjs";\n',
    "utf8",
  );
  await fs.writeFile(path.join(sourceRoot, "not-allowlisted.mjs"), "", "utf8");

  await assert.rejects(
    syncFrontendHostScripts({
      runtimeSourceDir: sourceRoot,
      runtimeTargetDir: outputRoot,
    }),
    /runtime dependency is not allowlisted: local-speech-service\.mjs -> not-allowlisted\.mjs/u,
  );
});

test("managed uv 0.11.6 resolves only source-controlled immutable release artifacts", () => {
  assert.deepEqual(listManagedUvInstallerArtifacts("missing"), []);
  assert.equal(resolveManagedUvInstallerArtifact("missing", "darwin"), null);

  assert.deepEqual(resolveManagedUvInstallerArtifact("0.11.6", "darwin"), {
    fileName: "install.sh",
    platform: "posix",
    releaseFileName: "uv-installer.sh",
    sha256: "02f6fdf8077f97f7bbd901de06054a65e7aefbd54432c8a83784d42a3e360a45",
    url: "https://github.com/astral-sh/uv/releases/download/0.11.6/uv-installer.sh",
    version: "0.11.6",
  });
  assert.deepEqual(resolveManagedUvInstallerArtifact("0.11.6", "win32"), {
    fileName: "install.ps1",
    platform: "win32",
    releaseFileName: "uv-installer.ps1",
    sha256: "46da9313591884d09aa4f06f7f78f74154ea01a8012d425ed090163d4799295c",
    url: "https://github.com/astral-sh/uv/releases/download/0.11.6/uv-installer.ps1",
    version: "0.11.6",
  });
});

test("managed uv installer integrity rejects missing trust anchors and changed bytes", () => {
  const trustedContent = Buffer.from("#!/bin/sh\nexit 0\n");
  const artifact = createTestUvInstallerArtifact(trustedContent);

  assert.equal(
    assertManagedUvInstallerIntegrity(trustedContent, artifact),
    artifact.sha256,
  );
  assert.throws(
    () =>
      assertManagedUvInstallerIntegrity(Buffer.from("#!/bin/sh\nexit 1\n"), artifact),
    /integrity check failed/u,
  );
  assert.throws(
    () =>
      assertManagedUvInstallerIntegrity(trustedContent, {
        ...artifact,
        sha256: "REVIEW_REQUIRED",
      }),
    /no source-controlled SHA-256 trust anchor/u,
  );
});

test("managed uv installer execution strips ambient artifact URL overrides", () => {
  const env = buildManagedUvInstallerEnv(
    {
      binDir: "/managed/bin",
      pythonInstallDir: "/managed/python",
      uvCacheDir: "/managed/cache",
    },
    {
      HTTPS_PROXY: "https://proxy.example.test",
      INSTALLER_DOWNLOAD_URL: "https://untrusted.example.test",
      UV_DOWNLOAD_URL: "https://untrusted.example.test",
      UV_INSTALLER_GHE_BASE_URL: "https://untrusted.example.test",
      UV_INSTALLER_GITHUB_BASE_URL: "https://untrusted.example.test",
      UV_UNMANAGED_INSTALL: "/untrusted/bin",
    },
  );

  assert.equal(env.HTTPS_PROXY, "https://proxy.example.test");
  assert.equal(env.UV_UNMANAGED_INSTALL, "/managed/bin");
  assert.equal(env.UV_NO_MODIFY_PATH, "1");
  for (const name of [
    "INSTALLER_DOWNLOAD_URL",
    "UV_DOWNLOAD_URL",
    "UV_INSTALLER_GHE_BASE_URL",
    "UV_INSTALLER_GITHUB_BASE_URL",
  ]) {
    assert.equal(name in env, false);
  }
});

test("verified installer writes are atomic with respect to integrity failure", async (t) => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "instafy-managed-uv-integrity-"),
  );
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const targetPath = path.join(tempRoot, "install.sh");
  const trustedContent = Buffer.from("#!/bin/sh\nexit 0\n");
  const artifact = createTestUvInstallerArtifact(trustedContent);

  await writeVerifiedManagedUvInstaller(targetPath, trustedContent, artifact);
  assert.deepEqual(
    await readVerifiedManagedUvInstaller(targetPath, artifact),
    trustedContent,
  );

  await assert.rejects(
    writeVerifiedManagedUvInstaller(
      targetPath,
      Buffer.from("#!/bin/sh\nexit 1\n"),
      artifact,
    ),
    /integrity check failed/u,
  );
  assert.deepEqual(await fs.readFile(targetPath), trustedContent);
});

test("Desktop asset download verifies bytes before publishing them", async (t) => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "instafy-managed-uv-download-"),
  );
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const trustedContent = Buffer.from("#!/bin/sh\nexit 0\n");
  const artifact = createTestUvInstallerArtifact(trustedContent);
  const expectedTarget = path.join(
    tempRoot,
    "vendor",
    "uv",
    artifact.version,
    artifact.fileName,
  );

  const result = await downloadManagedUvInstallerArtifact({
    artifact,
    outputRoot: tempRoot,
    fetchImpl: async () => createFetchResponse(trustedContent),
  });
  assert.equal(result.targetPath, expectedTarget);
  assert.equal(result.sha256, artifact.sha256);
  assert.deepEqual(await fs.readFile(expectedTarget), trustedContent);

  await assert.rejects(
    downloadManagedUvInstallerArtifact({
      artifact,
      outputRoot: tempRoot,
      fetchImpl: async () =>
        createFetchResponse(Buffer.from("#!/bin/sh\nexit 1\n")),
    }),
    /integrity check failed/u,
  );
  assert.deepEqual(await fs.readFile(expectedTarget), trustedContent);
});

test("Desktop asset download refuses versions without checked-in trust anchors", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    downloadSpeechBootstrapAssets({
      managedUvVersion: "0.11.7",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not fetch");
      },
    }),
    /no source-controlled installer trust anchors/u,
  );
  assert.equal(fetchCalls, 0);
});
