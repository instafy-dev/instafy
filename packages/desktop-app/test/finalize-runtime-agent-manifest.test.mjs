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
  const hostPath = path.join(directory, "codex-code-mode-host");
  const manifestPath = path.join(directory, "runtime-agent-manifest.json");
  fs.writeFileSync(executablePath, "unsigned bytes", { mode: 0o755 });
  fs.writeFileSync(hostPath, "unsigned host bytes", { mode: 0o755 });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 3,
      filename: "runtime-agent",
      platform: "darwin",
      arch: "arm64",
      sizeBytes: 1,
      sha256: "0".repeat(64),
      codeModeHost: { filename: "codex-code-mode-host", sizeBytes: 1, sha256: "0".repeat(64) },
      skillPacks: [],
      sourceSha: "a".repeat(40),
    }),
  );

  finalizeRuntimeAgentManifest(context);
  fs.writeFileSync(executablePath, "signed bytes", { mode: 0o755 });
  fs.writeFileSync(hostPath, "signed host bytes", { mode: 0o755 });
  const finalized = finalizeRuntimeAgentManifest(context).manifest;

  assert.equal(finalized.sourceSha, "a".repeat(40));
  assert.equal(finalized.sizeBytes, Buffer.byteLength("signed bytes"));
  assert.equal(
    finalized.sha256,
    createHash("sha256").update("signed bytes").digest("hex"),
  );
  assert.deepEqual(finalized.codeModeHost, {
    filename: "codex-code-mode-host",
    sizeBytes: Buffer.byteLength("signed host bytes"),
    sha256: createHash("sha256").update("signed host bytes").digest("hex"),
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), finalized);

  // A package that lost the host must not be finalized.
  fs.rmSync(hostPath);
  assert.throws(() => finalizeRuntimeAgentManifest(context), /codex-code-mode-host|ENOENT/);
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
  fs.writeFileSync(path.join(directory, "codex-code-mode-host.exe"), "authenticode-signed host");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 3,
      filename: "runtime-agent.exe",
      platform: "win32",
      arch: "x64",
      sizeBytes: 1,
      sha256: "0".repeat(64),
      codeModeHost: { filename: "codex-code-mode-host.exe", sizeBytes: 1, sha256: "0".repeat(64) },
      skillPacks: [],
      sourceSha: "b".repeat(40),
    }),
  );

  const finalized = finalizeRuntimeAgentManifest(context).manifest;
  assert.equal(finalized.sizeBytes, Buffer.byteLength("authenticode-signed bytes"));
  assert.equal(
    finalized.sha256,
    createHash("sha256").update("authenticode-signed bytes").digest("hex"),
  );
  assert.equal(
    finalized.codeModeHost.sha256,
    createHash("sha256").update("authenticode-signed host").digest("hex"),
  );
});

test("records the packaged skill packs and refuses a package whose packs differ from the staged ones", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-finalize-packs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = {
    appOutDir: root,
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "Instafy Studio" } },
  };
  const directory = path.join(root, "Instafy Studio.app", "Contents", "Resources", "runtime-agent");
  const pack = path.join(directory, "skill-packs", "demo");
  fs.mkdirSync(path.join(pack, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(directory, "runtime-agent"), "bytes", { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "codex-code-mode-host"), "host", { mode: 0o755 });
  fs.writeFileSync(path.join(pack, "SKILL.md"), "# demo\n");
  fs.writeFileSync(path.join(pack, "scripts", "run.mjs"), "run\n");
  const tree = createHash("sha256")
    .update("SKILL.md").update("\0").update("# demo\n").update("\0")
    .update("scripts/run.mjs").update("\0").update("run\n").update("\0")
    .digest("hex");
  fs.writeFileSync(
    path.join(pack, ".instafy-pack.json"),
    JSON.stringify({ schema: 1, name: "demo", version: "0.1.0", tree_sha256: tree }),
  );
  const staged = (skillPacks) =>
    fs.writeFileSync(
      path.join(directory, "runtime-agent-manifest.json"),
      JSON.stringify({
        schemaVersion: 3,
        filename: "runtime-agent",
        platform: "darwin",
        arch: "arm64",
        sizeBytes: 1,
        sha256: "0".repeat(64),
        codeModeHost: { filename: "codex-code-mode-host", sizeBytes: 1, sha256: "0".repeat(64) },
        skillPacks,
        sourceSha: "c".repeat(40),
      }),
    );

  staged([{ name: "demo", version: "0.1.0", tree_sha256: tree }]);
  assert.deepEqual(finalizeRuntimeAgentManifest(context).manifest.skillPacks, [
    { name: "demo", version: "0.1.0", tree_sha256: tree },
  ]);

  // A pack that lost a file, or a package without the staged packs, is not finalized.
  fs.writeFileSync(path.join(pack, "scripts", "run.mjs"), "changed\n");
  assert.throws(() => finalizeRuntimeAgentManifest(context), /does not match its manifest/);
  fs.rmSync(path.join(directory, "skill-packs"), { recursive: true });
  staged([{ name: "demo", version: "0.1.0", tree_sha256: tree }]);
  assert.throws(() => finalizeRuntimeAgentManifest(context), /differ from the staged/);
  // A staged manifest from before skill packs is refused.
  staged(undefined);
  assert.throws(() => finalizeRuntimeAgentManifest(context), /Invalid staged runtime-agent manifest/);
});
