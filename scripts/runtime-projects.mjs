#!/usr/bin/env node
/**
 * Manage local runtime project registry.
 *
 * Commands:
 *   node scripts/runtime-projects.mjs list
 *   node scripts/runtime-projects.mjs add "My Project"
 *   node scripts/runtime-projects.mjs remove <uuid>
 *   node scripts/runtime-projects.mjs ensure [--base-url=http://127.0.0.1:8788] [--quiet]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const registryPath = path.join(repoRoot, "tmp", "runtime-projects.json");
const DEFAULT_SUPABASE_URL = "http://127.0.0.1:54321";

function ensureDirExists(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadRegistry() {
  try {
    const raw = fs.readFileSync(registryPath, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return data;
    }
  } catch (_error) {
    // file missing or invalid; fall back to empty list
  }
  return [];
}

function saveRegistry(entries) {
  ensureDirExists(path.dirname(registryPath));
  fs.writeFileSync(registryPath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
}

function printRegistry(entries) {
  if (entries.length === 0) {
    console.log("(no projects registered yet)");
    return;
  }
  for (const entry of entries) {
    const label = entry.label ?? "(unlabeled)";
    console.log(`${entry.id}  ${label}`);
  }
}

async function ensureRuntime({ id }, options) {
  const baseUrl = options.baseUrl || process.env.CONTROLLER_BASE_URL || "http://127.0.0.1:8788";
  const controllerUrl = `${baseUrl.replace(/\/$/, "")}/runtime/ensure`;

  await ensureSupabaseProject(id, options);

  try {
    const response = await fetch(controllerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: id,
        type: "codex-hosted",
      }),
    });
    if (!response.ok) {
      if (!options.quiet) {
        console.warn(
          `[runtime-projects] controller ensure failed for ${id}: ${response.status} ${response.statusText}`
        );
      }
    } else if (!options.quiet) {
      console.log(`[runtime-projects] ensured runtime record for ${id}`);
    }
  } catch (error) {
    if (!options.quiet) {
      console.warn(
        `[runtime-projects] controller ensure request failed for ${id}: ${
          error?.message ?? error
        }`
      );
    }
  }
}

function resolveSupabaseUrl(options) {
  const candidate =
    options.supabaseUrl ||
    process.env.SUPABASE_PROJECT_URL ||
    process.env.SUPABASE_URL ||
    DEFAULT_SUPABASE_URL;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim().replace(/\/+$/, "")
    : null;
}

function resolveServiceRoleKey(options) {
  const candidate =
    options.serviceRoleKey ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : null;
}

async function ensureSupabaseProject(projectId, options) {
  const supabaseUrl = resolveSupabaseUrl(options);
  const serviceRoleKey = resolveServiceRoleKey(options);
  if (!supabaseUrl || !serviceRoleKey) {
    return;
  }
  const endpoint = `${supabaseUrl}/rest/v1/projects`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        id: projectId,
        project_type: "sandbox",
        status: "active",
      }),
    });
    if (!response.ok) {
      if (!options.quiet) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[runtime-projects] Supabase project upsert failed for ${projectId}: ${response.status} ${response.statusText} ${body}`
        );
      }
    } else if (!options.quiet) {
      console.log(`[runtime-projects] ensured Supabase project ${projectId}`);
    }
  } catch (error) {
    if (!options.quiet) {
      console.warn(
        `[runtime-projects] Supabase project ensure request failed for ${projectId}: ${
          error?.message ?? error
        }`
      );
    }
  }
}

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  const flags = {};
  const args = [];

  for (const item of rest) {
    if (item.startsWith("--")) {
      const [key, value] = item.slice(2).split("=", 2);
      flags[key] = value ?? true;
    } else {
      args.push(item);
    }
  }

  return { command, args, flags };
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv);
  const registry = loadRegistry();

  switch (command) {
    case "list": {
      printRegistry(registry);
      break;
    }
    case "add": {
      const label = args[0] ?? "";
      const id = randomUUID();
      const entry = {
        id,
        label,
        createdAt: new Date().toISOString(),
      };
      registry.push(entry);
      saveRegistry(registry);
      console.log(`[runtime-projects] added ${id}${label ? ` (${label})` : ""}`);
      await ensureRuntime(entry, flags);
      break;
    }
    case "remove": {
      const target = args[0];
      if (!target) {
        console.error("Usage: remove <project-id>");
        process.exitCode = 1;
        break;
      }
      const idx = registry.findIndex((entry) => entry.id === target);
      if (idx === -1) {
        console.warn(`[runtime-projects] project ${target} not found`);
        break;
      }
      registry.splice(idx, 1);
      saveRegistry(registry);
      console.log(`[runtime-projects] removed ${target}`);
      break;
    }
    case "ensure": {
      if (registry.length === 0) {
        if (!flags.quiet) {
          console.log("[runtime-projects] registry empty; nothing to ensure");
        }
        break;
      }
      for (const entry of registry) {
        // eslint-disable-next-line no-await-in-loop
        await ensureRuntime(entry, flags);
      }
      break;
    }
    default: {
      console.log(`Usage:
  node scripts/runtime-projects.mjs list
  node scripts/runtime-projects.mjs add "Project label"
  node scripts/runtime-projects.mjs remove <project-id>
  node scripts/runtime-projects.mjs ensure [--base-url=http://127.0.0.1:8788] [--quiet]`);
      if (registry.length) {
        console.log("\nCurrent registry:");
        printRegistry(registry);
      }
    }
  }
}

await main();
