import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBeforeLaunch, cargoBuildArgs, resolveRustBinaryLaunch } from "./prebuiltRustBinary.mjs";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-prebuilt-bin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("falls back to the declared Cargo command when no override exists", () => {
  assert.deepEqual(
    resolveRustBinaryLaunch({
      env: {},
      envKey: "TEST_BIN",
      repoRoot: "/repo",
      cargoArgs: ["run", "--bin", "test"],
      label: "test",
    }),
    { command: "cargo", args: ["run", "--bin", "test"], source: "cargo" },
  );
});

test("resolves and validates a configured executable", (t) => {
  const root = tempRoot(t);
  const binary = path.join(root, "runtime-controller");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const launch = resolveRustBinaryLaunch({
    env: { TEST_BIN: "runtime-controller" },
    envKey: "TEST_BIN",
    repoRoot: root,
    cargoArgs: ["run"],
    label: "controller",
  });
  assert.deepEqual(launch, { command: binary, args: [], source: "prebuilt" });
});

test("configured overrides fail closed when missing, non-regular, or non-executable", (t) => {
  const root = tempRoot(t);
  const directory = path.join(root, "directory");
  const nonExecutable = path.join(root, "not-executable");
  fs.mkdirSync(directory);
  fs.writeFileSync(nonExecutable, "binary", { mode: 0o644 });

  for (const configured of ["missing", "directory", "not-executable"]) {
    assert.throws(
      () =>
        resolveRustBinaryLaunch({
          env: { TEST_BIN: configured },
          envKey: "TEST_BIN",
          repoRoot: root,
          cargoArgs: ["run"],
          label: "controller",
        }),
      /prebuilt binary/,
    );
  }
});

// The dev launcher builds a Cargo service before it starts it, so its readiness wait times
// startup only: a cold build of the controller outlasts any wait sized for startup.

test("a Cargo launch builds with its run's manifest, binary and flags", () => {
  assert.deepEqual(cargoBuildArgs(["run", "--manifest-path", "/repo/packages/runtime-controller/Cargo.toml"]), [
    "build",
    "--manifest-path",
    "/repo/packages/runtime-controller/Cargo.toml",
  ]);
  assert.deepEqual(
    cargoBuildArgs(["run", "--manifest-path", "/m/Cargo.toml", "--bin", "runtime-provider-service"]),
    ["build", "--manifest-path", "/m/Cargo.toml", "--bin", "runtime-provider-service"],
  );
  assert.deepEqual(cargoBuildArgs(["run", "--bin", "proxy", "--", "--port", "1"]), ["build", "--bin", "proxy"]);
  for (const notRun of [[], ["build"], "run", undefined]) {
    assert.throws(() => cargoBuildArgs(notRun), /cargo run/);
  }
});

test("the build finishes before the launch starts, with the run's own env, cwd and log", async () => {
  const env = { CARGO_TERM_COLOR: "never" };
  const stdio = ["ignore", 7, 7];
  const spawned = [];
  let child;
  const spawn = (command, args, options) => {
    child = new EventEmitter();
    spawned.push({ command, args, options });
    return child;
  };
  let settled = false;
  const pending = buildBeforeLaunch(
    { command: "cargo", args: ["run", "--manifest-path", "/m/Cargo.toml"], source: "cargo" },
    { cwd: "/repo", env, stdio, label: "runtime controller", spawn },
  ).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "cargo");
  assert.deepEqual(spawned[0].args, ["build", "--manifest-path", "/m/Cargo.toml"]);
  // The very same environment object keeps Cargo's fingerprints, so the run compiles nothing.
  assert.equal(spawned[0].options.env, env);
  assert.equal(spawned[0].options.cwd, "/repo");
  assert.equal(spawned[0].options.stdio, stdio);
  assert.notEqual(spawned[0].options.detached, true);
  child.emit("exit", 0, null);
  assert.deepEqual(await pending, { built: true, args: ["build", "--manifest-path", "/m/Cargo.toml"] });
});

