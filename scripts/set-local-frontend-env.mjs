#!/usr/bin/env node
/**
 * Seed packages/frontend/.env.local with public browser configuration so
 * Vite/Playwright don't need to mutate env inside the config file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePrivateEnvPath,
  writePrivateEnvFileSync,
} from "./lib/privateEnvPaths.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const privateEnvPath = (relativePath) =>
  resolvePrivateEnvPath({ repoRoot, relativePath });
const envPath = privateEnvPath("packages/frontend/.env.local");
const supabaseEnvPath = privateEnvPath(".env.supabase");
const supabaseLocalEnvPath = privateEnvPath(".env.supabase.local");

applyEnvFile(supabaseLocalEnvPath);
applyEnvFile(supabaseEnvPath);

const trim = (value) => (value ?? "").toString().trim();
const controllerUrl = trim(process.env.VITE_CONTROLLER_URL) || "http://127.0.0.1:8788";
const supabaseUrl =
  trim(process.env.VITE_SUPABASE_URL) ||
  trim(process.env.SUPABASE_URL) ||
  "http://127.0.0.1:54321";
const supabaseAnonKey =
  trim(process.env.VITE_SUPABASE_ANON_KEY) ||
  trim(process.env.SUPABASE_ANON_KEY) ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const lines = [
  `VITE_CONTROLLER_URL=${controllerUrl}`,
  `VITE_SUPABASE_URL=${supabaseUrl}`,
  `VITE_SUPABASE_ANON_KEY=${supabaseAnonKey}`,
];

const content = `${lines.join("\n")}\n`;
try {
  const writtenPath = writePrivateEnvFileSync({
    repoRoot,
    relativePath: "packages/frontend/.env.local",
    data: content,
    encoding: "utf-8",
  });
  if (writtenPath !== envPath) {
    throw new Error("private env path changed between resolution and write");
  }
  console.log(`[set-frontend-env] wrote ${envPath}`);
} catch (error) {
  console.error(`[set-frontend-env] failed to write ${envPath}: ${error.message || error}`);
  process.exitCode = 1;
}

function applyEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf-8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^['"](.+)['"]$/, "$1");
      if (!key || !value) continue;
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // best-effort only
  }
}
