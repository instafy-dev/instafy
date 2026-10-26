#!/usr/bin/env node
// Hosted-only replacement for `playwright install --with-deps chromium` in the
// two Shared Browser children. GitHub's ubuntu-24.04 image already ships every
// Chromium library and xvfb. Playwright's own apt call accepts no options, so
// it also upgrades installed packages and adds CJK, Thai and X11 core fonts
// that no Shared fixture renders; on 2026-10-26 a 33 kB/s mirror made that
// download alone take over eleven minutes. This names to apt only reviewed
// packages the image lacks, never an installed one; apt may still add or
// upgrade their dependencies from the signed Ubuntu archive. It then proves
// that both locked Chromium executables load every shared library.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Reviewed from playwright-core 1.61.1 nativeDeps["ubuntu24.04-x64"], in its own order.
export const PLAYWRIGHT_TOOLS = Object.freeze(["xvfb", "fonts-noto-color-emoji", "fonts-unifont", "libfontconfig1",
  "libfreetype6", "xfonts-cyrillic", "xfonts-scalable", "fonts-liberation", "fonts-ipafont-gothic", "fonts-wqy-zenhei",
  "fonts-tlwg-loma-otf", "fonts-freefont-ttf"]);
export const PLAYWRIGHT_CHROMIUM = Object.freeze(["libasound2t64", "libatk-bridge2.0-0t64", "libatk1.0-0t64",
  "libatspi2.0-0t64", "libcairo2", "libcups2t64", "libdbus-1-3", "libdrm2", "libgbm1", "libglib2.0-0t64", "libnspr4",
  "libnss3", "libpango-1.0-0", "libx11-6", "libxcb1", "libxcomposite1", "libxdamage1", "libxext6", "libxfixes3",
  "libxkbcommon0", "libxrandr2"]);
// Glyph coverage no Shared fixture renders: the fixture page and Studio show
// Latin text, which the image's Liberation and Noto emoji fonts already cover.
export const OMITTED_FONTS = Object.freeze(["fonts-unifont", "xfonts-cyrillic", "xfonts-scalable",
  "fonts-ipafont-gothic", "fonts-wqy-zenhei", "fonts-tlwg-loma-otf", "fonts-freefont-ttf"]);
export const HOSTED_PACKAGES = Object.freeze([...PLAYWRIGHT_CHROMIUM,
  ...PLAYWRIGHT_TOOLS.filter(name => !OMITTED_FONTS.includes(name))]);
export const APT_OPTIONS = Object.freeze(["-o", "Acquire::Retries=2", "-o", "Acquire::http::Timeout=30", "-o", "Acquire::https::Timeout=30"]);
const USAGE = "usage: ensure-hosted-chromium-host.mjs install|verify";

// The runner type is checked before anything on the host is read, so a
// self-hosted or unknown runner never reaches the hosted package list.
export function assertHostedUbuntu({ env, platform, arch, readOsRelease }) {
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "hosted-image prerequisites never run on self-hosted or unknown runners");
  assert.equal(platform, "linux", "hosted-image prerequisites need Linux");
  assert.equal(arch, "x64", "hosted-image prerequisites need x64");
  const osRelease = readOsRelease();
  assert.match(osRelease, /^ID=ubuntu$/mu, "hosted-image prerequisites need Ubuntu");
  assert.match(osRelease, /^VERSION_ID="24\.04"$/mu, "hosted-image prerequisites were reviewed only for Ubuntu 24.04");
}

// Reads the dependency table from the locked bundle so a Playwright change
// cannot silently diverge from the reviewed hosted list.
export function playwrightTable(bundle) {
  const block = bundle.match(/"ubuntu24\.04-x64": \{\n\s*tools: \[([^\]]*)\],\n\s*chromium: \[([^\]]*)\]/u);
  assert.ok(block, "re-review: the locked Playwright bundle no longer exposes the ubuntu24.04-x64 table");
  const names = text => {
    assert.equal(text.replace(/"[^"\n]+"|[\s,]/gu, ""), "", "re-review: the locked ubuntu24.04-x64 table holds more than package names");
    return [...text.matchAll(/"([^"\n]+)"/gu)].map(match => match[1]);
  };
  const table = { tools: names(block[1]), chromium: names(block[2]) };
  assert.ok(table.tools.length > 0 && table.chromium.length > 0, "re-review: the locked ubuntu24.04-x64 table is empty");
  return table;
}

