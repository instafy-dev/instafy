import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_BROWSER_LANES } from "./required-browser-reporter.mjs";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(frontendRoot, "package.json"));
const configs = Object.freeze({
  personal: "playwright.personal-ci.config.ts",
  "browser-ui": "playwright.ci-ui.config.ts",
});

// This runner deliberately does not import playwright-test.mjs, the normal
// Playwright config, Supabase discovery, dotenv or private environment helpers.
// Only OS/display/browser-cache settings cross into the disposable test lane.
export function browserCiEnvironment(source = process.env) {
  const env = {};
  for (const key of [
    "PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME",
    "PLAYWRIGHT_BROWSERS_PATH",
    "PLAYWRIGHT_BROWSER_UI_CHANNEL",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.CI = "1";
  return env;
}

/**
 * The Electron fixture has a second, narrower environment boundary. Preserve
 * X11's authorization file with its display address (xvfb-run needs both), but
 * never inherit HOME, application configuration or service credentials.
 * @param {Record<string, string | undefined>} source
 * @returns {Record<string, string>}
 */
export function personalBrowserFixtureEnvironment(source = process.env) {
  const env = { PATH: source.PATH ?? "" };
  for (const key of [
    "SystemRoot", "WINDIR", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/**
 * Playwright arguments for a lane, or for one part of a lane CI runs in parts:
 * `browser-ui --shard=1/2` runs the first of the lane's two parts. Anything
 * else, such as a test filter or a reporter override, is rejected.
 */
export function browserCiArguments(args) {
  if (args[0] === "--") args = args.slice(1);
  const [lane, part, ...rest] = args;
  const parts = Object.hasOwn(configs, lane ?? "") ? REQUIRED_BROWSER_LANES[lane]?.parts : undefined;
  const shard = /^--shard=([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(part ?? "");
  if (!Object.hasOwn(configs, lane ?? "") || rest.length
    || (part !== undefined && !(parts && shard && Number(shard[2]) === parts && Number(shard[1]) <= parts))) {
    throw new Error("Usage: pnpm test:browser:ci <personal|browser-ui> [--shard=<part>/<parts> for a lane CI runs in parts]; test filters and reporter overrides are not allowed");
  }
  return ["test", "--config", configs[lane], ...(part === undefined ? [] : [part])];
}

export async function runBrowserCi(args = process.argv.slice(2)) {
  const playwrightArgs = browserCiArguments(args);
  const playwrightCli = require.resolve("@playwright/test/cli");
  const child = spawn(process.execPath, [playwrightCli, ...playwrightArgs], {
    cwd: frontendRoot,
    env: browserCiEnvironment(),
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  let interrupted = false;
  let killTimer;
  function signalOwnedChild(signal) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal); // Only the new, detached test group.
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const interrupt = () => {
    interrupted = true;
    signalOwnedChild("SIGTERM");
    killTimer ??= setTimeout(() => signalOwnedChild("SIGKILL"), 5_000);
    killTimer.unref();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(interrupted ? 130 : (code ?? 1)));
    });
  } finally {
    clearTimeout(killTimer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBrowserCi().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
