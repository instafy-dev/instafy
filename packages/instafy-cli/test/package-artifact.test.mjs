import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageVersion = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
).version;

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertCommandRejected(command, args, cwd) {
  assert.throws(
    () => run(command, args, cwd),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /unknown (?:command|option)/);
      return true;
    },
  );
}

test("npm artifact installs and runs without workspace dependencies", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "instafy-cli-package-"));

  try {
    const packDirectory = path.join(tempRoot, "pack");
    const installDirectory = path.join(tempRoot, "install");
    const unpackDirectory = path.join(tempRoot, "unpack");
    mkdirSync(packDirectory);
    mkdirSync(installDirectory);
    mkdirSync(unpackDirectory);

    const packOutput = run(
      "npm",
      [
        "pack",
        "--silent",
        "--json",
        "--pack-destination",
        packDirectory,
      ],
      packageRoot,
    );
    const lastJsonLine = packOutput.lastIndexOf("\n[");
    const jsonStart = packOutput.trimStart().startsWith("[")
      ? packOutput.indexOf("[")
      : lastJsonLine >= 0
        ? lastJsonLine + 1
        : -1;
    assert.ok(jsonStart >= 0, "npm pack did not emit its JSON result");
    const packResult = JSON.parse(packOutput.slice(jsonStart));
    const tarball = path.join(packDirectory, packResult[0].filename);

    assert.deepEqual(
      packResult[0].files.map(({ path: filePath }) => filePath).sort(),
      ["LICENSE", "README.md", "bin/instafy.js", "dist/cli.js", "package.json"],
    );

    run("npm", ["init", "--yes"], installDirectory);
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      installDirectory,
    );
    const installedPackage = path.join(
      installDirectory,
      "node_modules",
      "@instafy",
      "cli",
    );
    const packedManifest = JSON.parse(
      readFileSync(path.join(installedPackage, "package.json"), "utf8"),
    );
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, version] of Object.entries(packedManifest[section] ?? {})) {
        assert.doesNotMatch(
          version,
          /^workspace:/,
          `${section}.${name} has a workspace dependency`,
        );
      }
    }
    const runtimeDependencies = Object.entries(packedManifest.dependencies ?? {});
    assert.ok(runtimeDependencies.length > 0);
    for (const [name, version] of runtimeDependencies) {
      assert.doesNotMatch(name, /^@instafy\//, `${name} should be bundled into the CLI`);
    }
    const packedCli = readFileSync(path.join(installedPackage, "dist", "cli.js"), "utf8");
    assert.doesNotMatch(packedCli, /@instafy\//);
    assert.doesNotMatch(packedCli, /\/operator\/projects/);
    assert.doesNotMatch(packedCli, /\/ota\/releases/);
    assert.doesNotMatch(packedCli, /\/desktop-updates\/promotions/);

    const installedCli = path.join(
      installedPackage,
      "bin",
      "instafy.js",
    );
    assert.equal(
      run(process.execPath, [installedCli, "--version"], installDirectory).trim(),
      packageVersion,
    );
    const installedHelp = run(
      process.execPath,
      [installedCli, "--help"],
      installDirectory,
    );
    assert.match(installedHelp, /Usage: instafy/);
    assert.match(installedHelp, /diagnostics/);
    assert.match(installedHelp, /support/);
    assert.match(
      run(process.execPath, [installedCli, "diagnostics", "--help"], installDirectory),
      /runtime-events/,
    );
    assert.match(
      run(process.execPath, [installedCli, "support", "--help"], installDirectory),
      /report/,
    );
    for (const removedCommand of ["ops", "api", "ota", "desktop-updates"]) {
      assertCommandRejected(
        process.execPath,
        [installedCli, removedCommand],
        installDirectory,
      );
    }
    assert.doesNotMatch(installedHelp, /--service-token/);
    assert.doesNotMatch(installedHelp, /--controller-(?:url|access-token|token)/);
    assertCommandRejected(
      process.execPath,
      [installedCli, "support", "list", "--controller-url", "https://legacy.invalid"],
      installDirectory,
    );

    run("tar", ["-xf", tarball, "-C", unpackDirectory], packageRoot);
    const unpackedPackage = path.join(unpackDirectory, "package");
    run(
      "npm",
      ["install", "--no-audit", "--no-fund"],
      unpackedPackage,
    );
    assert.equal(
      run(
        process.execPath,
        [path.join(unpackedPackage, "bin", "instafy.js"), "--version"],
        unpackedPackage,
      ).trim(),
      packageVersion,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
