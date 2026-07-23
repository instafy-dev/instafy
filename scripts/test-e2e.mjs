import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PIDFILE_PATH =
  process.env.TEST_E2E_PIDFILE ?? path.join(process.cwd(), "tmp", "test-e2e.pid");
const INNER_FLAG = "INSTAFY_TEST_E2E_INNER";
const KNOWN_VARIANTS = [
  "core",
  "smoke",
  "smoke-core",
  "controller",
  "projects",
  "orgs",
  "payments",
  "automations",
  "voice",
  "bench",
  "headed",
];
const VARIANT_CONFIG = {
  core: { args: [], env: {} },
  smoke: {
    args: ["tests/playwright/smoke", "--max-failures=1"],
    env: {},
  },
  "smoke-core": {
    args: [
      "tests/playwright/smoke/browser-session-smoke.spec.ts",
      "tests/playwright/smoke/conversation-smoke.spec.ts",
      "tests/playwright/smoke/file-explorer-ui.spec.ts",
      "tests/playwright/smoke/project-picker.spec.ts",
      "tests/playwright/smoke/robot-lab-provider-binding.spec.ts",
      "tests/playwright/smoke/runtime-ai-model-select.spec.ts",
      "--max-failures=1",
    ],
    env: {},
  },
  controller: {
    args: [
      "tests/playwright/api",
      "tests/playwright/smoke/conversation-smoke.spec.ts",
      "--max-failures=1",
    ],
    env: {},
  },
  projects: {
    args: ["tests/playwright/projects", "--max-failures=1"],
    env: {},
  },
  orgs: {
    args: ["tests/playwright/orgs", "--max-failures=1"],
    env: {},
  },
  payments: {
    args: [
      "tests/playwright/credits",
      "tests/playwright/payments",
      "--max-failures=1",
    ],
    env: {},
  },
  automations: {
    args: ["tests/playwright/automations", "--max-failures=1"],
    env: {},
  },
  voice: {
    args: [
      "tests/playwright/smoke/chat-voice-speech.spec.ts",
      "--max-failures=1",
    ],
    env: {},
  },
  bench: {
    args: ["tests/playwright/bench", "--max-failures=1"],
    env: {
      PLAYWRIGHT_RUN_BENCH: "1",
    },
  },
  headed: {
    args: ["--max-failures=1", "--headed"],
    env: {},
  },
};

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node scripts/test-e2e.mjs run [variant] [-- <playwright args...>]",
      "  node scripts/test-e2e.mjs stop",
      "  node scripts/test-e2e.mjs status",
      "",
      "Variants:",
      `  ${KNOWN_VARIANTS.join(", ")}`,
      "",
      `Pidfile: ${PIDFILE_PATH}`,
    ].join("\n")
  );
}

function normalizePassthroughArgs(rawArgs) {
  if (rawArgs.length > 0 && rawArgs[0] === "--") return rawArgs.slice(1);
  return rawArgs;
}

