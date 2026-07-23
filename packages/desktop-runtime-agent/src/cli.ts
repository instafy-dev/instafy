#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { startDesktopRuntime } from "./index.js";
import {
  loadConfig,
  resolveProfile,
  saveConfig,
  setActiveProfile,
  clearStoredOriginToken,
  clearStoredControllerSession,
  isStoredTokenValid,
  type ProfileConfig,
  type CliConfig,
  type StoredOriginToken,
  type StoredControllerToken,
} from "./configStore.js";
import { mintOriginInternalToken } from "./originTokens.js";
import { mintControllerSessionToken } from "./controllerSession.js";
import {
  listCachedRatholeBinaries,
  purgeRatholeCache,
  DEFAULT_RATHOLE_CACHE_DIR,
} from "./rathole.js";

interface TokenOptions {
  controllerAccessToken?: string | null;
  controllerAccessTokenFile?: string | null;
  originToken?: string | null;
  supabaseAccessToken?: string | null;
  supabaseAccessTokenFile?: string | null;
}

interface ResolveRuntimeOptions {
  allowSupabaseMint: boolean;
  persistMintedToken: boolean;
}

interface ResolvedRuntimeInputs {
  config: CliConfig;
  profile: ProfileConfig;
  profileName: string;
  projectId: string;
  controllerUrl: string;
  controllerJwksUrl?: string;
  workspaceDir?: string;
  runtimeBinaryPath?: string;
  displayName?: string;
  agentKey?: string;
  ratholeBin?: string;
  ratholeVersion?: string;
  ratholeCacheDir?: string;
  ratholeStateDir?: string;
  controllerAccessToken: string | null;
  supabaseAccessToken: string | null;
  originToken: string | null;
  mintedOriginToken?: StoredOriginToken | null;
  mintedControllerToken?: StoredControllerToken | null;
  configDirty: boolean;
}

interface RuntimeState {
  pid: number;
  profile: string;
  projectId: string;
  controllerUrl: string;
  workspaceDir?: string;
  logFile?: string;
  startedAt: string;
}

const DEFAULT_CONTROLLER_URL = "http://127.0.0.1:8788";
const INSTAFY_DIR = path.join(os.homedir(), ".instafy");
const RUNTIME_STATE_FILE = path.join(INSTAFY_DIR, "desktop-runtime-state.json");
const RUNTIME_LOG_DIR = path.join(INSTAFY_DIR, "desktop-runtime-logs");
const DESKTOP_EVENTS_FILE = path.join(INSTAFY_DIR, "desktop-events.jsonl");
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const program = new Command();

function addSpaceIdOption(command: Command, description: string, includeShort = false) {
  if (includeShort) {
    command.option("-s, --space-id <uuid>", description);
    return command;
  }
  return command.option("--space-id <uuid>", description);
}

program
  .name("instafy-desktop")
  .description("Launch the Instafy desktop runtime agent (developer preview)")
  .option("--profile <name>", "Profile name to load (defaults to active profile)");

addSpaceIdOption(program, "Space ID (UUID)", true);

