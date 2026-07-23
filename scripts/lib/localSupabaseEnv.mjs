import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_STATUS_TIMEOUT_MS = 20_000;

function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(candidates) {
  for (const candidate of candidates) {
    const value = normalize(candidate);
    if (value) {
      return value;
    }
  }
  return "";
}

function fillIfBlank(targetEnv, keys, value) {
  const normalized = normalize(value);
  if (!normalized) {
    return;
  }
  for (const key of keys) {
    if (!normalize(targetEnv[key])) {
      targetEnv[key] = normalized;
    }
  }
}

export function parseShellEnv(text) {
  const map = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const value = rawValue.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (key) {
      map[key] = value;
    }
  }
  return map;
}

export function readLocalSupabaseStatusEnv(options = {}) {
  const {
    cwd = DEFAULT_REPO_ROOT,
    required = false,
    timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
  } = options;
  const boundedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(Math.floor(timeoutMs), 120_000)
      : DEFAULT_STATUS_TIMEOUT_MS;
  const result = spawnSync(
    "pnpm",
    ["exec", "supabase", "--workdir", "supabase", "status", "--output", "env"],
    {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: boundedTimeoutMs,
      killSignal: "SIGTERM",
    },
  );
  const exitCode = result.status ?? result.code ?? 1;
  if (exitCode !== 0) {
    if (!required) {
      return null;
    }
    const stderr = normalize(result.stderr);
    const timedOut = result.error?.code === "ETIMEDOUT";
    throw new Error(
      `Failed to read local Supabase status env. Start it first with \`pnpm supabase:up\`.\n${
        stderr ||
        (timedOut
          ? `pnpm timed out after ${boundedTimeoutMs}ms`
          : `pnpm exited with code ${exitCode}`)
      }`,
    );
  }
  return parseShellEnv(result.stdout ?? "");
}

export function resolveLocalSupabaseDbUrl(options = {}) {
  const { env = process.env, statusEnv = null } = options;
  return firstNonEmpty([
    env.TEST_DATABASE_URL,
    env.DATABASE_URL,
    env.SUPABASE_DB_URL,
    env.SUPABASE_LOCAL_DB_URL,
    env.DB_URL,
    env.POSTGRES_URL,
    env.POSTGRES_CONNECTION_STRING,
    statusEnv?.DB_URL,
    statusEnv?.DATABASE_URL,
    statusEnv?.SUPABASE_DB_URL,
    statusEnv?.SUPABASE_LOCAL_DB_URL,
    statusEnv?.POSTGRES_URL,
    statusEnv?.POSTGRES_CONNECTION_STRING,
  ]);
}

export function resolveLocalSupabaseApiUrl(options = {}) {
  const { env = process.env, statusEnv = null } = options;
  return firstNonEmpty([
    env.SUPABASE_PROJECT_URL,
    env.VITE_SUPABASE_URL,
    env.SUPABASE_URL,
    env.API_URL,
    statusEnv?.SUPABASE_PROJECT_URL,
    statusEnv?.SUPABASE_URL,
    statusEnv?.API_URL,
    statusEnv?.PROJECT_URL,
  ]);
}

export function resolveLocalSupabaseAnonKey(options = {}) {
  const { env = process.env, statusEnv = null } = options;
  return firstNonEmpty([
    env.VITE_SUPABASE_ANON_KEY,
    env.SUPABASE_ANON_KEY,
    env.ANON_KEY,
    statusEnv?.ANON_KEY,
    statusEnv?.SUPABASE_ANON_KEY,
  ]);
}

export function resolveLocalSupabaseServiceRoleKey(options = {}) {
  const { env = process.env, statusEnv = null } = options;
  return firstNonEmpty([
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SERVICE_ROLE_KEY,
    statusEnv?.SERVICE_ROLE_KEY,
    statusEnv?.SUPABASE_SERVICE_ROLE_KEY,
  ]);
}

export function primeProcessEnvFromLocalSupabase(targetEnv = process.env, options = {}) {
  const {
    cwd = DEFAULT_REPO_ROOT,
    fillApiUrl = false,
    fillAnonKey = false,
    fillServiceRole = false,
    required = false,
  } = options;
  const requestedValuesAlreadyPresent =
    (!fillApiUrl || Boolean(resolveLocalSupabaseApiUrl({ env: targetEnv }))) &&
    (!fillAnonKey || Boolean(resolveLocalSupabaseAnonKey({ env: targetEnv }))) &&
    (!fillServiceRole ||
      Boolean(resolveLocalSupabaseServiceRoleKey({ env: targetEnv })));
  if (!required && requestedValuesAlreadyPresent) {
    // External/production Playwright runs provide every credential explicitly.
    // Asking the local Supabase CLI for optional fallbacks in that case adds a
    // Docker dependency and can hang a release canary before its own strict
    // recovery fixture starts. Required local-stack callers still always
    // verify the CLI status below.
    if (fillApiUrl) {
      fillIfBlank(
        targetEnv,
        ["VITE_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_PROJECT_URL"],
        resolveLocalSupabaseApiUrl({ env: targetEnv }),
      );
    }
    if (fillAnonKey) {
      fillIfBlank(
        targetEnv,
        ["VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"],
        resolveLocalSupabaseAnonKey({ env: targetEnv }),
      );
    }
    if (fillServiceRole) {
      fillIfBlank(
        targetEnv,
        ["SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"],
        resolveLocalSupabaseServiceRoleKey({ env: targetEnv }),
      );
    }
    return null;
  }
  const statusEnv = readLocalSupabaseStatusEnv({ cwd, required });
  if (!statusEnv) {
    return null;
  }

  if (fillApiUrl) {
    const apiUrl = resolveLocalSupabaseApiUrl({ env: targetEnv, statusEnv });
    fillIfBlank(targetEnv, ["VITE_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_PROJECT_URL"], apiUrl);
  }

  if (fillAnonKey) {
    const anonKey = resolveLocalSupabaseAnonKey({ env: targetEnv, statusEnv });
    fillIfBlank(targetEnv, ["VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"], anonKey);
  }

  if (fillServiceRole) {
    const serviceRoleKey = resolveLocalSupabaseServiceRoleKey({ env: targetEnv, statusEnv });
    fillIfBlank(
      targetEnv,
      ["SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"],
      serviceRoleKey,
    );
  }

  return statusEnv;
}