test("a prebuilt binary is started as it is", async () => {
  const result = await buildBeforeLaunch(
    { command: "/opt/runtime-controller", args: [], source: "prebuilt" },
    { cwd: "/repo", env: {}, stdio: "ignore", label: "runtime controller", spawn: () => assert.fail("built a prebuilt binary") },
  );
  assert.deepEqual(result, { built: false });
});

test("a failed build stops the launch with its exit code, signal or spawn error", async () => {
  const build = (finish) =>
    buildBeforeLaunch(
      { command: "cargo", args: ["run"], source: "cargo" },
      {
        cwd: "/repo",
        env: {},
        stdio: "ignore",
        label: "runtime controller",
        spawn: () => {
          const child = new EventEmitter();
          setImmediate(() => finish(child));
          return child;
        },
      },
    );
  await assert.rejects(build((child) => child.emit("exit", 101, null)), /^Error: runtime controller build failed \(exit code 101\)$/);
  await assert.rejects(build((child) => child.emit("exit", null, "SIGKILL")), /build failed \(signal SIGKILL\)/);
  await assert.rejects(
    build((child) => child.emit("error", new Error("spawn cargo ENOENT"))),
    /runtime controller build could not start: spawn cargo ENOENT/,
  );
});

test("a real build is awaited however long it takes", { skip: process.platform === "win32" }, async (t) => {
  const root = tempRoot(t);
  const cargo = path.join(root, "cargo");
  const argsOut = path.join(root, "args");
  const log = path.join(root, "build.log");
  fs.writeFileSync(
    cargo,
    '#!/bin/sh\nsleep 1\necho "$*" > "$ARGS_OUT"\necho compiled\nexit "${BUILD_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  const build = async (env) => {
    const fd = fs.openSync(log, "w");
    try {
      return await buildBeforeLaunch(
        { command: cargo, args: ["run", "--manifest-path", "/m/Cargo.toml"], source: "cargo" },
        { cwd: root, env: { PATH: process.env.PATH, ARGS_OUT: argsOut, ...env }, stdio: ["ignore", fd, fd], label: "runtime controller" },
      );
    } finally {
      fs.closeSync(fd);
    }
  };
  assert.deepEqual(await build({}), { built: true, args: ["build", "--manifest-path", "/m/Cargo.toml"] });
  assert.equal(fs.readFileSync(argsOut, "utf8").trim(), "build --manifest-path /m/Cargo.toml");
  assert.match(fs.readFileSync(log, "utf8"), /compiled/);
  await assert.rejects(build({ BUILD_EXIT: "101" }), /exit code 101/);
});

test("the dev launcher builds the controller and provider before it times their startup", () => {
  const source = fs.readFileSync(new URL("../run-e2e-dev.mjs", import.meta.url), "utf8");
  const body = (name) => {
    const start = source.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, name);
    return source.slice(start, source.indexOf("\nasync function ", start + 1));
  };
  const inOrder = (text, needles) => {
    let at = -1;
    for (const needle of needles) {
      at = text.indexOf(needle, at + 1);
      assert.notEqual(at, -1, needle);
    }
  };
  const controller = body("startControllerIfNeeded");
  inOrder(controller, [
    // A controller that is reused is not built.
    "reusing existing instance",
    'cargoArgs: ["run", "--manifest-path", controllerManifest]',
    "await buildBeforeLaunch(launch, { cwd: repoRoot, env, stdio",
    "child = spawn(",
    "RUNTIME_CONTROLLER_BOOT_ATTEMPTS",
  ]);
  assert.match(controller, /const defaultAttempts = isCi \? 300 : 120;/);
  const provider = body("startProviderService");
  inOrder(provider, [
    "return reuseRunningProvider(existingPid);",
    "const env = providerEnv();",
    "await buildBeforeLaunch(launch, { cwd: repoRoot, env, stdio",
    "const child = spawn(",
    "await waitForProvider(providerPort);",
  ]);
});
