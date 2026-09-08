import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readLocalSupabaseStatusEnv,
  resolveLocalSupabaseAnonKey,
  resolveLocalSupabaseApiUrl,
  resolveLocalSupabaseServiceRoleKey,
} from "../../scripts/lib/localSupabaseEnv.mjs";
import { resolvePlaywrightControllerUrl } from "./tests/playwright/utils/controllerUrl.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const EXTERNAL_BASE_URL = (process.env.PLAYWRIGHT_EXTERNAL_BASE_URL ?? "").trim();
const USE_EXTERNAL_BASE_URL = EXTERNAL_BASE_URL.length > 0;
const DEFAULT_SUPABASE_URL = "http://127.0.0.1:54321";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
// This is Supabase CLI's public, local-development fixture. It is available
// only to the Node-side Playwright process and is stripped from the Vite child.
const DEFAULT_SUPABASE_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

function isServiceRoleEnvKey(key: string): boolean {
  return key.toUpperCase().includes("SERVICE_ROLE");
}

function withoutViteServerSecrets(
  source: NodeJS.ProcessEnv | Record<string, string>,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !isServiceRoleEnvKey(entry[0]) &&
        entry[0] !== "OPENAI_API_KEY",
    ),
  );
  return env;
}

function isLocalSupabaseUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function resolveSupabaseEnv(): Record<string, string> {
  const allowHostedSupabase =
    USE_EXTERNAL_BASE_URL || (process.env.PLAYWRIGHT_ALLOW_HOSTED_SUPABASE ?? "").trim() === "1";
  const explicitApiUrl = process.env.VITE_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  const explicitAnonKey =
    process.env.VITE_SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim();
  const explicitServiceRole =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SERVICE_ROLE_KEY?.trim();
  if (USE_EXTERNAL_BASE_URL) {
    const controllerUrl = resolvePlaywrightControllerUrl(process.env);
    const env: Record<string, string> = {
      PLAYWRIGHT_ALLOW_HOSTED_SUPABASE: "1",
      PLAYWRIGHT_EXTERNAL_BASE_URL: EXTERNAL_BASE_URL,
    };
    if (explicitApiUrl) {
      env.VITE_SUPABASE_URL = explicitApiUrl;
      env.SUPABASE_URL = explicitApiUrl;
    }
    if (explicitAnonKey) {
      env.VITE_SUPABASE_ANON_KEY = explicitAnonKey;
      env.SUPABASE_ANON_KEY = explicitAnonKey;
    }
    if (explicitServiceRole) {
      env.SUPABASE_SERVICE_ROLE_KEY = explicitServiceRole;
      env.SERVICE_ROLE_KEY = explicitServiceRole;
    }
    if (controllerUrl) {
      env.VITE_CONTROLLER_URL = controllerUrl;
      env.PLAYWRIGHT_CONTROLLER_URL = controllerUrl;
    }
    return env;
  }
  if (explicitApiUrl && explicitAnonKey) {
    const controllerUrl = resolvePlaywrightControllerUrl(process.env);
    const env: Record<string, string> = {
      VITE_SUPABASE_URL: explicitApiUrl,
      SUPABASE_URL: explicitApiUrl,
      VITE_SUPABASE_ANON_KEY: explicitAnonKey,
      SUPABASE_ANON_KEY: explicitAnonKey,
      PLAYWRIGHT_CONTROLLER_URL: controllerUrl,
      VITE_CONTROLLER_URL: controllerUrl,
    };
    if (explicitServiceRole) {
      env.SUPABASE_SERVICE_ROLE_KEY = explicitServiceRole;
      env.SERVICE_ROLE_KEY = explicitServiceRole;
    }
    return env;
  }
  const statusEnv = readLocalSupabaseStatusEnv({ cwd: repoRoot, required: false });
  if (statusEnv) {
    const apiUrl =
      (allowHostedSupabase
        ? (process.env.VITE_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim())
        : null) || resolveLocalSupabaseApiUrl({ env: {}, statusEnv });
    const anonKey =
      (allowHostedSupabase
        ? (process.env.VITE_SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim())
        : null) || resolveLocalSupabaseAnonKey({ env: {}, statusEnv });
    const serviceRole =
      (allowHostedSupabase
        ? (
            process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
            process.env.SERVICE_ROLE_KEY?.trim()
          )
        : null) || resolveLocalSupabaseServiceRoleKey({ env: {}, statusEnv });
    const env: Record<string, string> = {};
    if (apiUrl) {
      env.VITE_SUPABASE_URL = apiUrl;
      env.SUPABASE_URL = apiUrl;
    }
    if (anonKey) {
      env.VITE_SUPABASE_ANON_KEY = anonKey;
      env.SUPABASE_ANON_KEY = anonKey;
    }
    if (serviceRole) {
      env.SUPABASE_SERVICE_ROLE_KEY = serviceRole;
      env.SERVICE_ROLE_KEY = serviceRole;
    }
    const controllerUrl = resolvePlaywrightControllerUrl(process.env);
    env.PLAYWRIGHT_CONTROLLER_URL = controllerUrl;
    env.VITE_CONTROLLER_URL = controllerUrl;
    return env;
  }
  const apiUrl =
    (allowHostedSupabase
      ? (process.env.VITE_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim())
      : null) || DEFAULT_SUPABASE_URL;
  const anonKey =
    (allowHostedSupabase
      ? (process.env.VITE_SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim())
      : null) || DEFAULT_SUPABASE_ANON_KEY;
  const controllerUrl = resolvePlaywrightControllerUrl(process.env);
  const env: Record<string, string> = {
    PLAYWRIGHT_CONTROLLER_URL: controllerUrl,
    VITE_CONTROLLER_URL: controllerUrl,
  };
  if (apiUrl) {
    env.VITE_SUPABASE_URL = apiUrl;
    env.SUPABASE_URL = apiUrl;
  }
  if (anonKey) {
    env.VITE_SUPABASE_ANON_KEY = anonKey;
    env.SUPABASE_ANON_KEY = anonKey;
  }
  if (isLocalSupabaseUrl(apiUrl)) {
    env.SUPABASE_SERVICE_ROLE_KEY = DEFAULT_SUPABASE_SERVICE_ROLE_KEY;
    env.SERVICE_ROLE_KEY = DEFAULT_SUPABASE_SERVICE_ROLE_KEY;
  }
  return env;
}