program
  .option("--controller-url <url>", "Controller base URL")
  .option("--controller-jwks-url <url>", "Controller JWKS URL")
  .option(
    "--controller-access-token <token>",
    "Controller access token used to mint runtime/origin credentials",
  )
  .option(
    "--controller-access-token-file <path>",
    "Path to a file that contains the controller access token",
  )
  .option("--workspace <path>", "Workspace root directory")
  .option("--runtime-binary <path>", "Path to runtime-agent binary")
  .option("--agent-key <key>", "Agent login key")
  .option("--display-name <name>", "Display name for the runtime")
  .option("--origin-token <token>", "Internal token used for origin/tunnel registration")
  .option(
    "--rathole-bin <path>",
    "Path to the rathole executable (recommended tunnel client)",
  )
  .option(
    "--rathole-version <tag>",
    "rathole release tag to download (defaults to latest)",
  )
  .option("--rathole-cache <path>", "Directory to cache downloaded rathole binaries")
  .option(
    "--rathole-state <path>",
    "Directory where rathole should store state/config",
  )
  .option(
    "--supabase-access-token <token>",
    "Supabase session token used to mint runtime/origin credentials",
  )
  .option(
    "--supabase-access-token-file <path>",
    "Path to a file that contains the Supabase session token",
  )
  .action(async (opts) => {
    appendDesktopEvent({
      type: "cli.start",
      profile: opts.profile ?? null,
      projectId: pickString(opts.spaceId as string | undefined) ?? null,
    });
    let resolved: ResolvedRuntimeInputs;
    try {
      resolved = await resolveRuntimeInputs(opts, {
        allowSupabaseMint: true,
        persistMintedToken: true,
      });
    } catch (error) {
      console.error(renderError(error));
      appendDesktopEvent({
        type: "cli.error",
        level: "error",
        message: renderError(error),
      });
      process.exitCode = 1;
      return;
    }

    if (!resolved.projectId) {
      console.error(
        "Space id is required. Configure it via --space-id or `instafy-desktop config set --space-id`.",
      );
      appendDesktopEvent({
        type: "cli.error",
        level: "error",
        message: "spaceId missing",
      });
      process.exitCode = 1;
      return;
    }

    if (!resolved.originToken && !resolved.controllerAccessToken) {
      console.error(
        "Unable to resolve desktop origin credentials. Provide --origin-token, --controller-access-token, or a Supabase session.",
      );
      appendDesktopEvent({
        type: "cli.error",
        level: "error",
        message: "origin token resolution failed",
      });
      process.exitCode = 1;
      return;
    }

    if (resolved.configDirty) {
      saveConfig(resolved.config);
    }

    if (resolved.mintedOriginToken) {
      console.log(
        `Minted desktop origin token via controller (profile: ${resolved.profileName}).`,
      );
      appendDesktopEvent({
        type: "token.origin.minted",
        profile: resolved.profileName,
        expiresAt: resolved.mintedOriginToken.expiresAt,
      });
    }

    if (resolved.mintedControllerToken) {
      appendDesktopEvent({
        type: "token.controller.minted",
        profile: resolved.profileName,
        expiresAt: resolved.mintedControllerToken.expiresAt,
      });
    }

    const logFile = createLogFile(resolved.profileName);
    appendDesktopEvent({
      type: "runtime.log.prepared",
      profile: resolved.profileName,
      path: logFile,
    });

    try {
      const handle = await startDesktopRuntime({
        projectId: resolved.projectId,
        controllerUrl: resolved.controllerUrl,
        controllerJwksUrl: resolved.controllerJwksUrl,
        controllerAccessToken: resolved.controllerAccessToken ?? undefined,
        workspaceDir: resolved.workspaceDir,
        runtimeBinaryPath: resolved.runtimeBinaryPath,
        agentLoginKey: resolved.agentKey,
        displayName: resolved.displayName,
        rathole: {
          version: resolved.ratholeVersion ?? undefined,
          cacheDir: resolved.ratholeCacheDir ?? undefined,
          logger: (message) => {
            console.log(`[instafy-desktop] ${message}`);
            appendDesktopEvent({
              type: "rathole",
              message,
            });
          },
        },
        origin: {
          internalToken: resolved.originToken ?? undefined,
          ratholeBin: resolved.ratholeBin ?? undefined,
          ratholeStateDir: resolved.ratholeStateDir ?? undefined,
        },
        logging: {
          logFilePath: logFile,
          teeToStdout: true,
        },
      });

      writeRuntimeState({
        pid: handle.pid,
        profile: resolved.profileName,
        projectId: resolved.projectId,
        controllerUrl: resolved.controllerUrl,
        workspaceDir: resolved.workspaceDir,
        logFile,
        startedAt: new Date().toISOString(),
      });

      console.log(
        `Desktop runtime started (pid ${handle.pid}). Logs: ${logFile}. Press Ctrl+C to stop.`,
      );
      appendDesktopEvent({
        type: "runtime.started",
        pid: handle.pid,
        profile: resolved.profileName,
        logFile,
      });

      handle.exited
        .finally(() => clearRuntimeState(handle.pid))
        .catch(() => {});

      const { code, signal } = await handle.exited;
      appendDesktopEvent({
        type: "runtime.exited",
        pid: handle.pid,
        code,
        signal: signal ?? null,
      });
      if (code !== null) {
        console.log(`Desktop runtime exited with code ${code}.`);
      } else {
        console.log(`Desktop runtime exited due to signal ${signal ?? "unknown"}.`);
      }
    } catch (error) {
      console.error(`Failed to start desktop runtime: ${renderError(error)}`);
      appendDesktopEvent({
        type: "runtime.error",
        level: "error",
        message: renderError(error),
      });
      process.exitCode = 1;
    }
  });

