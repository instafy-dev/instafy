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
  const filename = process.platform === "win32" ? "runtime-agent.exe" : "runtime-agent";
  const executablePath = path.join(directory, filename);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(executablePath, "verified runtime fixture", { mode: 0o755 });
  const contents = await fs.promises.readFile(executablePath);
  const hostFilename = process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
  const hostPath = path.join(directory, hostFilename);
  await fs.promises.writeFile(hostPath, "verified code-mode host fixture", { mode: 0o755 });
  const hostContents = await fs.promises.readFile(hostPath);
  const manifest = {
    schemaVersion: 3,
    filename,
    platform: process.platform,
    arch: process.arch,
    sizeBytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
    sourceSha: "a".repeat(40),
    codeModeHost: {
      filename: hostFilename,
      sizeBytes: hostContents.byteLength,
      sha256: createHash("sha256").update(hostContents).digest("hex"),
    },
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


test("requires an intact code-mode host from the same verified bundle", async (t) => {
  for (const mutation of ["missing", "tampered", "wrong-name", "legacy-manifest"]) {
    const value = await fixture();
    t.after(() => fs.rmSync(value.resourcesPath, { recursive: true, force: true }));
    if (mutation === "missing") await fs.promises.unlink(value.hostPath);
    if (mutation === "tampered") {
      // Preserve size to prove the digest is checked too.
      await fs.promises.writeFile(value.hostPath, "x".repeat(value.manifest.codeModeHost.sizeBytes));
    }
    if (mutation === "wrong-name" || mutation === "legacy-manifest") {
      const manifest = mutation === "wrong-name"
        ? { ...value.manifest, codeModeHost: { ...value.manifest.codeModeHost, filename: "other-host" } }
        : { ...value.manifest, schemaVersion: 2 };
      await fs.promises.writeFile(path.join(value.resourcesPath, "runtime-agent", "runtime-agent-manifest.json"), JSON.stringify(manifest));
    }
    await assert.rejects(resolveVerifiedBundledRuntimeAgent({ resourcesPath: value.resourcesPath }));
  }
});
