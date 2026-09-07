import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactNames, parseChecksums, resolvedV8Version, resolveTarget, resolveHostTarget, validateTargetConfiguration, resolveV8Environment, runRuntimeCargo } from "./runtime-cargo.mjs";

const target = "aarch64-apple-darwin";
const names = artifactNames(target);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const lock = 'version = 4\n\n[[package]]\nname = "v8"\nversion = "150.4.0"\n';
const contents = { [names.archive]: "inert archive fixture", [names.binding]: "inert bindings fixture" };
const manifest = Object.entries(contents).map(([name, data]) => `${digest(data)}  ${name}`).join("\r\n") + "\r\n";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-cargo-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "codex/codex-rs"), { recursive: true });
  await writeFile(path.join(root, "codex/codex-rs/Cargo.lock"), lock);
  const requests = [];
  const payloads = { ...contents, [names.checksums]: manifest };
  return {
    root, cacheRoot: path.join(root, "cache"), env: { CARGO_BUILD_TARGET: target }, requests, payloads,
    fetchImpl: async (url) => {
      requests.push(url);
      assert.ok(url.startsWith("https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0/"));
      const data = payloads[url.split("/").at(-1)];
      return new Response(data ?? "missing", { status: data === undefined ? 404 : 200 });
    },
  };
}

test("V8 version comes from exactly one resolved pinned version", () => {
  assert.equal(resolvedV8Version(lock), "150.4.0");
  assert.throws(() => resolvedV8Version("[[package]]\nname = \"other\"\nversion = \"1.0.0\""), /exactly one/);
  assert.throws(() => resolvedV8Version(lock + lock.replace("150.4.0", "151.0.0")), /exactly one/);
  assert.throws(() => resolvedV8Version(lock.replace("150.4.0", "../escape")), /Invalid resolved/);
});

test("artifact names match sandbox archives and bindings on Unix and Windows", () => {
  assert.equal(names.archive, "librusty_v8_ptrcomp_sandbox_release_aarch64-apple-darwin.a.gz");
  assert.equal(artifactNames("x86_64-pc-windows-msvc").archive, "rusty_v8_ptrcomp_sandbox_release_x86_64-pc-windows-msvc.lib.gz");
  assert.throws(() => artifactNames("../target.json"), /No Codex-built/);
});

test("checksums accept CRLF and reject missing, duplicate, extra, malformed or unexpected entries", () => {
  assert.equal(parseChecksums(manifest, [names.archive, names.binding]).size, 2);
  for (const invalid of [
    manifest.split("\r\n")[0],
    `${digest("x")}  ${names.archive}\n${digest("y")}  ${names.archive}\n`,
    manifest + manifest,
    manifest.replace(/[a-f0-9]{64}/, "not-a-digest"),
    manifest.replace(names.binding, "../escape"),
  ]) assert.throws(() => parseChecksums(invalid, [names.archive, names.binding]), /V8 artifact checksum/);
});

test("target precedence is CLI, environment, then the selected rustc host", () => {
  const noRun = () => assert.fail("rustc should not run");
  assert.equal(resolveTarget(["build", "--target", target], { CARGO_BUILD_TARGET: "x86_64-unknown-linux-gnu" }, noRun), target);
  assert.equal(resolveTarget(["build", `--target=${target}`], {}, noRun), target);
  assert.equal(resolveTarget(["test", "--", "--target=ignored"], { CARGO_BUILD_TARGET: target }, noRun), target);
  assert.equal(resolveTarget(["+stable", "build"], {}, (command, args) => {
    assert.equal(command, "rustc");
    assert.deepEqual(args, ["+stable", "-vV"]);
    return { status: 0, stdout: `rustc fixture\nhost: ${target}\n` };
  }), target);
  assert.equal(resolveTarget(["build"], { RUSTC: "/fixture/rustc" }, (command, args) => {
    assert.equal(command, "/fixture/rustc");
    assert.deepEqual(args, ["-vV"]);
    return { status: 0, stdout: `host: ${target}\n` };
  }), target);
  assert.throws(() => resolveTarget(["build", "--target"], {}, noRun), /requires/);
  assert.throws(() => resolveTarget(["build", "--target", target, `--target=${target}`], {}, noRun), /one V8 target/);
});