const doctorCommand = program
  .command("doctor")
  .description("Check controller connectivity and desktop runtime prerequisites.")
  .option("--profile <name>", "Profile name to load");

addSpaceIdOption(doctorCommand, "Space ID (UUID)", true);

doctorCommand
  .option("--controller-url <url>", "Controller base URL")
  .option("--controller-jwks-url <url>", "Controller JWKS URL")
  .option("--controller-access-token <token>", "Controller access token")
  .option("--controller-access-token-file <path>", "File containing controller access token")
  .option("--origin-token <token>", "Cached origin token to use")
  .option("--supabase-access-token <token>", "Supabase session token")
  .option("--supabase-access-token-file <path>", "File containing Supabase session token")
  .action(async (opts) => {
    let resolved: ResolvedRuntimeInputs;
    try {
      resolved = await resolveRuntimeInputs(opts, {
        allowSupabaseMint: false,
        persistMintedToken: false,
      });
    } catch (error) {
      console.error(renderError(error));
      process.exitCode = 1;
      return;
    }

    const lines: string[] = [];
    lines.push(`Profile: ${resolved.profileName}`);
    lines.push(`Space ID: ${resolved.projectId || "(missing)"}`);
    lines.push(`Controller URL: ${resolved.controllerUrl}`);
    lines.push(
      `Controller access token: ${resolved.controllerAccessToken ? "provided" : "missing"}`,
    );
    lines.push(
      `Supabase session: ${resolved.supabaseAccessToken ? "provided" : "missing"}`,
    );
    lines.push(
      `Origin credentials: ${
        resolved.originToken
          ? describeOriginToken(
              resolved.profile,
              !resolved.profile.originToken || !isStoredTokenValid(resolved.profile.originToken),
            )
          : "missing"
      }`,
    );

    const health = await checkControllerHealth(resolved.controllerUrl);
    lines.push(
      `Controller health: ${
        health.ok
          ? `ok (${health.status ?? "success"})`
          : `error (${health.message ?? "unreachable"})`
      }`,
    );

    const credentialsOk = Boolean(
      resolved.originToken || resolved.controllerAccessToken || resolved.supabaseAccessToken,
    );
    const projectOk = Boolean(resolved.projectId && UUID_REGEX.test(resolved.projectId));

    lines.forEach((line) => console.log(line));

    if (!projectOk || !credentialsOk || !health.ok) {
      console.error(
        "Doctor detected missing configuration. Fix the items above before launching instafy-desktop.",
      );
      process.exitCode = 1;
      return;
    }

    console.log("Doctor checks passed. You can launch instafy-desktop with the same arguments.");
  });

const configCommand = program.command("config").description("Manage instafy-desktop profiles");

configCommand
  .command("list")
  .description("List available profiles")
  .action(() => {
    const config = loadConfig();
    const names = Object.keys(config.profiles ?? {});
    if (names.length === 0) {
      console.log("No profiles configured. Use `instafy-desktop config set` to create one.");
      return;
    }
    names
      .sort()
      .forEach((name) => {
        const marker = name === config.activeProfile ? "*" : " ";
        console.log(`${marker} ${name}`);
      });
  });

configCommand
  .command("show")
  .description("Show configuration for a profile")
  .option("--profile <name>", "Profile name", undefined)
  .action((cmdOpts) => {
    const config = loadConfig();
    const { profile, name } = resolveProfile(config, cmdOpts.profile);
    const masked = maskProfileForDisplay(profile);
    console.log(`Profile: ${name}`);
    console.log(JSON.stringify(masked, null, 2));
  });

const configSetCommand = configCommand
  .command("set")
  .description("Update values in a profile")
  .option("--profile <name>", "Profile name", "default");

addSpaceIdOption(configSetCommand, "Space ID");

