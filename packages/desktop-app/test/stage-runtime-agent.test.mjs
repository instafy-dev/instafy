import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("stages the prebuilt runtime and matching host, and refuses an absent host", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-stage-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "packages", "desktop-app", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const script = path.join(scripts, "stage-runtime-agent.mjs");
  fs.copyFileSync(path.join(packageRoot, "scripts", "stage-runtime-agent.mjs"), script);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const prebuilt = path.join(root, `runtime-agent${suffix}`);
  const host = path.join(root, `codex-code-mode-host${suffix}`);
  fs.writeFileSync(prebuilt, "runtime fixture", { mode: 0o755 });
  fs.writeFileSync(host, "host fixture", { mode: 0o755 });
  const options = {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      INSTAFY_RUNTIME_AGENT_PREBUILT: prebuilt,
      INSTAFY_SOURCE_SHA: "a".repeat(40),
    },
  };
  const staged = spawnSync(process.execPath, [script], options);
  assert.equal(staged.status, 0, staged.stderr);
  const output = path.join(root, "packages", "desktop-app", "build", "runtime-agent");
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "runtime-agent-manifest.json")));
  assert.equal(manifest.schemaVersion, 3);
  assert.deepEqual(manifest.codeModeHost, {
    filename: path.basename(host),
    sizeBytes: Buffer.byteLength("host fixture"),
    sha256: createHash("sha256").update("host fixture").digest("hex"),
  });
  assert.equal(fs.readFileSync(path.join(output, path.basename(host)), "utf8"), "host fixture");
  fs.unlinkSync(host);
  const missing = spawnSync(process.execPath, [script], options);
  assert.notEqual(missing.status, 0);
  assert.equal(fs.existsSync(path.join(output, "runtime-agent-manifest.json")), false);
});

test("native staging selects fresh target-specific artifacts despite inherited Cargo output settings", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-stage-native-runtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "packages", "desktop-app", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const script = path.join(scripts, "stage-runtime-agent.mjs");
  fs.copyFileSync(path.join(packageRoot, "scripts", "stage-runtime-agent.mjs"), script);
  const host = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu"}`;
  const suffix = process.platform === "win32" ? ".exe" : "";
  const targetDir = path.join(root, "packages", "runtime-agent", "target");
  const staleDir = path.join(targetDir, "release");
  fs.mkdirSync(staleDir, { recursive: true });
  for (const name of ["runtime-agent", "codex-code-mode-host"]) {
    fs.writeFileSync(path.join(staleDir, `${name}${suffix}`), `stale ${name}`);
  }
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "runtime-cargo.mjs"), `
    import fs from "node:fs";
    import path from "node:path";
    import assert from "node:assert/strict";
    const args = process.argv.slice(2);
    if (args[0] === "--print-host-target") {
      console.log(${JSON.stringify(host)});
    } else {
      assert.equal(args[args.indexOf("--target") + 1], ${JSON.stringify(host)});
      assert.equal(args[args.indexOf("--target-dir") + 1], ${JSON.stringify(targetDir)});
      assert.ok(args.includes("--bins"));
      assert.equal(process.env.CARGO_BUILD_TARGET, "unrelated-target");
      const output = path.join(${JSON.stringify(targetDir)}, ${JSON.stringify(host)}, "release");
      fs.mkdirSync(output, {recursive: true});
      for (const name of ["runtime-agent", "codex-code-mode-host"]) {
        fs.writeFileSync(path.join(output, name + ${JSON.stringify(suffix)}), "fresh " + name);
      }
    }
  `);
  const staged = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      CARGO_BUILD_TARGET: "unrelated-target",
      CARGO_TARGET_DIR: path.join(root, "other-target"),
      INSTAFY_SOURCE_SHA: "b".repeat(40),
    },
  });
  assert.equal(staged.status, 0, staged.stderr);
  const output = path.join(root, "packages", "desktop-app", "build", "runtime-agent");
  for (const name of ["runtime-agent", "codex-code-mode-host"]) {
    assert.equal(fs.readFileSync(path.join(output, `${name}${suffix}`), "utf8"), `fresh ${name}`);
  }
});