test("paired explicit overrides and source builds avoid any discovery or download", async () => {
  const fetchImpl = () => assert.fail("must not download");
  const run = () => assert.fail("must not discover rustc");
  for (const env of [
    { RUSTY_V8_ARCHIVE: "/fixture/archive", RUSTY_V8_SRC_BINDING_PATH: "/fixture/bindings" },
    { V8_FROM_SOURCE: "1" }, { V8_FROM_SOURCE: "true" }, { V8_FROM_SOURCE: "yes" },
  ]) assert.deepEqual(await resolveV8Environment({ env, fetchImpl, run }), {});
  for (const env of [{ RUSTY_V8_ARCHIVE: "fixture" }, { RUSTY_V8_SRC_BINDING_PATH: "fixture" }]) {
    await assert.rejects(resolveV8Environment({ env, fetchImpl, run }), /together/);
  }
});

test("host discovery ignores an inherited cross-compilation target", () => {
  assert.equal(resolveHostTarget({ CARGO_BUILD_TARGET: "x86_64-unknown-linux-gnu" }, (_command, args) => {
    assert.deepEqual(args, ["-vV"]);
    return { status: 0, stdout: `host: ${target}\n` };
  }), target);
});

test("target detection rejects inherited targets and ambiguous overrides before downloading", async (t) => {
  const options = await fixture(t);
  const cwd = path.join(options.root, "project", "nested");
  const configDir = path.join(options.root, "project", ".cargo");
  const cargoHome = path.join(options.root, "cargo-home");
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(cargoHome);
  const env = { CARGO_HOME: cargoHome };
  for (const contents of ['[build]\ntarget = "other-target"\n', 'build.target = ["other-target"]\n', 'build = { target = "other-target" }\n', 'include = "other.toml"\n', '"buil\\u0064".target = "other-target"\n']) {
    await writeFile(path.join(configDir, "config.toml"), contents);
    await assert.rejects(resolveV8Environment({ ...options, env, cwd, fetchImpl: () => assert.fail("must not download") }), /Inherited Cargo target settings/);
  }
  await validateTargetConfiguration(["build", "--target", target], env, cwd);
  await validateTargetConfiguration(["build"], { ...env, CARGO_BUILD_TARGET: target }, cwd);
  for (const config of ['build.target="other-target"', 'build = { target = "other-target" }', 'include="other.toml"', 'custom.toml', '"buil\\u0064".target="other-target"']) {
    await assert.rejects(validateTargetConfiguration(["build", "--target", target, "--config", config], env, cwd), /cannot infer target settings/);
  }
  await writeFile(path.join(configDir, "config.toml"), '[build]\njobs = 1\n[target.x86_64-unknown-linux-gnu]\nlinker="cc"\n');
  await validateTargetConfiguration(["build", "--config", "build.jobs=2"], env, cwd);
  await validateTargetConfiguration(["build", "--config", 'build.rustflags=["-C", "target-cpu=native"]'], env, cwd);
  await writeFile(path.join(cargoHome, "config"), '[build]\ntarget="other-target"\n');
  await assert.rejects(validateTargetConfiguration(["check"], env, cwd), /cargo-home.*config/);
});

test("explicit targets override inherited Cargo target configuration in a dependency-free crate", {
  skip: process.env.INSTAFY_TEST_RUNTIME_CARGO_REAL !== "1" ? "Set INSTAFY_TEST_RUNTIME_CARGO_REAL=1 for the offline Cargo execution probe" : false,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-cargo-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".cargo"));
  await writeFile(path.join(root, "Cargo.toml"), '[package]\nname="inert-target-probe"\nversion="0.0.0"\nedition="2021"\n');
  await writeFile(path.join(root, "src/main.rs"), 'fn main() {}\n');
  await writeFile(path.join(root, ".cargo/config.toml"), '[build]\ntarget="unknown-fixture-target"\njobs=1\n');
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    CARGO_HOME: path.join(root, "cargo-home"),
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), ".rustup"),
    ...(process.env.RUSTUP_TOOLCHAIN ? { RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN } : {}),
    RUSTY_V8_ARCHIVE: path.join(root, "unused-inert-archive"),
    RUSTY_V8_SRC_BINDING_PATH: path.join(root, "unused-inert-binding"),
  };
  const host = resolveHostTarget(env);
  await assert.rejects(validateTargetConfiguration(["build", "--offline"], env, root), /Inherited Cargo target settings/);
  await validateTargetConfiguration(["build", "--target", host], env, root);
  let stderr;
  const status = await runRuntimeCargo(["build", "--offline", "--target", host], {
    env, cwd: root,
    fetchImpl: () => assert.fail("inert probe must not download"),
    run: (command, args, options) => {
      const result = spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8" });
      stderr = result.stderr;
      return result;
    },
  });
  assert.equal(status, 0, stderr);
  const executable = process.platform === "win32" ? "inert-target-probe.exe" : "inert-target-probe";
  assert.ok((await readFile(path.join(root, "target", host, "debug", executable))).length > 0);
});