configSetCommand
  .option("--controller-url <url>", "Controller base URL")
  .option("--controller-jwks-url <url>", "Controller JWKS URL")
  .option("--workspace <path>", "Workspace directory")
  .option("--runtime-binary <path>", "Runtime agent binary path")
  .option("--display-name <name>", "Runtime display name")
  .option("--agent-key <key>", "Agent login key")
  .option("--rathole-bin <path>", "rathole binary path")
  .option("--rathole-cache <path>", "rathole cache directory")
  .option("--rathole-state <path>", "rathole state directory")
  .option("--rathole-version <tag>", "rathole version tag")
  .option("--controller-access-token <token>", "Controller access token")
  .option("--supabase-access-token <token>", "Supabase session token")
  .option("--clear-origin-token", "Remove cached origin token")
  .action((cmdOpts) => {
    const config = loadConfig();
    const { profile } = resolveProfile(config, cmdOpts.profile);

    assignProfileField(profile, "projectId", pickString(cmdOpts.spaceId));
    assignProfileField(profile, "controllerUrl", cmdOpts.controllerUrl);
    assignProfileField(profile, "controllerJwksUrl", cmdOpts.controllerJwksUrl);
    assignProfileField(profile, "workspaceDir", cmdOpts.workspace);
    assignProfileField(profile, "runtimeBinaryPath", cmdOpts.runtimeBinary);
    assignProfileField(profile, "displayName", cmdOpts.displayName);
    assignProfileField(profile, "agentKey", cmdOpts.agentKey);
    assignProfileField(profile, "ratholeBin", cmdOpts.ratholeBin);
    assignProfileField(profile, "ratholeCacheDir", cmdOpts.ratholeCache);
    assignProfileField(profile, "ratholeStateDir", cmdOpts.ratholeState);
    assignProfileField(profile, "ratholeVersion", cmdOpts.ratholeVersion);
    assignProfileField(profile, "controllerAccessToken", cmdOpts.controllerAccessToken);
    assignProfileField(profile, "supabaseAccessToken", cmdOpts.supabaseAccessToken);

    if (cmdOpts.clearOriginToken) {
      clearStoredOriginToken(profile);
    }

    saveConfig(config);
    console.log("Profile updated.");
  });

configCommand
  .command("use")
  .description("Set the active profile")
  .argument("<name>", "Profile name")
  .action((name: string) => {
    const config = loadConfig();
    resolveProfile(config, name);
    setActiveProfile(config, name);
    saveConfig(config);
    console.log(`Active profile set to ${name}.`);
  });

