#!/usr/bin/env node
/**
 * Frontend dev launcher.
 *
 * Ensures the Vite dev server inherits controller + Supabase env vars by
 * reading docker/.env.local (generated via `pnpm stack:up`) and falling back
 * to local defaults.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolvePrivateEnvPath } from "../../../scripts/lib/privateEnvPaths.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const frontendDir = path.resolve(__dirname, "..");
const privateEnvPath = (relativePath) =>
  resolvePrivateEnvPath({ repoRoot, relativePath });
const composeEnvPath = privateEnvPath("docker/.env.local");
const frontendEnvPath = privateEnvPath("packages/frontend/.env.local");
const supabaseLocalEnvPath = privateEnvPath(".env.supabase.local");
const LOCAL_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const env = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

function normalizeControllerUrl(raw) {
  if (!raw) return "http://127.0.0.1:8788";
  if (raw.includes("host.docker.internal")) {
    return raw.replace("host.docker.internal", "127.0.0.1");
  }
  return raw.trim();
}

const composeEnv = parseEnvFile(composeEnvPath);
const frontendEnv = parseEnvFile(frontendEnvPath);
const supabaseLocalEnv = parseEnvFile(supabaseLocalEnvPath);

const env = {
  ...process.env
};
// Vite exposes VITE_* values to browser code. Keep every service-role alias
// out of the Vite process, including values inherited from a developer shell.
for (const key of Object.keys(env)) {
  if (key.toUpperCase().includes("SERVICE_ROLE")) {
    delete env[key];
  }
}

const supabaseConfigSource = (() => {
  if (composeEnv.SUPABASE_URL || composeEnv.SUPABASE_ANON_KEY) {
    return "compose";
  }
  if (supabaseLocalEnv.VITE_SUPABASE_URL || supabaseLocalEnv.VITE_SUPABASE_ANON_KEY) {
    return "supabase-local";
  }
  if (frontendEnv.VITE_SUPABASE_URL || frontendEnv.VITE_SUPABASE_ANON_KEY) {
    return "frontend";
  }
  return "default";
})();

if (supabaseConfigSource === "compose") {
  env.VITE_SUPABASE_URL = composeEnv.SUPABASE_URL || "http://127.0.0.1:54321";
  env.VITE_SUPABASE_ANON_KEY = composeEnv.SUPABASE_ANON_KEY || LOCAL_SUPABASE_ANON_KEY;
} else if (supabaseConfigSource === "supabase-local") {
  env.VITE_SUPABASE_URL = supabaseLocalEnv.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
  env.VITE_SUPABASE_ANON_KEY = supabaseLocalEnv.VITE_SUPABASE_ANON_KEY || LOCAL_SUPABASE_ANON_KEY;
} else if (supabaseConfigSource === "frontend") {
  env.VITE_SUPABASE_URL = frontendEnv.VITE_SUPABASE_URL || "http://127.0.0.1:54321";
  env.VITE_SUPABASE_ANON_KEY = frontendEnv.VITE_SUPABASE_ANON_KEY || LOCAL_SUPABASE_ANON_KEY;
} else {
  env.VITE_SUPABASE_URL = "http://127.0.0.1:54321";
  env.VITE_SUPABASE_ANON_KEY = LOCAL_SUPABASE_ANON_KEY;
}

const controllerUrlCandidate = (() => {
  if (composeEnv.CONTROLLER_BASE_URL || composeEnv.EDGE_URL) {
    return composeEnv.CONTROLLER_BASE_URL || composeEnv.EDGE_URL;
  }
  if (process.env.VITE_CONTROLLER_URL) {
    return process.env.VITE_CONTROLLER_URL;
  }
  if (supabaseConfigSource === "frontend" && frontendEnv.VITE_CONTROLLER_URL) {
    return frontendEnv.VITE_CONTROLLER_URL;
  }
  return undefined;
})();
env.VITE_CONTROLLER_URL = normalizeControllerUrl(controllerUrlCandidate);
env.VITE_RUNTIME_PROJECT_ID ??=
  process.env.VITE_RUNTIME_PROJECT_ID ||
  frontendEnv.VITE_RUNTIME_PROJECT_ID ||
  composeEnv.SPACE_ID ||
  process.env.SPACE_ID ||
  "";

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const args = ["exec", "vite", ...cliArgs];
const hasHost = cliArgs.includes("--host");
const hasPort = cliArgs.includes("--port");
if (!hasHost) {
  args.push("--host", process.env.VITE_HOST || "127.0.0.1");
}
if (!hasPort) {
  args.push("--port", process.env.VITE_PORT || process.env.PORT || "5173");
}
const child = spawn("pnpm", args, {
  cwd: frontendDir,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
