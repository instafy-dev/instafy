import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { resolveVerifiedBundledRuntimeAgent } = await import(
  path.join(packageRoot, "dist", "bundledRuntimeAgent.js")
);

async function fixture() {
  const resourcesPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instafy-bundled-runtime-"));
  const directory = path.join(resourcesPath, "runtime-agent");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const filename = `runtime-agent${suffix}`;
  const hostFilename = `codex-code-mode-host${suffix}`;
  const executablePath = path.join(directory, filename);
  const hostPath = path.join(directory, hostFilename);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(executablePath, "verified runtime fixture", { mode: 0o755 });
  await fs.promises.writeFile(hostPath, "verified code-mode host fixture", { mode: 0o755 });
  const describe = async (file) => {
    const contents = await fs.promises.readFile(file);
    return {
      sizeBytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  };
  const manifest = {
    schemaVersion: 3,
    filename,
    platform: process.platform,
    arch: process.arch,
    ...(await describe(executablePath)),
    codeModeHost: { filename: hostFilename, ...(await describe(hostPath)) },
    sourceSha: "a".repeat(40),
  };
  await fs.promises.writeFile(
    path.join(directory, "runtime-agent-manifest.json"),
    JSON.stringify(manifest),
  );
  return { resourcesPath, executablePath, hostPath, manifest };
}

test("resolves only the platform-matched checksum-verified bundled runtime", async (t) => {
  const value = await fixture();
  t.after(() => fs.rmSync(value.resourcesPath, { recursive: true, force: true }));
  assert.equal(
    await resolveVerifiedBundledRuntimeAgent({ resourcesPath: value.resourcesPath }),
    value.executablePath,
  );
});

test("rejects tampered, mismatched, and symlinked bundled runtimes", async (t) => {
  const tampered = await fixture();
  t.after(() => fs.rmSync(tampered.resourcesPath, { recursive: true, force: true }));
  await fs.promises.appendFile(tampered.executablePath, "tampered");
  await assert.rejects(
    resolveVerifiedBundledRuntimeAgent({ resourcesPath: tampered.resourcesPath }),
    /size does not match/,
  );

  const mismatched = await fixture();
  t.after(() => fs.rmSync(mismatched.resourcesPath, { recursive: true, force: true }));
  await fs.promises.writeFile(
    path.join(mismatched.resourcesPath, "runtime-agent", "runtime-agent-manifest.json"),
    JSON.stringify({ ...mismatched.manifest, arch: "not-this-architecture" }),
  );
  await assert.rejects(
    resolveVerifiedBundledRuntimeAgent({ resourcesPath: mismatched.resourcesPath }),
    /targets .*\/not-this-architecture/,
  );

  const untraceable = await fixture();
  t.after(() => fs.rmSync(untraceable.resourcesPath, { recursive: true, force: true }));
  await fs.promises.writeFile(
    path.join(untraceable.resourcesPath, "runtime-agent", "runtime-agent-manifest.json"),
    JSON.stringify({ ...untraceable.manifest, sourceSha: "not-a-full-source-sha" }),
  );
  await assert.rejects(
    resolveVerifiedBundledRuntimeAgent({ resourcesPath: untraceable.resourcesPath }),
    /manifest is invalid/,
  );

  if (process.platform !== "win32") {
    const linked = await fixture();
    t.after(() => fs.rmSync(linked.resourcesPath, { recursive: true, force: true }));
    await fs.promises.unlink(linked.executablePath);
    await fs.promises.symlink(process.execPath, linked.executablePath);
    await assert.rejects(
      resolveVerifiedBundledRuntimeAgent({ resourcesPath: linked.resourcesPath }),
      /missing or unsafe/,
    );
  }
});

test("rejects a bundle whose code-mode host is missing, tampered, or not listed", async (t) => {
  const missing = await fixture();
  t.after(() => fs.rmSync(missing.resourcesPath, { recursive: true, force: true }));
  await fs.promises.unlink(missing.hostPath);
  await assert.rejects(
    resolveVerifiedBundledRuntimeAgent({ resourcesPath: missing.resourcesPath }),
    /code-mode host is missing or unsafe/,
  );

  const tampered = await fixture();
  t.after(() => fs.rmSync(tampered.resourcesPath, { recursive: true, force: true }));
  const hostBytes = await fs.promises.readFile(tampered.hostPath);
  hostBytes[0] ^= 0xff;
  await fs.promises.writeFile(tampered.hostPath, hostBytes);
  await assert.rejects(
    resolveVerifiedBundledRuntimeAgent({ resourcesPath: tampered.resourcesPath }),
    /code-mode host failed checksum verification/,
  );

  const unlisted = await fixture();
  t.after(() => fs.rmSync(unlisted.resourcesPath, { recursive: true, force: true }));
  const { codeModeHost: _host, ...withoutHost } = unlisted.manifest;
  await fs.promises.writeFile(
    path.join(unlisted.resourcesPath, "runtime-agent", "runtime-agent-manifest.json"),
    JSON.stringify({ ...withoutHost, schemaVersion: 2 }),
  );
  await assert.rejects(
    resolveVerifiedBundledRuntimeAgent({ resourcesPath: unlisted.resourcesPath }),
    /manifest is invalid/,
  );
});
