#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

function printUsage() {
  console.error(
    "Usage: node scripts/ios-webview.mjs [list] [--udid <udid>] [--port <port>] [--timeout <ms>] [--json]",
  );
}

function parseArgs(argv) {
  let command = "list";
  let udid = null;
  let port = 9225;
  let timeoutMs = 4000;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("-") && command === "list") {
      command = arg;
      continue;
    }
    if (arg === "--udid") {
      udid = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const rawPort = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isFinite(rawPort) || rawPort <= 0) {
        throw new Error("Invalid --port value.");
      }
      port = rawPort;
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      const rawTimeout = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
        throw new Error("Invalid --timeout value.");
      }
      timeoutMs = rawTimeout;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, udid, port, timeoutMs, json };
}

async function detectUdid() {
  const ideviceId = spawn("idevice_id", ["-l"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  ideviceId.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  ideviceId.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise((resolve) => {
    ideviceId.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "Unable to enumerate connected iOS devices.");
  }

  const udids = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (udids.length === 0) {
    throw new Error("No connected iOS devices found.");
  }
  if (udids.length > 1) {
    throw new Error(`Multiple connected iOS devices found. Pass --udid. (${udids.join(", ")})`);
  }

  return udids[0];
}

async function startProxy({ udid, port, timeoutMs }) {
  const proxy = spawn(
    "ios_webkit_debug_proxy",
    ["-c", `${udid}:${port}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  proxy.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  proxy.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proxy.exitCode !== null) {
      throw new Error(
        stderr.trim() || stdout.trim() || `ios_webkit_debug_proxy exited with code ${proxy.exitCode}.`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        return proxy;
      }
    } catch {
      // proxy is still booting
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  proxy.kill("SIGTERM");
  throw new Error(stderr.trim() || stdout.trim() || "Timed out waiting for ios_webkit_debug_proxy.");
}

async function fetchPages(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch iOS webview list (${response.status}).`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Unexpected iOS webview response.");
  }
  return payload;
}

async function waitForInspectablePages(port, timeoutMs) {
  const startedAt = Date.now();
  let lastPages = [];

  while (Date.now() - startedAt < timeoutMs) {
    lastPages = await fetchPages(port);
    if (lastPages.length > 0) {
      return lastPages;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return lastPages;
}

function printHuman(pages, { udid, port }) {
  console.log(`iPhone webviews on ${udid} via :${port}`);
  if (pages.length === 0) {
    console.log("No inspectable webviews found.");
    return;
  }

  pages.forEach((page, index) => {
    console.log(`${index + 1}. ${page.title || "(untitled)"}`);
    console.log(`   url: ${page.url || ""}`);
    console.log(`   ws:  ${page.webSocketDebuggerUrl || ""}`);
    if (page.appId) {
      console.log(`   app: ${page.appId}`);
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "list") {
    throw new Error(`Unsupported command: ${args.command}`);
  }

  const udid = args.udid ?? (await detectUdid());
  const proxy = await startProxy({ udid, port: args.port, timeoutMs: args.timeoutMs });

  try {
    const pages = await waitForInspectablePages(args.port, args.timeoutMs);
    if (args.json) {
      console.log(JSON.stringify({ udid, port: args.port, pages }, null, 2));
    } else {
      printHuman(pages, { udid, port: args.port });
    }
  } finally {
    proxy.kill("SIGTERM");
  }
}

main().catch((error) => {
  printUsage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
