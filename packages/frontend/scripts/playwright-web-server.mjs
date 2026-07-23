#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const devScriptPath = path.join(__dirname, "dev.mjs");
const devArgs = process.argv.slice(2);

let child = null;
let restartTimer = null;
let shuttingDown = false;
let lastStartAt = 0;

function clearRestartTimer() {
  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function startDevServer() {
  lastStartAt = Date.now();
  child = spawn(process.execPath, [devScriptPath, ...devArgs], {
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    const uptimeMs = Date.now() - lastStartAt;
    child = null;

    if (shuttingDown) {
      process.exit(code ?? (signal ? 0 : 1));
      return;
    }

    const delayMs = uptimeMs < 5_000 ? 1_000 : 250;
    const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    console.error(
      `[playwright-web-server] frontend dev server exited with ${reason}; restarting in ${delayMs}ms.`,
    );
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startDevServer();
    }, delayMs);
  });
}

function shutdown(exitCode, signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearRestartTimer();

  if (!child) {
    process.exit(exitCode);
    return;
  }

  const activeChild = child;
  activeChild.once("exit", () => {
    process.exit(exitCode);
  });

  try {
    activeChild.kill(signal);
  } catch {
    process.exit(exitCode);
    return;
  }

  setTimeout(() => {
    if (!child) {
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 5_000).unref();
}

process.once("SIGINT", () => shutdown(130, "SIGINT"));
process.once("SIGTERM", () => shutdown(143, "SIGTERM"));
process.once("SIGHUP", () => shutdown(129, "SIGHUP"));

startDevServer();
