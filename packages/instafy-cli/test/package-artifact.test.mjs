import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packageFileBoundary } from "../../../scripts/verify-changeset-pack.mjs";

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

    const packedFiles = packResult[0].files.map(({ path: filePath }) => filePath).sort();
    assert.deepEqual(
      packedFiles.filter((filePath) => !filePath.startsWith("dist/bind/")),
      ["LICENSE", "README.md", "bin/instafy.js", "dist/cli.js", "package.json"],
    );
    // The release workflow refuses a tarball whose files differ from the recorded boundary in
    // scripts/verify-changeset-pack.mjs, so a pack change must update that list in the same PR.
    assert.deepEqual(
      packedFiles,
      packageFileBoundary("@instafy/cli").map((filePath) => filePath.replace(/^package\//u, "")),
      "npm pack matches the release verifier's recorded @instafy/cli file boundary",
    );
    // The bound-sites binder ships inside the CLI (zero dependencies, copied at build time).
    // `instafy bind init <dir> --starter <name>` copies its pages from dist/bind/src/starters.
    for (const required of [
      "dist/bind/bin/instafy-bind.mjs", "dist/bind/src/server.mjs", "dist/bind/client/bind-client.js", "dist/bind/LICENSE",
      "dist/bind/src/starters/theme.css", "dist/bind/src/starters/site.js", "dist/bind/src/starters/compare/index.html",
      "dist/bind/src/starters/checklist/data.json", "dist/bind/src/starters/handlers/read_offer.mjs",
    ]) {
      assert.ok(packedFiles.includes(required), `${required} is packed`);
    }
    assert.ok(
      packedFiles.filter((filePath) => filePath.startsWith("dist/bind/")).every((filePath) => /^dist\/bind\/(bin|src|client)\/|^dist\/bind\/LICENSE$/.test(filePath)),
      "only the binder's bin, src and client are packed (no tests or examples)",
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
    // `instafy bind` runs the bundled binder from the installed package (what an Octo runtime has).
    assert.match(run(process.execPath, [installedCli, "bind", "--help"], installDirectory), /instafy-bind serve <dir\|gallery>/);
    run(process.execPath, [installedCli, "bind", "init", "site"], installDirectory);
    assert.match(
      run(process.execPath, [installedCli, "bind", "doctor", "site"], installDirectory),
      /site: hello -> script handlers\/hello\.mjs/,
    );
    // The published CLI never answers from offline fixtures (only a build made with INSTAFY_TEST_BUILD=1 does): it
    // refuses INSTAFY_WEB_FIXTURES before anything is read, rather than reading the live web in its place.
    const fixtures = path.join(tempRoot, "web-fixtures");
    const fixtureHome = path.join(tempRoot, "fixture-home");
    mkdirSync(fixtures);
    mkdirSync(fixtureHome);
    writeFileSync(
      path.join(fixtures, "fixtures.json"),
      JSON.stringify({ schema: "instafy.web-fixtures@1", pages: { "https://museum.example.org/hours": { body: "<p>open</p>" } } }),
    );
    assert.throws(
      () =>
        execFileSync(process.execPath, [installedCli, "web", "read", "https://museum.example.org/hours", "--json"], {
          cwd: installDirectory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: fixtureHome,
            USERPROFILE: fixtureHome,
            XDG_CACHE_HOME: "",
            XDG_STATE_HOME: "",
            INSTAFY_CACHE_DIR: "",
            INSTAFY_WEB_FIXTURES: fixtures,
          },
        }),
      (error) => {
        assert.equal(error.status, 70, String(error.stdout));
        assert.match(JSON.parse(String(error.stdout)).error, /only a test build of the Instafy CLI answers from fixtures/);
        return true;
      },
    );
    assert.equal(existsSync(path.join(fixtureHome, ".cache")), false, "the refused read touched no cache");
    // `instafy web search` refuses the variable the same way, in a live turn. No search key is set, so even a build
    // that ignored the variable would stop at `no_provider` and could never reach a real search API from this test.
    assert.throws(
      () =>
        execFileSync(process.execPath, [installedCli, "web", "search", "ramen", "--json"], {
          cwd: installDirectory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: fixtureHome,
            USERPROFILE: fixtureHome,
            XDG_CACHE_HOME: "",
            XDG_STATE_HOME: "",
            INSTAFY_CACHE_DIR: "",
            INSTAFY_WEB_FIXTURES: fixtures,
            INSTAFY_TURN_STARTED_AT: new Date(Date.now() - 1000).toISOString(),
            INSTAFY_TURN_DEADLINE: new Date(Date.now() + 600_000).toISOString(),
            BRAVE_SEARCH_API_KEY: "",
            KAGI_API_KEY: "",
          },
        }),
      (error) => {
        assert.equal(error.status, 70, String(error.stdout));
        assert.match(JSON.parse(String(error.stdout)).error, /only a test build of the Instafy CLI answers from fixtures/);
        return true;
      },
    );
    assert.equal(existsSync(path.join(fixtureHome, ".local")), false, "the refused search wrote no state");

    assert.match(installedHelp, /Usage: instafy/);
    assert.match(installedHelp, /diagnostics/);
    assert.match(installedHelp, /support/);
    assert.match(installedHelp, /recommendations/);
    assert.match(
      run(process.execPath, [installedCli, "agents", "settings", "--help"], installDirectory),
      /--max-native-subagents <n>/,
    );
    assert.match(
      run(process.execPath, [installedCli, "recommendations", "submit", "--help"], installDirectory),
      /--file <path>/,
    );
    assert.match(
      run(process.execPath, [installedCli, "diagnostics", "--help"], installDirectory),
      /runtime-events/,
    );
    assert.match(
      run(process.execPath, [installedCli, "support", "--help"], installDirectory),
      /report/,
    );
    const transcriptHelp = run(process.execPath, [installedCli, "conversation", "show", "--help"], installDirectory);
    assert.match(transcriptHelp, /--transcript/);
    assert.match(transcriptHelp, /--cursor <messageId>/);
    for (const command of ["grep", "context"]) {
      assert.match(
        run(process.execPath, [installedCli, "conversation", command, "--help"], installDirectory),
        new RegExp(`Usage: instafy conversation ${command}`),
      );
      assert.throws(
        () => run(process.execPath, [installedCli, "conversation", command], installDirectory),
        (error) => {
          assert.equal(error.status, 2);
          assert.equal(String(error.stdout), "");
          assert.match(String(error.stderr), /missing required argument/);
          return true;
        },
      );
    }
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