const DEV_PORT = 5199;
// The local controller/origin/Supabase stack still tips into runtime/origin timeouts under
// a two-worker full-suite run. Default to a single worker for stability; callers can still
// opt into more parallelism via PLAYWRIGHT_BATCH_SIZE when they know the stack can handle it.
const DEFAULT_LOCAL_BATCH_SIZE = 1;
const RUN_PLAYWRIGHT_BENCH = (process.env.PLAYWRIGHT_RUN_BENCH ?? "").trim() === "1";
const supabaseEnv = resolveSupabaseEnv();
for (const key of Object.keys(process.env)) {
  if (key.startsWith("VITE_") && isServiceRoleEnvKey(key)) {
    delete process.env[key];
  }
}
const resolveRtTestHosts =
  (process.env.PLAYWRIGHT_RESOLVE_RT_TEST ?? "").trim() === "1" ||
  (process.env.PLAYWRIGHT_DESKTOP_ORIGIN_TUNNEL_SMOKE ?? "").trim() === "1";

function resolveWorkerCount(): number {
  const explicitRaw = (process.env.PLAYWRIGHT_BATCH_SIZE ?? process.env.PLAYWRIGHT_WORKERS ?? "").trim();
  if (explicitRaw.length > 0) {
    const parsed = Number.parseInt(explicitRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    console.warn(
      `[playwright-config] Ignoring invalid PLAYWRIGHT_BATCH_SIZE/PLAYWRIGHT_WORKERS value "${explicitRaw}".`
    );
  }
  return process.env.CI ? 1 : DEFAULT_LOCAL_BATCH_SIZE;
}

const workers = resolveWorkerCount();
if ((process.env.PLAYWRIGHT_CLEANUP_RUNTIME ?? "").trim() === "") {
  // Per-test Docker runtime cleanup can kill active runtimes from sibling workers.
  // Keep cleanup enabled for single-worker runs, disable by default for parallel batches.
  process.env.PLAYWRIGHT_CLEANUP_RUNTIME = workers > 1 ? "0" : "1";
}

for (const [key, value] of Object.entries(supabaseEnv)) {
  if (!value) continue;
  if ((process.env[key] ?? "").trim() !== "") continue;
  process.env[key] = value;
}

if (
  (process.env.CONTROLLER_INTERNAL_TOKEN ?? "").trim() === "" &&
  (process.env.VITE_CONTROLLER_URL ?? supabaseEnv.VITE_CONTROLLER_URL ?? "").includes("127.0.0.1")
) {
  process.env.CONTROLLER_INTERNAL_TOKEN = "dev-internal-token";
}

const viteWebServerEnv = withoutViteServerSecrets({
  ...process.env,
  ...supabaseEnv,
});

const defaultChromiumIgnore = [
  "tests/playwright/orgs/**/*.spec.ts",
  // Scratch capture/audit specs are intentionally local and may write outside
  // the test artifacts directory; keep them out of the canonical regression run.
  "tests/playwright/tmp/**/*.spec.ts",
  // Component specs mount a single component against the dev server with the
  // data layer stubbed; they need no runtime stack, so they run in their own
  // dependency-free project instead of the heavy chromium one.
  "tests/playwright/component/**/*.spec.ts",
  // Production fixture benchmarks use their own isolated config and budgets.
  "tests/playwright/conversation-perf/**/*.spec.ts",
];
if (!RUN_PLAYWRIGHT_BENCH) {
  // Benchmarks are opt-in evaluation coverage and should not inflate the default product regression loop.
  defaultChromiumIgnore.push("tests/playwright/bench/**/*.spec.ts");
}

export default defineConfig({
  testDir: "tests/playwright",
  // Utility-level Vitest coverage also lives under tests/playwright. Restrict
  // Playwright collection to its .spec files so the two runners never install
  // competing expect matchers in the same worker process.
  testMatch: "**/*.spec.ts",
  retries: process.env.CI ? 2 : 1,
  globalTeardown: "./tests/playwright/global-teardown.ts",
  reporter: [["list"], ["./tests/playwright/runtime-cleanup-reporter.ts"]],
  use: {
    baseURL: USE_EXTERNAL_BASE_URL ? EXTERNAL_BASE_URL.replace(/\/+$/, "") : `http://127.0.0.1:${DEV_PORT}`,
    headless: true,
    trace: "retain-on-failure"
  },
  workers,
  webServer: USE_EXTERNAL_BASE_URL
    ? undefined
    : {
        command: `node ./scripts/playwright-web-server.mjs --host 127.0.0.1 --port ${DEV_PORT} --strictPort`,
        url: `http://127.0.0.1:${DEV_PORT}`,
        reuseExistingServer:
          !process.env.CI &&
          (process.env.PLAYWRIGHT_FORCE_FRESH_SERVER ?? "").trim() !== "1",
        stderr: "pipe",
        env: {
          ...viteWebServerEnv,
          VITE_DEV_GUEST_EMAIL: process.env.PLAYWRIGHT_TEST_EMAIL ?? "playwright@instafy.dev",
          VITE_DEV_GUEST_PASSWORD: process.env.PLAYWRIGHT_TEST_PASSWORD ?? "Playwright123!",
          VITE_DISABLE_AUTO_RUNTIME_ENSURE: "1",
          PLAYWRIGHT_REQUIRE_ORIGIN: "1"
        }
      },
  projects: [
    {
      name: "runtime-setup",
      testDir: "tests/playwright/setup",
      testMatch: /runtimeStack\.setup\.(ts|js)/
    },
    {
      // Dependency-free: component specs stub the data layer and only need the
      // Vite dev server (started by the shared webServer), not the runtime stack.
      name: "component",
      testDir: "tests/playwright/component",
    },
    {
      name: "chromium",
      testDir: "tests/playwright",
      testIgnore: defaultChromiumIgnore,
      dependencies: ["runtime-setup"],
      use: resolveRtTestHosts
        ? {
            launchOptions: {
              args: ["--host-resolver-rules=MAP *.rt.test 127.0.0.1"],
            },
          }
        : undefined
    },
    {
      name: "chromium-orgs",
      testDir: "tests/playwright/orgs",
      dependencies: ["runtime-setup"],
      workers: 1,
      use: resolveRtTestHosts
        ? {
            launchOptions: {
              args: ["--host-resolver-rules=MAP *.rt.test 127.0.0.1"],
            },
          }
        : undefined
    }
  ]
});
