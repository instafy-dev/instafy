#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webhookTunnelScript = path.join(__dirname, "webhook-tunnel.mjs");

const forwardedArgs = process.argv.slice(2);
const args = [
  "--port",
  "8796",
  "--ready-path",
  "/health",
  "--print-speech-env",
  ...forwardedArgs,
];

const child = spawn(process.execPath, [webhookTunnelScript, ...args], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(
    `[speech-tunnel] Failed to start speech tunnel wrapper: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
