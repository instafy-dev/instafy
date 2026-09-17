#!/usr/bin/env node
// Secret-free launch smoke for the signed, notarized Desktop app.
//
// Launches the extracted Instafy.app through Playwright's Electron driver
// (resolved from the installed packages/frontend dependencies of the source
// checkout, by default <cwd>/packages/frontend), proves the running app is
// the packaged binary, waits for the first window to load, then quits and
// requires a clean exit. On failure a screenshot is written to the screenshot
// directory for upload.
//
// Usage: node packaged-launch-smoke.mjs --executable <abs path> [--timeout-ms N]
//          [--screenshot-dir DIR] [--frontend-dir DIR]

import fs, { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 120_000;
const CHILD_ENV_ALLOWLIST = ["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"];

export class LaunchSmokeError extends Error {
  constructor(message) {
    super(message);
    this.name = "LaunchSmokeError";
  }
}

function fail(message) {
  throw new LaunchSmokeError(message);
}

export function parseArguments(argv, env = process.env) {
  const options = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    screenshotDir: env.RUNNER_TEMP || os.tmpdir(),
    frontendDir: path.join(process.cwd(), "packages", "frontend"),
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0) fail(`Missing value for ${flag}.`);
    if (flag === "--executable") options.executable = value;
    else if (flag === "--timeout-ms") {
      if (!/^[1-9]\d{3,6}$/u.test(value)) fail("--timeout-ms must be an integer between 1000 and 9999999.");
      options.timeoutMs = Number(value);
    } else if (flag === "--screenshot-dir") options.screenshotDir = value;
    else if (flag === "--frontend-dir") options.frontendDir = path.resolve(value);
    else fail(`Unsupported argument ${flag}.`);
  }
  if (!options.executable) fail("--executable is required.");
  return options;
}

export function packagedAppRoot(executable) {
  if (!path.isAbsolute(executable)) fail("The packaged executable path must be absolute.");
  const normalized = path.normalize(executable);
  const match = /^(.*\/[^/]+\.app)\/Contents\/MacOS\/[^/]+$/u.exec(normalized);
  if (!match) fail("The executable must be <App>.app/Contents/MacOS/<binary>.");
  return match[1];
}

export function requireLaunchableExecutable(executable) {
  const appRoot = packagedAppRoot(executable);
  const stat = fs.lstatSync(executable, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    fail("The packaged executable must be a regular executable file.");
  }
  return appRoot;
}

export function assertLaunchEvidence({ executable, isPackaged, exePath, title, url }) {
  if (isPackaged !== true) fail("app.isPackaged is not true; this is not the packaged application.");
  const appRoot = packagedAppRoot(executable);
  const resolvedExe = typeof exePath === "string" ? path.normalize(exePath) : "";
  if (!resolvedExe.startsWith(`${appRoot}/`)) fail("app.getPath('exe') is outside the extracted Instafy.app.");
  const hasTitle = typeof title === "string" && title.trim().length > 0;
  const hasUrl = typeof url === "string" && url.length > 0 && url !== "about:blank";
  if (!hasTitle && !hasUrl) fail("The first window has neither a title nor a loaded URL.");
  return { title: hasTitle ? title.trim() : "", url: hasUrl ? url : "" };
}

export function assertCleanExit({ code, signal }) {
  if (code !== 0) fail(`The packaged app did not exit cleanly (code ${code ?? "none"}, signal ${signal ?? "none"}).`);
}

export function childEnvironment(env, userDataDir) {
  const child = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (env[name] !== undefined) child[name] = env[name];
  }
  return {
    ...child,
    INSTAFY_DESKTOP_USER_DATA_DIR: userDataDir,
    INSTAFY_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "1",
    INSTAFY_DESKTOP_DISABLE_LOCAL_VOICE_HOST: "1",
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LaunchSmokeError(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function runLaunchSmoke(options, env = process.env) {
  const appRoot = requireLaunchableExecutable(options.executable);
  const require = createRequire(path.join(options.frontendDir, "package.json"));
  const { _electron: electron } = require("@playwright/test");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "instafy-launch-smoke-"));
  let app = null;
  let page = null;
  try {
    app = await electron.launch({
      executablePath: options.executable,
      args: [],
      cwd: path.dirname(options.executable),
      env: childEnvironment(env, userDataDir),
      timeout: options.timeoutMs,
    });
    const child = app.process();
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
      else child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const runtime = await app.evaluate(({ app: electronApp }) => ({
      isPackaged: electronApp.isPackaged,
      exePath: electronApp.getPath("exe"),
    }));
    page = await app.firstWindow({ timeout: options.timeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: options.timeoutMs }).catch(() => {});
    const realExePath = (() => {
      try {
        return fs.realpathSync(runtime.exePath);
      } catch {
        return "";
      }
    })();
    const evidence = assertLaunchEvidence({
      // Compare real paths: a temp root may itself sit behind a symlink.
      executable: fs.realpathSync(options.executable),
      isPackaged: runtime.isPackaged,
      exePath: realExePath,
      title: await page.title().catch(() => ""),
      url: page.url(),
    });
    await withTimeout(app.close(), 30_000, "Closing the packaged app");
    app = null;
    assertCleanExit(await withTimeout(exited, 30_000, "Waiting for the packaged app to exit"));
    return { appRoot, ...evidence };
  } catch (error) {
    if (page) {
      const screenshot = path.join(options.screenshotDir, `smoke-${Date.now()}.png`);
      await page.screenshot({ path: screenshot }).catch(() => {});
    }
    throw error;
  } finally {
    if (app) await withTimeout(app.close(), 30_000, "Closing the packaged app").catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

function isEntryPoint(argvPath) {
  // Compare real paths: temp and checkout roots may sit behind symlinks.
  try {
    return Boolean(argvPath) && realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await withTimeout(runLaunchSmoke(options), options.timeoutMs + 90_000, "The launch smoke");
    console.log(`Packaged launch smoke passed: ${result.appRoot} (title: ${result.title || "-"}, url: ${result.url || "-"}).`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : "Packaged launch smoke failed."}`);
    process.exit(1);
  }
}
