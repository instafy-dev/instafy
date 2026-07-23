import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTROLLER_URL, resolvePlaywrightControllerUrl } from "./controllerUrl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../..");
const defaultWorkspaceRoot = path.join(repoRoot, "tmp", "runtime-sandbox");
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? defaultWorkspaceRoot);
try {
  fs.mkdirSync(workspaceRoot, { recursive: true });
} catch (error) {
  console.warn(
    `[controllerStack] Unable to ensure workspace root at ${workspaceRoot}: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}
const DEFAULT_SUPABASE_URL = "http://127.0.0.1:54321";

const keepStack = process.env.PLAYWRIGHT_KEEP_STACK === "1";

let startPromise: Promise<void> | null = null;
let activeCount = 0;

const controllerUrl = resolvePlaywrightControllerUrl(process.env) || DEFAULT_CONTROLLER_URL;
const supabaseUrl = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL).trim();
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const resolvedDevIsolation =
  (process.env.PLAYWRIGHT_RUNTIME_DEV_ISOLATION ??
    process.env.RUNTIME_DEV_ISOLATION ??
    "1"
  ).trim();
const runtimeDevIsolationFlag = resolvedDevIsolation === "" ? "0" : resolvedDevIsolation;
process.env.PLAYWRIGHT_RUNTIME_DEV_ISOLATION = runtimeDevIsolationFlag;
if (!process.env.RUNTIME_DEV_ISOLATION || process.env.RUNTIME_DEV_ISOLATION.trim() === "") {
  process.env.RUNTIME_DEV_ISOLATION = runtimeDevIsolationFlag;
}
const resolvedStrictMode =
  (process.env.PLAYWRIGHT_RUNTIME_STRICT_MODE ??
    process.env.RUNTIME_STRICT_MODE ??
    (runtimeDevIsolationFlag === "1" ? "1" : "0")
  ).trim();
if (!process.env.RUNTIME_STRICT_MODE || process.env.RUNTIME_STRICT_MODE.trim() === "") {
  process.env.RUNTIME_STRICT_MODE = resolvedStrictMode === "" ? "0" : resolvedStrictMode;
}
const runtimeStrictModeFlag = (process.env.RUNTIME_STRICT_MODE ?? "0").trim() || "0";
const expectWorkspaceCleanup = (process.env.RUNTIME_DEV_ISOLATION ?? "0").trim() === "1";

async function waitForUrl(url: string, timeoutMs: number, label: string) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response) {
        return;
      }
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

function listWorkspaceProjectDirs(): string[] {
  if (!fs.existsSync(workspaceRoot)) {
    return [];
  }
  const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && uuidPattern.test(entry.name))
    .map((entry) => entry.name);
}

function assertWorkspaceCleanup() {
  if (!expectWorkspaceCleanup) {
    return;
  }
  const leftovers = listWorkspaceProjectDirs();
  if (leftovers.length === 0) {
    return;
  }
  for (const dir of leftovers) {
    const target = path.join(workspaceRoot, dir);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[controllerStack] Failed to remove leftover workspace ${target}: ${message}`);
    }
  }
  throw new Error(
    `[controllerStack] expected isolated workspace cleanup but found ${leftovers.length} project director${leftovers.length === 1 ? "y" : "ies"}: ${leftovers.join(", ")}`
  );
}

function cleanupWorkspaceProjects(projectIds: string[]) {
  const unique = [...new Set(projectIds.filter((id) => uuidPattern.test(id)))];
  for (const id of unique) {
    const target = path.join(workspaceRoot, id);
    if (!fs.existsSync(target)) {
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      console.log(`[controllerStack] Removed workspace directory for ${id}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[controllerStack] Failed to remove workspace ${target}: ${message}`);
    }
  }
}

