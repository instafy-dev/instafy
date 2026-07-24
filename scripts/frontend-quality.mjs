import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const warningBudget = Number.parseInt(process.env.FRONTEND_LINT_WARNING_BUDGET ?? "0", 10);
const lintJsonCommand = [
  "--filter",
  "@instafy/frontend",
  "exec",
  "eslint",
  "src/**/*.{ts,tsx}",
  "--format",
  "json",
];
const lintPrettyCommand = ["--filter", "@instafy/frontend", "lint"];
const appIconCheckCommand = ["check:app-icons"];
const frontendBuildCommand = ["--filter", "@instafy/frontend", "build"];
const frontendUnitCommand = ["--filter", "@instafy/frontend", "test:unit"];
const defaultRequiredE2eCommands = [
  ["test:e2e:component"],
  ["test:e2e:smoke:core"],
  ["test:e2e:projects"],
  ["test:e2e:orgs"],
];

function spawnPnpm(args, options = {}) {
  const { env: envOverrides, ...spawnOptions } = options;
  const mergedEnv = envOverrides ? { ...process.env, ...envOverrides } : process.env;
  return spawnSync("pnpm", args, {
    cwd: repoRoot,
    env: mergedEnv,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    ...spawnOptions,
  });
}

function runCommand(args, options = {}) {
  const result = spawnPnpm(args, { stdio: "inherit", ...options });
  const status = typeof result.status === "number" ? result.status : 1;
  if (status !== 0) {
    process.exit(status);
  }
}

function resolveRequiredE2eCommands() {
  const rawTargets = (process.env.FRONTEND_QUALITY_REQUIRED_TARGETS ?? "").trim();
  if (!rawTargets) {
    return defaultRequiredE2eCommands;
  }

  const knownCommands = new Map();
  for (const command of defaultRequiredE2eCommands) {
    const scriptName = command[0];
    knownCommands.set(scriptName, command);
    const shorthand = scriptName.replace(/^test:e2e:/, "").replace(/:/g, "-");
    knownCommands.set(shorthand, command);
  }
  const resolved = rawTargets
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const command = knownCommands.get(value) ?? knownCommands.get(`test:e2e:${value}`);
      if (!command) {
        console.error(
          `[frontend-quality] unknown required target "${value}". Expected one of: ${Array.from(new Set(defaultRequiredE2eCommands.map((command) => command[0]))).join(", ")}.`,
        );
        process.exit(1);
      }
      return command;
    });

  return resolved.length > 0 ? resolved : defaultRequiredE2eCommands;
}

function printLintDetails() {
  spawnPnpm(lintPrettyCommand, { stdio: "inherit" });
}

async function runFrontendLint() {
  const result = spawnPnpm(lintJsonCommand);
  const status = typeof result.status === "number" ? result.status : 1;

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const trimmedStdout = stdout.trim();
  const jsonStart = trimmedStdout.indexOf("[");
  const jsonEnd = trimmedStdout.lastIndexOf("]");
  const jsonPayload =
    jsonStart >= 0 && jsonEnd >= jsonStart
      ? trimmedStdout.slice(jsonStart, jsonEnd + 1)
      : trimmedStdout;
  let parsed;
  try {
    parsed = jsonPayload.length > 0 ? JSON.parse(jsonPayload) : [];
  } catch {
    if (typeof result.stderr === "string" && result.stderr.trim().length > 0) {
      process.stderr.write(result.stderr);
    }
    console.error("[frontend-quality] failed to parse eslint JSON output.");
    return 1;
  }

  const summary = parsed.reduce(
    (accumulator, fileResult) => {
      accumulator.errors +=
        (fileResult?.errorCount ?? 0) + (fileResult?.fatalErrorCount ?? 0);
      accumulator.warnings += fileResult?.warningCount ?? 0;
      return accumulator;
    },
    { errors: 0, warnings: 0 },
  );

  if (summary.errors > 0) {
    printLintDetails();
    console.error(`[frontend-quality] lint failed with ${summary.errors} error(s).`);
    return 1;
  }

  if (summary.warnings > warningBudget) {
    printLintDetails();
    console.error(
      `[frontend-quality] warning budget exceeded: ${summary.warnings}/${warningBudget} warnings.`,
    );
    return 1;
  }

  console.log(
    `[frontend-quality] lint budget OK: ${summary.warnings}/${warningBudget} warnings.`,
  );
  return status === 0 ? 0 : 1;
}

async function main() {
  const mode = (process.argv[2] ?? "lint").trim().toLowerCase();

  switch (mode) {
    case "lint": {
      process.exit(await runFrontendLint());
      break;
    }
    case "baseline": {
      const lintStatus = await runFrontendLint();
      if (lintStatus !== 0) {
        process.exit(lintStatus);
      }
      runCommand(appIconCheckCommand);
      runCommand(frontendBuildCommand);
      break;
    }
    case "required": {
      const lintStatus = await runFrontendLint();
      if (lintStatus !== 0) {
        process.exit(lintStatus);
      }
      runCommand(appIconCheckCommand);
      runCommand(frontendBuildCommand);
      runCommand(frontendUnitCommand);
      for (const command of resolveRequiredE2eCommands()) {
        runCommand(command, {
          env: {
            INSTAFY_TEST_E2E_SKIP_BUILD: "1",
          },
        });
      }
      break;
    }
    default:
      console.error(
        `Unknown frontend quality mode: ${mode}. Expected one of: lint, baseline, required.`,
      );
      process.exit(1);
  }
}

await main();
