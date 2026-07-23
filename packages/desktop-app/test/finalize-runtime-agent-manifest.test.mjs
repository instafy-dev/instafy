import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { finalizeRuntimeAgentManifest } = require(
  path.join(packageRoot, "scripts", "finalize-runtime-agent-manifest.cjs"),
);

test("finalizes the manifest over the exact post-sign runtime bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-finalize-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = {
    appOutDir: root,
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "Instafy Studio" } },
  };
  const directory = path.join(
    root,
    "Instafy Studio.app",
    "Contents",
    "Resources",
    "runtime-agent",
  );
  fs.mkdirSync(directory, { recursive: true });
  const executablePath = path.join(directory, "runtime-agent");
  const manifestPath = path.join(directory, "runtime-agent-manifest.json");
  fs.writeFileSync(executablePath, "unsigned bytes", { mode: 0o755 });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      filename: "runtime-agent",
      platform: "darwin",
      arch: "arm64",
      sizeBytes: 1,
      sha256: "0".repeat(64),
      sourceSha: "a".repeat(40),
    }),
  );

  finalizeRuntimeAgentManifest(context);
  fs.writeFileSync(executablePath, "signed bytes", { mode: 0o755 });
  const finalized = finalizeRuntimeAgentManifest(context).manifest;

  assert.equal(finalized.sourceSha, "a".repeat(40));
  assert.equal(finalized.sizeBytes, Buffer.byteLength("signed bytes"));
  assert.equal(
    finalized.sha256,
    createHash("sha256").update("signed bytes").digest("hex"),
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), finalized);
});

test("finalizes the Windows runtime in the signed app directory before NSIS packing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-finalize-runtime-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = {
    appOutDir: root,
    electronPlatformName: "win32",
    packager: { appInfo: { productFilename: "Instafy Studio" } },
  };
  const directory = path.join(root, "resources", "runtime-agent");
  fs.mkdirSync(directory, { recursive: true });
  const executablePath = path.join(directory, "runtime-agent.exe");
  const manifestPath = path.join(directory, "runtime-agent-manifest.json");
  fs.writeFileSync(executablePath, "authenticode-signed bytes");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      filename: "runtime-agent.exe",
      platform: "win32",
      arch: "x64",
      sizeBytes: 1,
      sha256: "0".repeat(64),
      sourceSha: "b".repeat(40),
    }),
  );

  const finalized = finalizeRuntimeAgentManifest(context).manifest;
  assert.equal(finalized.sizeBytes, Buffer.byteLength("authenticode-signed bytes"));
  assert.equal(
    finalized.sha256,
    createHash("sha256").update("authenticode-signed bytes").digest("hex"),
  );
});
