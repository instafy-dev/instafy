import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRustBinaryLaunch } from "./prebuiltRustBinary.mjs";

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

test("resolves and validates a configured executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-prebuilt-bin-"));
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

test("configured overrides fail closed when missing, non-regular, or non-executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-prebuilt-bin-"));
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