test("downloads a verified pair, reuses verified cache, and replaces corruption", async (t) => {
  const options = await fixture(t);
  const env = await resolveV8Environment(options);
  assert.equal(await readFile(env.RUSTY_V8_ARCHIVE, "utf8"), contents[names.archive]);
  assert.equal(await readFile(env.RUSTY_V8_SRC_BINDING_PATH, "utf8"), contents[names.binding]);
  assert.equal(options.requests.length, 3);
  await resolveV8Environment(options);
  assert.equal(options.requests.length, 4, "only checksum manifest is refreshed");
  await writeFile(env.RUSTY_V8_ARCHIVE, "corruption");
  await resolveV8Environment(options);
  assert.equal(options.requests.length, 6);
  assert.equal(await readFile(env.RUSTY_V8_ARCHIVE, "utf8"), contents[names.archive]);
});

test("bad downloads never publish an artifact or leak partial files", async (t) => {
  const options = await fixture(t);
  options.payloads[names.archive] = "incorrect bytes";
  await assert.rejects(resolveV8Environment(options), /SHA-256 verification/);
  const directory = path.join(options.cacheRoot, `rusty-v8-150.4.0-${target}`);
  assert.deepEqual(await readdir(directory), []);
});

test("HTTP failures abort before Cargo is run", async (t) => {
  const options = await fixture(t);
  delete options.payloads[names.binding];
  await assert.rejects(runRuntimeCargo(["check"], {
    ...options, run: () => assert.fail("Cargo must not run"),
  }), /HTTP 404/);
});

test("Cargo receives exact arguments, inherited environment, verified pair, and exit status", async (t) => {
  const options = await fixture(t);
  options.env.INERT_BUILD_FIXTURE = "preserved";
  const args = ["test", "--manifest-path", "path with spaces/Cargo.toml", "--", "fixture_filter"];
  assert.equal(await runRuntimeCargo(args, { ...options, run(command, actual, spawnOptions) {
    assert.equal(command, "cargo");
    assert.deepEqual(actual, args);
    assert.equal(spawnOptions.env.INERT_BUILD_FIXTURE, "preserved");
    assert.equal(path.basename(spawnOptions.env.RUSTY_V8_ARCHIVE), names.archive);
    assert.equal(path.basename(spawnOptions.env.RUSTY_V8_SRC_BINDING_PATH), names.binding);
    assert.equal(spawnOptions.stdio, "inherit");
    return { status: 17 };
  } }), 17);
});

test("Docker can copy the helper and builds the sibling host in both dependency and application stages", async () => {
  const root = new URL("../", import.meta.url);
  const dockerfile = await readFile(new URL("docker/runtime/Dockerfile", root), "utf8");
  const ignore = await readFile(new URL(".dockerignore", root), "utf8");
  assert.match(ignore, /^!scripts\/runtime-cargo\.mjs$/m);
  assert.doesNotMatch(ignore, /^scripts\/?$/m);
  assert.match(dockerfile, /src\/bin\/codex-code-mode-host\.rs/);
  for (const stage of ["builder-deps", "builder"]) {
    const body = dockerfile.split(` AS ${stage}\n`)[1]?.split(/^FROM /m)[0];
    assert.ok(body, `missing ${stage}`);
    assert.match(body, /COPY scripts\/runtime-cargo\.mjs \/src\/scripts\/runtime-cargo\.mjs/);
    assert.match(body, /COPY --from=node-runtime \/usr\/local\/bin\/node/);
    assert.match(body, /node \/src\/scripts\/runtime-cargo\.mjs (?:chef cook|build)/);
    assert.match(body, /--mount=type=cache,target=\/usr\/local\/cargo\/rusty-v8/);
  }
});