program
  .command("status")
  .description("Show the status of the desktop runtime managed by this CLI")
  .option("--json", "Emit JSON output")
  .action((cmdOpts) => {
    const state = loadRuntimeState();
    const running = state ? isPidRunning(state.pid) : false;
    const payload = state
      ? {
          running,
          pid: state.pid,
          profile: state.profile,
          projectId: state.projectId,
          controllerUrl: state.controllerUrl,
          workspaceDir: state.workspaceDir ?? null,
          logFile: state.logFile ?? null,
          startedAt: state.startedAt,
        }
      : { running: false };

    if (cmdOpts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (!state) {
      console.log("No desktop runtime is currently registered with this CLI.");
      return;
    }

    console.log(`Runtime PID: ${state.pid}${running ? " (running)" : " (stale)"}`);
    console.log(`Profile: ${state.profile}`);
    console.log(`Space ID: ${state.projectId}`);
    console.log(`Controller URL: ${state.controllerUrl}`);
    console.log(`Workspace: ${state.workspaceDir ?? "(default)"}`);
    console.log(`Log file: ${state.logFile ?? "(not captured)"}`);

    if (!running) {
      console.log(
        "The recorded runtime process is no longer running. Use `instafy-desktop start` to launch a new instance or `instafy-desktop stop --force` to clear the stale record.",
      );
    }
  });

program
  .command("stop")
  .description("Stop the desktop runtime process that was launched via this CLI")
  .option("--force", "Send SIGKILL if the runtime fails to stop gracefully")
  .action(async (cmdOpts) => {
    const state = loadRuntimeState();
    if (!state) {
      console.log("No desktop runtime is currently registered with this CLI.");
      return;
    }

    if (!isPidRunning(state.pid)) {
      console.log("Runtime process is not running. Cleaning up stale state file.");
      clearRuntimeState(state.pid);
      return;
    }

    try {
      process.kill(state.pid, "SIGINT");
      const stopped = await waitForProcessExit(state.pid, 5000);
      if (!stopped && cmdOpts.force) {
        console.log("Runtime did not exit after SIGINT. Sending SIGKILL…");
        try {
          process.kill(state.pid, "SIGKILL");
          await waitForProcessExit(state.pid, 2000);
        } catch (killError) {
          console.error(`Failed to force kill runtime: ${renderError(killError)}`);
        }
      } else if (!stopped) {
        console.log(
          "Runtime is still shutting down. Re-run with --force or manually terminate the process if it hangs.",
        );
        return;
      }

      clearRuntimeState(state.pid);
      console.log("Desktop runtime stopped.");
    } catch (error) {
      console.error(`Failed to stop runtime: ${renderError(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("logs")
  .description("Print or follow the desktop runtime logs captured by this CLI")
  .option("--follow", "Stream log output until interrupted")
  .action(async (cmdOpts) => {
    const state = loadRuntimeState();
    const logFile = state?.logFile;

    if (!logFile) {
      console.log(
        "No log file recorded yet. Launch the runtime via `instafy-desktop` to capture logs.",
      );
      return;
    }

    if (!fs.existsSync(logFile)) {
      console.log(`Recorded log file does not exist at ${logFile}.`);
      return;
    }

    console.log(`Log file: ${logFile}`);
    await streamLogFile(logFile, Boolean(cmdOpts.follow));
  });

const ratholeCommand = program
  .command("rathole")
  .description("Manage cached rathole binaries");

ratholeCommand
  .command("list")
  .description("List cached binaries")
  .option("--cache <path>", "Cache directory (defaults to ~/.instafy/rathole)")
  .option("--json", "Emit JSON output")
  .action(async (cmdOpts) => {
    const cacheDir = cmdOpts.cache ?? DEFAULT_RATHOLE_CACHE_DIR;
    const entries = await listCachedRatholeBinaries({ cacheDir });
    if (cmdOpts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log(`No cached rathole binaries found in ${cacheDir}.`);
      return;
    }
    console.log(`Cached rathole binaries (${cacheDir}):`);
    entries.forEach((entry) => {
      console.log(
        `- ${entry.version} (${entry.binaryPath}) – ${formatBytes(entry.size)}, modified ${entry.modifiedAt}`,
      );
    });
  });

ratholeCommand
  .command("purge")
  .description("Delete cached binaries")
  .option("--cache <path>", "Cache directory")
  .option("--version <tag>", "Version to delete (defaults to all)")
  .action(async (cmdOpts) => {
    const removed = await purgeRatholeCache({
      cacheDir: cmdOpts.cache,
      version: cmdOpts.version,
    });
    if (removed === 0) {
      console.log("No cached rathole binaries were removed.");
    } else {
      console.log(`Removed ${removed} cached ${removed === 1 ? "entry" : "entries"}.`);
    }
  });

ratholeCommand
  .command("doctor")
  .description("Validate the resolved rathole binary")
  .option("--profile <name>", "Profile to read defaults from")
  .option("--bin <path>", "Explicit path to the rathole executable")
  .option("--cache <path>", "Cache directory to inspect")
  .option("--version <tag>", "Preferred version when selecting from cache")
  .action(async (cmdOpts) => {
    const config = loadConfig();
    const { profile, name } = resolveProfile(config, cmdOpts.profile);
    const cacheDir =
      cmdOpts.cache ?? profile.ratholeCacheDir ?? DEFAULT_RATHOLE_CACHE_DIR;
    const preferredVersion = pickString(
      cmdOpts.version as string | undefined,
      profile.ratholeVersion,
      process.env.RATHOLE_VERSION,
    );

    let candidate = pickString(
      cmdOpts.bin as string | undefined,
      profile.ratholeBin,
      process.env.RATHOLE_BIN,
    );

    if (!candidate) {
      const entries = await listCachedRatholeBinaries({ cacheDir });
      const match =
        (preferredVersion &&
          entries.find((entry) => entry.version === preferredVersion)) ??
        entries.at(-1);
      candidate = match?.binaryPath ?? null;
    }

    if (!candidate) {
      console.log(
        `No rathole binary found for profile ${name}. Run \`instafy-desktop\` to download it automatically.`,
      );
      return;
    }

    const resolvedPath = path.resolve(candidate);
    if (!fs.existsSync(resolvedPath)) {
      console.log(`rathole binary not found at ${resolvedPath}.`);
      return;
    }

    const versionResult = spawnSync(resolvedPath, ["--version"], { encoding: "utf8" });
    if (versionResult.error) {
      console.error(
        `Failed to execute rathole (${resolvedPath}): ${versionResult.error.message}`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`rathole path: ${resolvedPath}`);
    console.log(`rathole output:\n${versionResult.stdout.trim() || "(no output)"}`);
  });

program
  .command("events")
  .description("Inspect structured CLI/runtime events")
  .option("--follow", "Stream events as they arrive")
  .option("--json", "Emit raw JSON lines")
  .action(async (cmdOpts) => {
    if (!fs.existsSync(DESKTOP_EVENTS_FILE)) {
      console.log("No events recorded yet.");
      return;
    }

    if (cmdOpts.json || cmdOpts.follow) {
      await streamLogFile(DESKTOP_EVENTS_FILE, Boolean(cmdOpts.follow));
      return;
    }

    const events = await readEventLog(DESKTOP_EVENTS_FILE);
    if (events.length === 0) {
      console.log("Event log is empty.");
      return;
    }
    events.forEach((event) => console.log(formatEventRecord(event)));
  });

program.parseAsync().catch((error) => {
  console.error(`[instafy-desktop] Unhandled error: ${renderError(error)}`);
  process.exitCode = 1;
});

function readTokenFromFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  const contents = fs.readFileSync(resolved, "utf8").trim();
  if (!contents) {
    throw new Error(`token file ${resolved} was empty`);
  }
  return contents;
}

function resolveSupabaseAccessToken(
  options: TokenOptions,
  profile: ProfileConfig,
): string | null {
  if (options.supabaseAccessToken && options.supabaseAccessToken.trim().length > 0) {
    return options.supabaseAccessToken.trim();
  }
  if (options.supabaseAccessTokenFile) {
    return readTokenFromFile(options.supabaseAccessTokenFile);
  }
  if (process.env.SUPABASE_ACCESS_TOKEN?.trim()) {
    return process.env.SUPABASE_ACCESS_TOKEN.trim();
  }
  if (profile.supabaseAccessToken?.trim()) {
    return profile.supabaseAccessToken.trim();
  }
  return null;
}

function resolveControllerAccessToken(
  options: TokenOptions,
  profile: ProfileConfig,
): string | null {
  if (options.controllerAccessToken && options.controllerAccessToken.trim()) {
    return options.controllerAccessToken.trim();
  }
  if (options.controllerAccessTokenFile) {
    return readTokenFromFile(options.controllerAccessTokenFile);
  }
  if (process.env.CONTROLLER_ACCESS_TOKEN?.trim()) {
    return process.env.CONTROLLER_ACCESS_TOKEN.trim();
  }
  if (profile.controllerAccessToken?.trim()) {
    return profile.controllerAccessToken.trim();
  }
  return null;
}

function resolveOriginTokenFromOptions(
  options: TokenOptions,
  profile: ProfileConfig,
): string | null {
  if (options.originToken && options.originToken.trim()) {
    return options.originToken.trim();
  }
  if (process.env.ORIGIN_INTERNAL_TOKEN?.trim()) {
    return process.env.ORIGIN_INTERNAL_TOKEN.trim();
  }
  if (profile.originToken && isStoredTokenValid(profile.originToken)) {
    return profile.originToken.token;
  }
  return null;
}

function pickString(
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function assignProfileField(
  profile: ProfileConfig,
  key: keyof ProfileConfig,
  value: string | undefined,
) {
  if (typeof value === "undefined") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    delete profile[key];
  } else {
    profile[key] = trimmed;
  }
}

function maskSecret(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  const start = value.slice(0, 2);
  const end = value.slice(-2);
  return `${start}…${end}`;
}

function maskProfileForDisplay(profile: ProfileConfig) {
  return {
    spaceId: profile.projectId ?? null,
    controllerUrl: profile.controllerUrl ?? null,
    controllerJwksUrl: profile.controllerJwksUrl ?? null,
    workspaceDir: profile.workspaceDir ?? null,
    runtimeBinaryPath: profile.runtimeBinaryPath ?? null,
    displayName: profile.displayName ?? null,
    agentKey: profile.agentKey ?? null,
    ratholeBin: profile.ratholeBin ?? null,
    ratholeCacheDir: profile.ratholeCacheDir ?? null,
    ratholeStateDir: profile.ratholeStateDir ?? null,
    ratholeVersion: profile.ratholeVersion ?? null,
    controllerAccessToken: profile.controllerAccessToken
      ? maskSecret(profile.controllerAccessToken)
      : null,
    supabaseAccessToken: profile.supabaseAccessToken
      ? maskSecret(profile.supabaseAccessToken)
      : null,
    originToken: profile.originToken
      ? {
          expiresAt: profile.originToken.expiresAt,
          token: maskSecret(profile.originToken.token),
        }
      : null,
  };
}

async function resolveRuntimeInputs(
  opts: Record<string, unknown> & TokenOptions,
  options: ResolveRuntimeOptions,
): Promise<ResolvedRuntimeInputs> {
  const config = loadConfig();
  const { profile, name } = resolveProfile(config, opts.profile as string | undefined);

  const projectId =
    pickString(
      opts.spaceId as string | undefined,
      process.env.SPACE_ID,
      profile.projectId,
    ) ??
    "";
  const controllerUrl =
    pickString(
      opts.controllerUrl as string | undefined,
      process.env.CONTROLLER_BASE_URL,
      profile.controllerUrl,
    ) ?? DEFAULT_CONTROLLER_URL;
  const controllerJwksUrl = pickString(
    opts.controllerJwksUrl as string | undefined,
    process.env.CONTROLLER_JWKS_URL,
    profile.controllerJwksUrl,
  );
  const workspaceDir = pickString(
    opts.workspace as string | undefined,
    process.env.WORKSPACE_DIR,
    profile.workspaceDir,
  );
  const runtimeBinaryPath = pickString(
    opts.runtimeBinary as string | undefined,
    process.env.INSTAFY_RUNTIME_AGENT_BIN,
    profile.runtimeBinaryPath,
  );
  const displayName = pickString(
    opts.displayName as string | undefined,
    process.env.RUNTIME_DISPLAY_NAME,
    profile.displayName,
  );
  const agentKey = pickString(
    opts.agentKey as string | undefined,
    process.env.AGENT_LOGIN_KEY,
    profile.agentKey,
  );

  let configDirty = false;

  let controllerAccessToken = resolveControllerAccessToken(opts, profile);
  const supabaseAccessToken = resolveSupabaseAccessToken(opts, profile);

  if (
    !controllerAccessToken &&
    profile.controllerSession &&
    !isStoredTokenValid(profile.controllerSession)
  ) {
    clearStoredControllerSession(profile);
    configDirty = true;
  }

  if (
    !controllerAccessToken &&
    profile.controllerSession &&
    isStoredTokenValid(profile.controllerSession)
  ) {
    controllerAccessToken = profile.controllerSession.token;
  }

  let originToken = resolveOriginTokenFromOptions(opts, profile);
  if (profile.originToken && !isStoredTokenValid(profile.originToken)) {
    clearStoredOriginToken(profile);
    configDirty = true;
    if (!originToken) {
      originToken = null;
    }
  }

  let mintedOriginToken: StoredOriginToken | null = null;
  let mintedControllerToken: StoredControllerToken | null = null;

  if (
    !originToken &&
    options.allowSupabaseMint &&
    supabaseAccessToken &&
    projectId
  ) {
    const minted = await mintOriginInternalToken({
      controllerUrl,
      projectId,
      supabaseAccessToken,
      runtimeDisplayName: displayName ?? undefined,
    });
    mintedOriginToken = { token: minted.token, expiresAt: minted.expiresAt };
    originToken = minted.token;
    if (options.persistMintedToken) {
      profile.originToken = mintedOriginToken;
      configDirty = true;
    }
  }

  if (
    !controllerAccessToken &&
    options.allowSupabaseMint &&
    supabaseAccessToken
  ) {
    const minted = await mintControllerSessionToken({
      controllerUrl,
      supabaseAccessToken,
    });
    mintedControllerToken = {
      token: minted.token,
      expiresAt: minted.expiresAt,
    };
    controllerAccessToken = minted.token;
    if (options.persistMintedToken) {
      profile.controllerSession = mintedControllerToken;
      configDirty = true;
    }
  }

  return {
    config,
    profile,
    profileName: name,
    projectId,
    controllerUrl,
    controllerJwksUrl,
    workspaceDir,
    runtimeBinaryPath,
    displayName,
    agentKey,
    ratholeBin: pickString(
      opts.ratholeBin as string | undefined,
      process.env.RATHOLE_BIN,
      profile.ratholeBin,
    ),
    ratholeVersion: pickString(
      opts.ratholeVersion as string | undefined,
      process.env.RATHOLE_VERSION,
      profile.ratholeVersion,
    ),
    ratholeCacheDir: pickString(
      opts.ratholeCache as string | undefined,
      process.env.RATHOLE_CACHE_DIR,
      profile.ratholeCacheDir,
    ),
    ratholeStateDir: pickString(
      opts.ratholeState as string | undefined,
      process.env.RATHOLE_STATE_DIR,
      profile.ratholeStateDir,
    ),
    controllerAccessToken,
    supabaseAccessToken,
    originToken,
    mintedOriginToken,
    mintedControllerToken,
    configDirty,
  };
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkControllerHealth(baseUrl: string): Promise<{
  ok: boolean;
  status?: number;
  message?: string;
}> {
  const trimmed = baseUrl.replace(/\/$/, "");
  const endpoints = ["/health", "/status", "/version"];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${trimmed}${endpoint}`);
      if (response.ok) {
        return { ok: true, status: response.status };
      }
      return {
        ok: false,
        status: response.status,
        message: `${endpoint} responded with ${response.status}`,
      };
    } catch (error) {
      // try next endpoint
      continue;
    }
  }
  return { ok: false, message: "unable to reach controller" };
}

function createLogFile(profile: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, "-");
  const logDir = RUNTIME_LOG_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `${safeProfile || "default"}-${timestamp}.log`);
}

function writeRuntimeState(state: RuntimeState) {
  fs.mkdirSync(path.dirname(RUNTIME_STATE_FILE), { recursive: true });
  fs.writeFileSync(RUNTIME_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function loadRuntimeState(): RuntimeState | null {
  try {
    const raw = fs.readFileSync(RUNTIME_STATE_FILE, "utf8");
    return JSON.parse(raw) as RuntimeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function clearRuntimeState(expectedPid?: number) {
  try {
    const existing = loadRuntimeState();
    if (expectedPid && existing && existing.pid !== expectedPid) {
      return;
    }
    fs.rmSync(RUNTIME_STATE_FILE, { force: true });
  } catch {
    // ignore
  }
}

function isPidRunning(pid: number): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !isPidRunning(pid);
}

async function streamLogFile(logFile: string, follow: boolean) {
  let position = 0;

  const pump = async () => {
    const stats = await fs.promises.stat(logFile);
    if (stats.size === position) {
      return;
    }
    const stream = fs.createReadStream(logFile, {
      encoding: "utf8",
      start: position,
      end: stats.size - 1,
    });
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(process.stdout, { end: false });
    });
    position = stats.size;
  };

  await pump();

  if (!follow) {
    return;
  }

  console.log("\nFollowing logs. Press Ctrl+C to exit.\n");
  await new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(logFile, async (eventType) => {
      if (eventType === "rename") {
        watcher.close();
        resolve();
        return;
      }
      try {
        await pump();
      } catch (error) {
        watcher.close();
        reject(error);
      }
    });
  });
}

function describeOriginToken(profile: ProfileConfig, providedExternally: boolean): string {
  if (profile.originToken && isStoredTokenValid(profile.originToken)) {
    return `cached (expires ${profile.originToken.expiresAt})`;
  }
  return providedExternally ? "provided via CLI/env" : "missing";
}

type DesktopEventRecord = Record<string, unknown> & {
  timestamp: string;
  type: string;
  level?: string;
  message?: string;
};

function appendDesktopEvent(event: Record<string, unknown>) {
  const record: DesktopEventRecord = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  try {
    fs.mkdirSync(path.dirname(DESKTOP_EVENTS_FILE), { recursive: true });
    fs.appendFileSync(DESKTOP_EVENTS_FILE, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // best effort only
  }
}

async function readEventLog(filePath: string): Promise<DesktopEventRecord[]> {
  const contents = await fs.promises.readFile(filePath, "utf8").catch(() => "");
  if (!contents.trim()) {
    return [];
  }
  const events: DesktopEventRecord[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as DesktopEventRecord;
      events.push(parsed);
    } catch {
      // ignore malformed lines
    }
  }
  return events;
}

function formatEventRecord(event: DesktopEventRecord): string {
  const base = `[${event.timestamp}] ${event.type}`;
  if (event.message && typeof event.message === "string") {
    return `${base} – ${event.message}`;
  }
  return base;
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size)) {
    return "unknown";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