async function readPidfile() {
  if (!existsSync(PIDFILE_PATH)) return null;
  try {
    const raw = await readFile(PIDFILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writePidfile(data) {
  await mkdir(path.dirname(PIDFILE_PATH), { recursive: true });
  await writeFile(PIDFILE_PATH, `${JSON.stringify(data)}\n`, "utf8");
}

async function removePidfileIfMatches(expectedPid) {
  const current = await readPidfile();
  if (!current) return;
  if (current.pid !== expectedPid) return;
  await rm(PIDFILE_PATH, { force: true });
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid, signal) {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T", "/F"];
    const res = spawnSync("taskkill", args, { stdio: "inherit" });
    return res.status === 0;
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isRunning(pid)) return true;
    await sleep(200);
  }
  return !isRunning(pid);
}

function resolveVariant(rawVariant) {
  const variant = (rawVariant ?? "core").trim().toLowerCase();
  if (variant === "") return "core";
  if (Object.hasOwn(VARIANT_CONFIG, variant)) return variant;
  throw new Error(`Unknown variant: ${rawVariant}`);
}

function resolveVariantPlaywrightConfig(variant) {
  const config = VARIANT_CONFIG[variant];
  if (config) return config;
  throw new Error(`Unsupported variant: ${variant}`);
}

function createChildEnv(overrides = {}) {
  const env = {
    ...process.env,
    ...overrides,
  };
  env.BROWSERSLIST_IGNORE_OLD_DATA = env.BROWSERSLIST_IGNORE_OLD_DATA ?? "1";
  env.BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA =
    env.BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA ?? "1";
  delete env.NO_COLOR;
  return env;
}

async function runInner() {
  const variant = resolveVariant(process.env.INSTAFY_TEST_E2E_VARIANT);
  const rawArgs = process.argv.slice(2);
  const passthroughArgs = normalizePassthroughArgs(rawArgs);
  const variantConfig = resolveVariantPlaywrightConfig(variant);
  const shouldSkipBuild = (process.env.INSTAFY_TEST_E2E_SKIP_BUILD ?? "").trim() === "1";

  if (!shouldSkipBuild) {
    const build = spawn("pnpm", ["--filter", "@instafy/frontend", "build"], {
      stdio: "inherit",
      env: createChildEnv(),
    });
    const buildCode = await new Promise((resolve) => {
      build.on("exit", (code) => resolve(typeof code === "number" ? code : 1));
    });
    if (buildCode !== 0) process.exit(buildCode);
  }

  const testArgs = [
    "--filter",
    "@instafy/frontend",
    "exec",
    "node",
    "./scripts/playwright-test.mjs",
    ...variantConfig.args,
    ...passthroughArgs,
  ];
  const test = spawn("pnpm", testArgs, {
    stdio: "inherit",
    env: createChildEnv(variantConfig.env),
  });
  const testCode = await new Promise((resolve) => {
    test.on("exit", (code) => resolve(typeof code === "number" ? code : 1));
  });
  process.exit(testCode);
}

async function runOuter(rawVariant, rawArgs) {
  const variant = resolveVariant(rawVariant);
  const passthroughArgs = normalizePassthroughArgs(rawArgs);

  const existing = await readPidfile();
  if (existing?.pid && isRunning(existing.pid)) {
    console.error(
      `[test:e2e] already running (pid=${existing.pid}, variant=${existing.variant ?? "unknown"}).`
    );
    console.error(`[test:e2e] stop it with: pnpm test:e2e:stop`);
    process.exit(1);
  }
  if (existing?.pid && !isRunning(existing.pid)) {
    await rm(PIDFILE_PATH, { force: true });
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, "--", ...passthroughArgs], {
    stdio: "inherit",
    detached: true,
    env: createChildEnv({
      [INNER_FLAG]: "1",
      INSTAFY_TEST_E2E_VARIANT: variant,
    }),
  });

  if (!child.pid) {
    console.error("[test:e2e] failed to start runner (no pid).");
    process.exit(1);
  }

  await writePidfile({
    pid: child.pid,
    variant,
    args: passthroughArgs,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  });

  const forward = (signal) => {
    killTree(child.pid, signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGHUP", () => forward("SIGHUP"));

  child.on("error", async () => {
    await removePidfileIfMatches(child.pid);
    process.exitCode = 1;
  });

  child.on("exit", async (code) => {
    await removePidfileIfMatches(child.pid);
    process.exitCode = typeof code === "number" ? code : 1;
  });
}

async function stopOuter() {
  const existing = await readPidfile();
  if (!existing?.pid) {
    console.log("[test:e2e] no pidfile found; nothing to stop.");
    return;
  }

  if (!isRunning(existing.pid)) {
    console.log(
      `[test:e2e] stale pidfile (pid=${existing.pid}); removing ${PIDFILE_PATH}.`
    );
    await rm(PIDFILE_PATH, { force: true });
    return;
  }

  console.log(
    `[test:e2e] stopping pid=${existing.pid} variant=${existing.variant ?? "unknown"}…`
  );
  killTree(existing.pid, "SIGTERM");
  const exited = await waitForExit(existing.pid, 10_000);
  if (!exited) {
    console.log("[test:e2e] still running; sending SIGKILL…");
    killTree(existing.pid, "SIGKILL");
    await waitForExit(existing.pid, 2_000);
  }

  await rm(PIDFILE_PATH, { force: true });
}

async function statusOuter() {
  const existing = await readPidfile();
  if (!existing?.pid) {
    console.log("[test:e2e] not running (no pidfile).");
    process.exitCode = 1;
    return;
  }

  if (!isRunning(existing.pid)) {
    console.log(
      `[test:e2e] not running (stale pidfile pid=${existing.pid}).`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[test:e2e] running pid=${existing.pid} variant=${existing.variant ?? "unknown"} startedAt=${existing.startedAt ?? "unknown"}`
  );
}

const [command, ...rest] = process.argv.slice(2);

if (process.env[INNER_FLAG] === "1") {
  await runInner();
} else if (command === "run") {
  const [maybeVariant, ...rawArgs] = rest;
  const isVariant =
    typeof maybeVariant === "string" &&
    KNOWN_VARIANTS.includes(maybeVariant.trim().toLowerCase());
  const variant = isVariant ? maybeVariant : "core";
  const args = isVariant ? rawArgs : rest;
  await runOuter(variant, args);
} else if (command === "stop") {
  await stopOuter();
} else if (command === "status") {
  await statusOuter();
} else if (
  command === "help" ||
  command === "--help" ||
  command === "-h" ||
  command === undefined
) {
  printHelp();
} else {
  console.error(`[test:e2e] unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