// A package the locked Playwright newly requires fails until it is reviewed;
// one it stops requiring is harmless. Chromium's own libraries are never omitted.
export function assertReviewedTable(table) {
  const unreviewed = [...table.chromium.filter(name => !HOSTED_PACKAGES.includes(name)),
    ...table.tools.filter(name => !HOSTED_PACKAGES.includes(name) && !OMITTED_FONTS.includes(name))];
  assert.deepEqual(unreviewed, [], `re-review HOSTED_PACKAGES and OMITTED_FONTS for this Playwright version: ${unreviewed.join(" ")}`);
}

export function missingPackages(packages, exec) {
  return packages.filter(name => {
    try {
      return exec("dpkg-query", ["--show", "--showformat=${Status}", name]) !== "install ok installed";
    } catch {
      return true;
    }
  });
}

// apt-get's own lists of new and upgraded packages, which include any
// dependency it pulls in, and its "Need to get" and "Fetched" lines follow the
// package names in the step log, so a widening image gap is visible before it
// costs a timeout. --no-upgrade affects only named packages, none installed.
export function installMissing(missing, run, log) {
  if (missing.length === 0) {
    log(`hosted image provides all ${HOSTED_PACKAGES.length} reviewed Chromium packages; nothing to download`);
    return;
  }
  const unreviewed = missing.filter(name => !HOSTED_PACKAGES.includes(name));
  assert.deepEqual(unreviewed, [], `refusing packages outside the reviewed hosted list: ${unreviewed.join(" ")}`);
  log(`hosted image lacks ${missing.length} reviewed packages; installing only: ${missing.join(" ")}`);
  run("sudo", ["-n", "apt-get", ...APT_OPTIONS, "update"]);
  run("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", ...APT_OPTIONS, "install", "--yes",
    "--no-install-recommends", "--no-upgrade", ...missing]);
  log(`installed ${missing.length} packages missing from the hosted image: ${missing.join(" ")}`);
}

export function verifyHost({ executables, exec }) {
  const missing = missingPackages(HOSTED_PACKAGES, exec);
  assert.deepEqual(missing, [], `reviewed Chromium packages are missing after installation: ${missing.join(" ")}`);
  assert.ok(executables.length > 0, "no locked Chromium executable to verify");
  for (const executable of executables) {
    assert.ok(typeof executable === "string" && path.isAbsolute(executable), `not an absolute Chromium path: ${executable}`);
    const libraries = exec("ldd", [executable]);
    assert.match(libraries, /libnss3\.so/u, `ldd did not inspect the locked Chromium at ${executable}`);
    assert.doesNotMatch(libraries, /not found/u, `the locked Chromium at ${executable} cannot load a shared library:\n${libraries}`);
  }
}

export function ensureHostedChromiumHost(mode, host) {
  assert.ok(mode === "install" || mode === "verify", USAGE);
  assertHostedUbuntu(host);
  assertReviewedTable(playwrightTable(host.readPlaywrightBundle()));
  if (mode === "install") installMissing(missingPackages(HOSTED_PACKAGES, host.exec), host.run, host.log);
  const executables = host.lockedExecutables();
  verifyHost({ executables, exec: host.exec });
  host.log(`verified ${HOSTED_PACKAGES.length} packages and every shared library of ${executables.join(" and ")}`);
}

// Resolves the frontend's locked @playwright/test and the playwright-core it
// loads; nothing is resolved until the host guards have passed.
function lockedPlaywright(root) {
  const frontend = createRequire(path.join(root, "packages/frontend/package.json"));
  const core = () => {
    const playwright = createRequire(frontend.resolve("@playwright/test/package.json")).resolve("playwright/package.json");
    return path.dirname(createRequire(playwright).resolve("playwright-core/package.json"));
  };
  return {
    readPlaywrightBundle: () => fs.readFileSync(path.join(core(), "lib/coreBundle.js"), "utf8"),
    lockedExecutables: () => {
      const headless = createRequire(path.join(core(), "package.json"))("./lib/coreBundle.js").registry?.registry
        ?.findExecutable("chromium-headless-shell")?.executablePath("javascript");
      return [frontend("@playwright/test").chromium.executablePath(), headless];
    },
  };
}

function main(argv) {
  assert.equal(argv.length, 1, USAGE);
  const exec = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  ensureHostedChromiumHost(argv[0], {
    env: process.env, platform: process.platform, arch: process.arch,
    readOsRelease: () => fs.readFileSync("/etc/os-release", "utf8"),
    ...lockedPlaywright(path.resolve(import.meta.dirname, "..")),
    exec,
    run: (file, args) => execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"] }),
    log: message => console.log(message),
  });
}

// Node runs the main module from its real path, so compare real paths: a
// symlinked invocation must still run the guards rather than exit 0 unchecked.
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