async function cleanupSupabaseProjects(projectIds: string[]) {
  const unique = [...new Set(projectIds.filter((id) => uuidPattern.test(id)))];
  if (unique.length === 0) {
    return;
  }
  const uniqueSet = new Set(unique);
  const serviceRole =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    "";
  if (!serviceRole) {
    console.warn("[controllerStack] Skipping Supabase cleanup (SERVICE_ROLE_KEY missing).");
    return;
  }
  if (!supabaseUrl) {
    console.warn("[controllerStack] Skipping Supabase cleanup (SUPABASE_URL missing).");
    return;
  }

  const writeHeaders: Record<string, string> = {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    prefer: "return=minimal"
  };
  const readHeaders: Record<string, string> = {
    ...writeHeaders,
    prefer: "return=representation"
  };

  const projectOrgMap = new Map<string, string>();

  for (const projectId of unique) {
    try {
      const response = await fetch(
        `${supabaseUrl}/rest/v1/projects?id=eq.${projectId}&select=id,org_id`,
        {
          method: "GET",
          headers: readHeaders
        }
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[controllerStack] Failed to load project ${projectId} org: ${response.status} ${response.statusText} ${body}`
        );
        continue;
      }
      const rows = (await response.json()) as Array<{ org_id: string | null }>;
      const orgId = rows[0]?.org_id;
      if (typeof orgId === "string") {
        projectOrgMap.set(projectId, orgId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[controllerStack] Supabase lookup error (${projectId}): ${message}`);
    }
  }

  const orgIds = [...new Set(projectOrgMap.values())];
  const exclusiveOrgIds = new Set<string>();

  for (const orgId of orgIds) {
    try {
      const response = await fetch(
        `${supabaseUrl}/rest/v1/projects?org_id=eq.${orgId}&select=id`,
        {
          method: "GET",
          headers: readHeaders
        }
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[controllerStack] Failed to inspect projects for org ${orgId}: ${response.status} ${response.statusText} ${body}`
        );
        continue;
      }
      const rows = (await response.json()) as Array<{ id: string }>;
      const foreignProjectExists = rows.some((row) => !uniqueSet.has(row.id));
      if (!foreignProjectExists) {
        exclusiveOrgIds.add(orgId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[controllerStack] Supabase org inspection error (${orgId}): ${message}`);
    }
  }

  const scopedTables: Array<{ table: string; column: string }> = [
    { table: "conversation_messages", column: "project_id" },
    { table: "conversations", column: "project_id" },
    { table: "prompts", column: "project_id" },
    { table: "runs", column: "project_id" },
    { table: "agent_jobs", column: "project_id" },
    { table: "runtime_events", column: "project_id" },
    { table: "runtimes", column: "project_id" },
    { table: "org_credit_ledger", column: "project_id" },
    { table: "sites", column: "project_id" }
  ];

  for (const projectId of unique) {
    for (const { table, column } of scopedTables) {
      try {
        const response = await fetch(
          `${supabaseUrl}/rest/v1/${table}?${column}=eq.${projectId}`,
          {
            method: "DELETE",
            headers: writeHeaders
          }
        );
        if (!response.ok && response.status !== 404) {
          const body = await response.text().catch(() => "");
          console.warn(
            `[controllerStack] Failed to purge ${table} for project ${projectId}: ${response.status} ${response.statusText} ${body}`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[controllerStack] Supabase cleanup error for table ${table} (${projectId}): ${message}`
        );
      }
    }

    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/projects?id=eq.${projectId}`, {
        method: "DELETE",
        headers: writeHeaders
      });
      if (!response.ok && response.status !== 404) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[controllerStack] Failed to remove project record ${projectId}: ${response.status} ${response.statusText} ${body}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[controllerStack] Supabase project removal error (${projectId}): ${message}`);
    }
  }

  for (const orgId of exclusiveOrgIds) {
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/organizations?id=eq.${orgId}`, {
        method: "DELETE",
        headers: writeHeaders
      });
      if (!response.ok && response.status !== 404) {
        const body = await response.text().catch(() => "");
        console.warn(
          `[controllerStack] Failed to remove organization ${orgId}: ${response.status} ${response.statusText} ${body}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[controllerStack] Supabase organization removal error (${orgId}): ${message}`);
    }
  }
}

async function startStack() {
  console.log(
    `[controllerStack] desired runtime flags: strict_mode=${runtimeStrictModeFlag}, dev_isolation=${runtimeDevIsolationFlag}`
  );
  try {
    await waitForUrl(controllerUrl, 15_000, "controller");
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : `Controller not reachable at ${controllerUrl}`;
    throw new Error(
      `${message}. Ensure the controller stack is running (try 'pnpm controller:up' before Playwright tests).`
    );
  }

  try {
    await waitForUrl(supabaseUrl, 15_000, "supabase");
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : `Supabase not reachable at ${supabaseUrl}`;
    throw new Error(
      `${message}. Ensure the controller stack is running (try 'pnpm controller:up' before Playwright tests).`
    );
  }

  process.env.PLAYWRIGHT_CONTROLLER_URL = controllerUrl;
  process.env.VITE_CONTROLLER_URL = controllerUrl;
  process.env.VITE_SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_PROJECT_URL = supabaseUrl;
}

async function stopStack() {
  if (keepStack) {
    return;
  }

  const candidateProjectIds = new Set<string>();
  listWorkspaceProjectDirs().forEach((dir) => {
    if (uuidPattern.test(dir)) {
      candidateProjectIds.add(dir);
    }
  });

  if (candidateProjectIds.size > 0) {
    await cleanupSupabaseProjects(Array.from(candidateProjectIds));
    cleanupWorkspaceProjects(Array.from(candidateProjectIds));
  }

  assertWorkspaceCleanup();
}

export interface ControllerStackHandle {
  teardown: () => Promise<void>;
}

export async function ensureControllerStack(): Promise<ControllerStackHandle> {
  activeCount += 1;
  if (!startPromise) {
    startPromise = startStack().catch((error) => {
      startPromise = null;
      throw error;
    });
  }

  await startPromise;

  return {
    teardown: async () => {
      activeCount -= 1;
      if (activeCount <= 0) {
        activeCount = 0;
        startPromise = null;
        await stopStack();
      }
    }
  };
}
