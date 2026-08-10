import { Command, Option } from "commander";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import kleur from "kleur";
import {
  runtimeStart,
  runtimeStatus,
  runtimeStop,
  runtimeToken,
  mintRuntimeAccessToken,
  findProjectManifest,
} from "./runtime.js";
import { login, logout } from "./auth.js";
import { runGitCredentialHelper } from "./git-credential.js";
import { projectInit, projectProfile, refreshProjectDefaults } from "./project.js";
import { secretsGet, secretsList, secretsPut, secretsRevoke } from "./secrets.js";
import { automationsCreate, automationsDelete, automationsList, automationsRun, automationsUpdateStatus } from "./automations.js";
import { listTunnelSessions, startTunnelDetached, stopTunnelSession, tailTunnelLogs, runTunnelCommand } from "./tunnel.js";
import { requestControllerApi } from "./api.js";
import { configGet, configList, configPath, configSet, configUnset } from "./config-command.js";
import { getInstafyProfileConfigPath, listInstafyProfileNames, readInstafyProfileConfig } from "./config.js";
import { runInstafyGit, runInstafyGitSync } from "./git-wrapper.js";
import { historyConversations, historyMessages, historyRuns } from "./history.js";
import {
  grantHardwareBinding,
  revokeHardwareBinding,
  showHardwareBinding,
} from "./hardware-bindings.js";
import {
  agentContextPut,
  agentContextsList,
  agentJobsCancel,
  agentPlanGroupStatus,
  agentsList,
} from "./agents.js";
import { chatPrompt } from "./chat.js";
import {
  createConversation,
  listConversations,
  searchConversations,
  showConversation,
} from "./conversations.js";
import { inviteSpaceMember, setSpaceMemberRole } from "./invitations.js";
import {
  grantProviderBinding,
  revokeProviderBinding,
  showProviderBinding,
} from "./provider-bindings.js";
import {
  opsCreditsAdd,
  opsCreditsSet,
  opsCreditsStatus,
  opsProjectsSearch,
  opsRuntimesList,
  opsRuntimesStop,
} from "./ops.js";
import {
  activateOtaChannelCli,
  listDesktopPromotions,
  listOtaChannels,
  listOtaReleases,
  registerOtaRelease,
  requestDesktopPromotionCli,
  rollbackOtaChannelCli,
} from "./ota.js";
import {
  providersDiscover,
  providersList,
  providersProbe,
  providersRead,
} from "./providers.js";

export const program = new Command();
program.showSuggestionAfterError();

// Group commands used to respond to both a bare invocation and an unknown
// subcommand by printing help to stdout and exiting 0 -- scripts and agents
// read that as "command succeeded". A group invoked without a valid
// subcommand has not done anything; say so on stderr and fail.
function failWithGroupHelp(command: Command) {
  command.action(() => {
    const extra = command.args.filter((value) => typeof value === "string" && value.length > 0);
    if (extra.length > 0) {
      console.error(`error: unknown command '${extra[0]}' for 'instafy ${command.name()}'`);
    }
    command.outputHelp({ error: true });
    process.exitCode = 1;
  });
}

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

function addServerUrlOptions(command: Command) {
  return command
    .option(
      "--server-url <url>",
      "Instafy server URL (default: INSTAFY_SERVER_URL env, then the URL saved by `instafy login`, then http://127.0.0.1:8788; hosted: https://controller.instafy.dev)",
    )
    .addOption(new Option("--controller-url <url>").hideHelp());
}

function addAccessTokenOptions(command: Command, description: string) {
  return command
    .option("--access-token <token>", description)
    .addOption(new Option("--controller-access-token <token>").hideHelp());
}

function addServiceTokenOptions(command: Command, description: string) {
  return command
    .option("--service-token <token>", description)
    .addOption(new Option("--controller-token <token>").hideHelp());
}

function pickTrimmedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function collectStrings(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

function addSpaceOption(command: Command, description: string) {
  return command.option("--space <id>", description);
}

function addSpaceTypeOption(command: Command, description: string) {
  return command.option("--space-type <type>", description);
}

function addTeamIdOption(command: Command, description: string) {
  return command
    .option("--team-id <uuid>", description)
    .addOption(new Option("--org-id <uuid>").hideHelp());
}

function addTeamNameOption(command: Command, description: string) {
  return command
    .option("--team-name <name>", description)
    .addOption(new Option("--org-name <name>").hideHelp());
}

function addTeamSlugOption(command: Command, description: string) {
  return command
    .option("--team-slug <slug>", description)
    .addOption(new Option("--org-slug <slug>").hideHelp());
}

function resolveSpaceIdOption(opts: { space?: unknown }): string | undefined {
  return pickTrimmedString(opts.space);
}

function resolveSpaceTypeOption(opts: { spaceType?: unknown }): string | undefined {
  return pickTrimmedString(opts.spaceType);
}

function resolveTeamIdOption(opts: { teamId?: unknown; orgId?: unknown }): string | undefined {
  return pickTrimmedString(opts.teamId, opts.orgId);
}

function resolveTeamNameOption(opts: { teamName?: unknown; orgName?: unknown }): string | undefined {
  return pickTrimmedString(opts.teamName, opts.orgName);
}

function resolveTeamSlugOption(opts: { teamSlug?: unknown; orgSlug?: unknown }): string | undefined {
  return pickTrimmedString(opts.teamSlug, opts.orgSlug);
}

function collectStringOption(value: string, previous: string[]) {
  return [...previous, value];
}

function addProviderHostUrlOption(command: Command) {
  return command
    .option(
      "--provider-host-url <url>",
      "Local provider host base URL (default: INSTAFY_PROVIDER_HOST_URL or http://127.0.0.1:8789)",
    )
    .addOption(new Option("--local-provider-host-url <url>").hideHelp());
}

program
  .name("instafy")
  .description("Instafy CLI — run your space locally and connect to Studio")
  .version(pkg.version ?? "0.1.0");

program
  .command("login")
  .description("Log in and save an access token for future CLI commands")
  .option("--studio-url <url>", "Studio web URL (default: staging or localhost)")
  .option("--server-url <url>", "Instafy server/controller URL")
  .option("--profile <name>", "Save token under a named profile (multi-account support)")
  .option("--token <token>", "Provide token directly (skips prompt)")
  .option("--email <email>", "Email for non-interactive login (requires SUPABASE_URL + SUPABASE_ANON_KEY)")
  .option("--password <password>", "Password for non-interactive login (requires SUPABASE_URL + SUPABASE_ANON_KEY)")
  .option("--no-git-setup", "Do not configure git credential helper")
  .option("--no-store", "Do not save token to ~/.instafy/config.json")
  .option("--json", "Output JSON")
  .option(
    "--wait-for-browser",
    "Without a TTY, wait up to 10 minutes for the browser login callback instead of failing fast (for harnesses that drive the browser)",
  )
  .action(async (opts) => {
    try {
      await login({
        controllerUrl: opts.serverUrl,
        studioUrl: opts.studioUrl,
        waitForBrowser: opts.waitForBrowser,
        token: opts.token,
        email: opts.email,
        password: opts.password,
        gitSetup: opts.gitSetup,
        noStore: opts.store === false,
        profile: opts.profile,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Clear the saved CLI access token")
  .option("--profile <name>", "Clear the token for a named profile")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await logout({ json: opts.json, profile: opts.profile });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const chatCommand = program
  .command("chat")
  .description("Send a prompt to Instafy and optionally wait for the assistant reply")
  .argument("<prompt...>", "Prompt text")
  .option("--conversation <id>", "Conversation UUID to continue")
  .option("--intent <intent>", "Prompt intent (default: feature)")
  .option("--wait", "Wait for the assistant reply (default outside active runtime jobs)")
  .option("--no-wait", "Dispatch only; print conversation id (or JSON with ids)")
  .option("--timeout-ms <ms>", "Wait timeout in milliseconds (default: 120000)", Number.parseInt)
  .option("--poll-ms <ms>", "Polling interval in milliseconds (default: 1000)", Number.parseInt)
  .option("--accept-status-reply", "Treat assistant status messages as valid replies");

addSpaceOption(chatCommand, "Space UUID (defaults to .instafy/space.json or SPACE_ID)");
addServerUrlOptions(chatCommand);
addAccessTokenOptions(chatCommand, "Instafy access token");
addServiceTokenOptions(chatCommand, "Instafy service token (advanced)");

chatCommand
  .option("--json", "Output JSON")
  .action(async (promptParts, opts) => {
    try {
      await chatPrompt({
        prompt: Array.isArray(promptParts) ? promptParts.join(" ") : String(promptParts ?? ""),
        project: resolveSpaceIdOption(opts),
        conversation: opts.conversation,
        intent: opts.intent,
        wait: opts.wait,
        acceptStatusReply: opts.acceptStatusReply,
        timeoutMs: opts.timeoutMs,
        pollMs: opts.pollMs,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

function registerSpaceCommand(command: Command) {
  command.description("Create/link and manage Instafy spaces");
  failWithGroupHelp(command);

  const spaceInitCommand = command
    .command("init")
    .description("Create an Instafy space and link this folder (.instafy/space.json)")
    .option("--path <dir>", "Directory where the manifest should be written (default: cwd)");

  addServerUrlOptions(spaceInitCommand);

  addSpaceTypeOption(spaceInitCommand, "Space type (customer|sandbox)")
    .option("--access-token <token>", "Instafy or Supabase access token")
    .option("--profile <name>", "CLI profile to use when running commands in this folder")
    .option("--owner-user-id <uuid>", "Explicit owner user id (defaults to caller)")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        await projectInit({
          path: opts.path,
          controllerUrl: opts.serverUrl ?? opts.controllerUrl,
          accessToken: opts.accessToken,
          profile: opts.profile,
          projectType: resolveSpaceTypeOption(opts),
          orgId: resolveTeamIdOption(opts),
          orgName: resolveTeamNameOption(opts),
          orgSlug: resolveTeamSlugOption(opts),
          ownerUserId: opts.ownerUserId,
          json: opts.json,
        });
      } catch (error) {
        console.error(kleur.red(String(error)));
        process.exit(1);
      }
    });
  addTeamIdOption(spaceInitCommand, "Optional team id");
  addTeamNameOption(spaceInitCommand, "Optional team name");
  addTeamSlugOption(spaceInitCommand, "Optional team slug");

  command
    .command("profile")
    .description("Get/set the CLI profile for this folder (.instafy/space.json)")
    .argument("[profile]", "Profile name to set (omit to print current)")
    .option("--unset", "Clear the configured profile for this folder")
    .option("--path <dir>", "Directory to search for the manifest (default: cwd)")
    .option("--json", "Output JSON")
    .action(async (profile, opts) => {
      try {
        projectProfile({
          profile,
          unset: opts.unset,
          path: opts.path,
          json: opts.json,
        });
      } catch (error) {
        console.error(kleur.red(String(error)));
        process.exit(1);
      }
    });

  const providerBindingsCommand = command
    .command("provider-bindings")
    .description("Show, grant, or revoke project-scoped provider bindings");

  failWithGroupHelp(providerBindingsCommand);

  providerBindingsCommand
    .command("show")
    .description("Show provider bindings for the linked space")
    .argument("[provider-id]", "Provider id to inspect (omit to list all bindings)")
    .option("--path <dir>", "Directory to search for the linked space manifest (default: cwd)")
    .option("--json", "Output JSON")
    .action((providerId, opts) => {
      try {
        showProviderBinding({
          providerId,
          path: opts.path,
          json: opts.json,
        });
      } catch (error) {
        console.error(kleur.red(String(error)));
        process.exit(1);
      }
    });

  providerBindingsCommand
    .command("grant")
    .description("Grant a provider persistent access to the linked space")
    .argument("<provider-id>", "Provider id to bind")
    .option("--path <dir>", "Directory to search for the linked space manifest (default: cwd)")
    .option("--purpose <text>", "Human-readable reason for the binding")
    .option(
      "--prefix <path>",
      "Preferred provider-owned prefix (default: .instafy/providers/<provider-id>/)",
    )
    .option(
      "--capability <id>",
      "Grant capability (repeatable: project_content_read, project_content_write)",
      collectStrings,
      [],
    )
    .option("--json", "Output JSON")
    .action((providerId, opts) => {
      try {
        grantProviderBinding({
          providerId,
          path: opts.path,
          capabilities: opts.capability,
          prefix: opts.prefix,
          purpose: opts.purpose,
          json: opts.json,
        });
      } catch (error) {
        console.error(kleur.red(String(error)));
        process.exit(1);
      }
    });

  providerBindingsCommand
    .command("revoke")
    .description("Revoke a provider binding from the linked space")
    .argument("<provider-id>", "Provider id to revoke")
    .option("--path <dir>", "Directory to search for the linked space manifest (default: cwd)")
    .option("--json", "Output JSON")
    .action((providerId, opts) => {
      try {
        revokeProviderBinding({
          providerId,
          path: opts.path,
          json: opts.json,
        });
      } catch (error) {
        console.error(kleur.red(String(error)));
        process.exit(1);
      }
    });

  const spaceDefaultsCommand = command
    .command("defaults")
    .description("Refresh managed default skills/docs for a space");

  failWithGroupHelp(spaceDefaultsCommand);

  const spaceDefaultsRefreshCommand = spaceDefaultsCommand
    .command("refresh")
    .description("Refresh pinned default space memory into an existing space")
    .option("--path <dir>", "Directory to search for the linked space manifest (default: cwd)")
    .option("--json", "Output JSON");

  addSpaceOption(
    spaceDefaultsRefreshCommand,
    "Space UUID (defaults to linked .instafy/space.json)",
  );

  addServerUrlOptions(spaceDefaultsRefreshCommand);

  spaceDefaultsRefreshCommand
    .option("--access-token <token>", "Instafy or Supabase access token")
    .action(async (opts) => {
      try {
        await refreshProjectDefaults({
          project: resolveSpaceIdOption(opts),
          path: opts.path,
          controllerUrl: opts.serverUrl ?? opts.controllerUrl,
          accessToken: opts.accessToken,
          json: opts.json,
        });
      } catch (error) {
        console.error(kleur.red(String(error)));
        process.exit(1);
      }
    });

  const spaceListCommand = command
    .command("list")
    .description("List spaces for your account")
    .option("--access-token <token>", "Instafy or Supabase access token");
  addServerUrlOptions(spaceListCommand);

  spaceListCommand
    .option("--json", "Output JSON")
    .action(async (opts) => {
      try {
        await (await import("./project.js")).listProjects({
          controllerUrl: opts.serverUrl ?? opts.controllerUrl,
          accessToken: opts.accessToken,
          orgId: resolveTeamIdOption(opts),
          orgSlug: resolveTeamSlugOption(opts),
          json: opts.json,
        });
      } catch (error) {
        console.error(kleur.red(String(error)));
        process.exit(1);
      }
    });
  addTeamIdOption(spaceListCommand, "Filter by team id");
  addTeamSlugOption(spaceListCommand, "Filter by team slug");

  const spaceInviteCommand = command
    .command("invite")
    .description("Invite a teammate to the current space by email")
    .argument("<email>", "Email address to invite")
    .option("--path <dir>", "Directory to search for the linked space manifest (default: cwd)")
    .option("--role <role>", "Role to grant (default: builder)")
    .option("--json", "Output JSON");

  addSpaceOption(
    spaceInviteCommand,
    "Space UUID (defaults to linked .instafy/space.json)",
  );
  addServerUrlOptions(spaceInviteCommand);
  addAccessTokenOptions(spaceInviteCommand, "Instafy access token");
  addServiceTokenOptions(spaceInviteCommand, "Instafy service token (advanced)");

  spaceInviteCommand.action(async (email, opts) => {
    try {
      await inviteSpaceMember({
        email,
        role: opts.role,
        project: resolveSpaceIdOption(opts),
        orgId: resolveTeamIdOption(opts),
        path: opts.path,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });
  addTeamIdOption(spaceInviteCommand, "Explicit team id (skips manifest lookup)");

  const spaceRoleCommand = command
    .command("role")
    .description("Update a teammate role in the current space by email")
    .argument("<email>", "Email address to update")
    .argument("<role>", "Role to grant (viewer, builder, admin, owner)")
    .option("--path <dir>", "Directory to search for the linked space manifest (default: cwd)")
    .option("--json", "Output JSON");

  addSpaceOption(
    spaceRoleCommand,
    "Space UUID (defaults to linked .instafy/space.json)",
  );
  addServerUrlOptions(spaceRoleCommand);
  addAccessTokenOptions(spaceRoleCommand, "Instafy access token");
  addServiceTokenOptions(spaceRoleCommand, "Instafy service token (advanced)");

  spaceRoleCommand.action(async (email, role, opts) => {
    try {
      await setSpaceMemberRole({
        email,
        role,
        project: resolveSpaceIdOption(opts),
        orgId: resolveTeamIdOption(opts),
        path: opts.path,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });
  addTeamIdOption(spaceRoleCommand, "Explicit team id (skips manifest lookup)");

  return command;
}

registerSpaceCommand(program.command("space"));

const hardwareCommand = program
  .command("hardware")
  .description("Inspect local host hardware available to Instafy runtimes");

failWithGroupHelp(hardwareCommand);

const hardwareBindingsCommand = hardwareCommand
  .command("bindings")
  .description("Show, grant, or revoke project-scoped local hardware bindings");

failWithGroupHelp(hardwareBindingsCommand);

hardwareBindingsCommand
  .command("show")
  .description("Show hardware bindings for the linked space")
  .argument("[provider-id]", "Hardware provider id to inspect (omit to list all bindings)")
  .option("--path <dir>", "Directory to search for the linked space manifest (default: cwd)")
  .option("--json", "Output JSON")
  .action((providerId, opts) => {
    try {
      showHardwareBinding({
        providerId,
        path: opts.path,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

hardwareBindingsCommand
  .command("grant")
  .description("Grant a local hardware provider access for the linked space")
  .argument("<provider-id>", "Hardware provider id, for example hardware.serial")
  .option("--path <dir>", "Directory to search for the linked space manifest (default: cwd)")
  .option("--purpose <text>", "Human-readable reason for the binding")
  .option(
    "--capability <id>",
    "Grant capability (repeatable: hardware_serial_list, hardware_serial_probe)",
    collectStrings,
    [],
  )
  .option("--device <path>", "Grant access to one serial device path (repeatable)", collectStrings, [])
  .option("--json", "Output JSON")
  .action((providerId, opts) => {
    try {
      grantHardwareBinding({
        providerId,
        path: opts.path,
        purpose: opts.purpose,
        capabilities: opts.capability,
        devices: opts.device,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

hardwareBindingsCommand
  .command("revoke")
  .description("Revoke a local hardware binding from the linked space")
  .argument("<provider-id>", "Hardware provider id to revoke")
  .option("--path <dir>", "Directory to search for the linked space manifest (default: cwd)")
  .option("--json", "Output JSON")
  .action((providerId, opts) => {
    try {
      revokeHardwareBinding({
        providerId,
        path: opts.path,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const hardwareSerialCommand = hardwareCommand
  .command("serial")
  .description("Inspect local USB serial devices visible to this host");

failWithGroupHelp(hardwareSerialCommand);

hardwareSerialCommand
  .command("list")
  .description("List local serial devices visible to this host")
  .option("--json", "Output JSON")
  .option("--scan-dir <dir>", "Directory to scan for serial devices", collectStrings, [])
  .action(async (opts) => {
    try {
      const { hardwareSerialList } = await import("./hardware.js");
      hardwareSerialList({
        json: opts.json,
        scanDirs: opts.scanDir,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

hardwareSerialCommand
  .command("probe")
  .description("Probe host permissions for one serial device path without writing to it")
  .requiredOption("--device <path>", "Serial device path, for example /dev/cu.usbserial-130")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const { hardwareSerialProbe } = await import("./hardware.js");
      hardwareSerialProbe({
        device: opts.device,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

hardwareCommand
  .command("opportunities")
  .description("List host-local IO opportunities this runtime can perform")
  .option("--json", "Output JSON")
  .option("--scan-dir <dir>", "Directory to scan for serial devices", collectStrings, [])
  .action(async (opts) => {
    try {
      const { hardwareIoOpportunities } = await import("./hardware.js");
      hardwareIoOpportunities({
        json: opts.json,
        scanDirs: opts.scanDir,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

hardwareCommand
  .command("run")
  .description("Run one available host-local IO action")
  .argument("<action-id>", "Action id, for example serial.probe")
  .requiredOption("--device <path>", "Host-local serial device path")
  .option("--json", "Output JSON")
  .action(async (actionId, opts) => {
    try {
      const { hardwareIoRun } = await import("./hardware.js");
      hardwareIoRun({
        actionId,
        device: opts.device,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const providersCommand = program
  .command("providers")
  .description("Inspect local providers through the shared provider host surface");

failWithGroupHelp(providersCommand);

const providersListCommand = providersCommand
  .command("list")
  .description("List providers exposed by the local provider host");

addProviderHostUrlOption(providersListCommand);

providersListCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await providersList({
        providerHostUrl: opts.providerHostUrl ?? opts.localProviderHostUrl,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const providersDiscoverCommand = providersCommand
  .command("discover")
  .description("Run fresh provider discovery for one provider")
  .argument("<provider-id>", "Provider id");

addProviderHostUrlOption(providersDiscoverCommand);

providersDiscoverCommand
  .option("--json", "Output JSON")
  .action(async (providerId, opts) => {
    try {
      await providersDiscover({
        providerId,
        providerHostUrl: opts.providerHostUrl ?? opts.localProviderHostUrl,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const providersReadCommand = providersCommand
  .command("read")
  .description("Read one provider resource")
  .argument("<provider-id>", "Provider id")
  .argument("<uri>", "Resource URI");

addProviderHostUrlOption(providersReadCommand);

providersReadCommand
  .option("--json", "Output JSON")
  .action(async (providerId, uri, opts) => {
    try {
      await providersRead({
        providerId,
        uri,
        providerHostUrl: opts.providerHostUrl ?? opts.localProviderHostUrl,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const providersProbeCommand = providersCommand
  .command("probe")
  .description("Run a transport probe for one provider")
  .argument("<provider-id>", "Provider id")
  .option("--backend <backend>", "Transport backend override")
  .option("--tcp-target <target>", "Transport tcp target override")
  .option("--session-id <id>", "Session id for the probe")
  .option("--source <source>", "Source label for the probe")
  .option("--timeout-ms <ms>", "Probe timeout in milliseconds", Number.parseInt)
  .option("--read-status", "Request status read during probe", true)
  .option("--no-read-status", "Do not request status read during probe")
  .option("--drain-pending", "Drain pending events during probe", true)
  .option("--no-drain-pending", "Do not drain pending events during probe")
  .option("--skip-command", "Skip sending a command during the probe")
  .option("--command-json <json>", "Optional command envelope JSON to send");

addProviderHostUrlOption(providersProbeCommand);

providersProbeCommand
  .option("--json", "Output JSON")
  .action(async (providerId, opts) => {
    try {
      await providersProbe({
        providerId,
        backend: opts.backend,
        tcpTarget: opts.tcpTarget,
        sessionId: opts.sessionId,
        source: opts.source,
        timeoutMs: opts.timeoutMs,
        readStatus: opts.readStatus,
        drainPending: opts.drainPending,
        skipCommand: opts.skipCommand,
        commandJson: opts.commandJson,
        providerHostUrl: opts.providerHostUrl ?? opts.localProviderHostUrl,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const agentsCommand = program
  .command("agents")
  .description("Inspect agents and scoped agent context");

failWithGroupHelp(agentsCommand);

const agentsListCommand = agentsCommand
  .command("list")
  .description("List agents available to this account");

addSpaceOption(
  agentsListCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);
addServerUrlOptions(agentsListCommand);
addAccessTokenOptions(agentsListCommand, "Instafy access token");
addServiceTokenOptions(agentsListCommand, "Instafy service token (advanced)");

agentsListCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await agentsList({
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const agentsContextCommand = agentsCommand
  .command("context")
  .description("Inspect and update compact scoped context cards");

failWithGroupHelp(agentsContextCommand);

const agentsContextListCommand = agentsContextCommand
  .command("list")
  .description("List compact scoped context cards");

addSpaceOption(
  agentsContextListCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);
addServerUrlOptions(agentsContextListCommand);
addAccessTokenOptions(agentsContextListCommand, "Instafy access token");
addServiceTokenOptions(agentsContextListCommand, "Instafy service token (advanced)");

agentsContextListCommand
  .option("--agent <handle>", "Filter by agent handle (for example @octo)")
  .option("--agent-id <uuid>", "Filter by agent id")
  .option("--scope-kind <kind>", "Filter by scope kind (for example conversation)")
  .option("--scope-id <id>", "Filter by scope id")
  .option("--query <text>", "Search context text/title/agent label")
  .option("--limit <n>", "Max context cards to return (1-200, default: 50)", Number.parseInt)
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await agentContextsList({
        project: resolveSpaceIdOption(opts),
        agent: opts.agent,
        agentId: opts.agentId,
        scopeKind: opts.scopeKind,
        scopeId: opts.scopeId,
        query: opts.query,
        limit: opts.limit,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const agentsContextPutCommand = agentsContextCommand
  .command("put")
  .description("Create or update one compact scoped context card")
  .argument("<context...>", "Compact context summary text")
  .option("--agent <handle>", "Agent handle (for example @octo)")
  .option("--agent-id <uuid>", "Agent id")
  .option("--scope-kind <kind>", "Scope kind (default: conversation)")
  .option("--scope-id <id>", "Scope id (defaults to INSTAFY_CONVERSATION_ID for conversation scope)")
  .option("--title <text>", "Optional short label")
  .option("--json", "Output JSON");

addSpaceOption(
  agentsContextPutCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);
addServerUrlOptions(agentsContextPutCommand);
addAccessTokenOptions(agentsContextPutCommand, "Instafy access token");
addServiceTokenOptions(agentsContextPutCommand, "Instafy service token (advanced)");

agentsContextPutCommand.action(async (contextParts, opts) => {
  try {
    await agentContextPut({
      project: resolveSpaceIdOption(opts),
      agent: opts.agent,
      agentId: opts.agentId,
      scopeKind: opts.scopeKind,
      scopeId: opts.scopeId,
      title: opts.title,
      context: Array.isArray(contextParts) ? contextParts.join(" ") : String(contextParts ?? ""),
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const agentsStatusCommand = agentsCommand
  .command("status")
  .description("Show live status for one multi-agent plan group")
  .argument("<group-id>", "Plan group id (from multiAgentPlan metadata)");

addServerUrlOptions(agentsStatusCommand);
addAccessTokenOptions(agentsStatusCommand, "Instafy access token");
addServiceTokenOptions(agentsStatusCommand, "Instafy service token (advanced)");

agentsStatusCommand
  .option("--json", "Output JSON")
  .action(async (groupId, opts) => {
    try {
      await agentPlanGroupStatus({
        groupId,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const agentsCancelCommand = agentsCommand
  .command("cancel")
  .description("Cancel one agent job or a whole multi-agent plan group")
  .option("--group <groupId>", "Plan group id to cancel")
  .option("--job <jobId>", "Job id to cancel")
  .option("--reason <text>", "Optional cancellation reason");

addServerUrlOptions(agentsCancelCommand);
addAccessTokenOptions(agentsCancelCommand, "Instafy access token");
addServiceTokenOptions(agentsCancelCommand, "Instafy service token (advanced)");

agentsCancelCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await agentJobsCancel({
        group: opts.group,
        job: opts.job,
        reason: opts.reason,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const secretsCommand = program
  .command("secrets")
  .description("Manage space secrets");

failWithGroupHelp(secretsCommand);

const secretsListCommand = secretsCommand
  .command("list")
  .description("List secret metadata (names/descriptions; values are never shown)");

addSpaceOption(
  secretsListCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);

addServerUrlOptions(secretsListCommand);
addAccessTokenOptions(secretsListCommand, "Instafy access token");
addServiceTokenOptions(secretsListCommand, "Instafy service token (advanced)");

secretsListCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await secretsList({
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken:
          opts.accessToken ??
          opts.controllerAccessToken ??
          opts.serviceToken ??
          opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const secretsGetCommand = secretsCommand
  .command("get")
  .description("Get metadata for one secret by name or id")
  .argument("<name-or-id>", "Secret name or UUID");

addSpaceOption(
  secretsGetCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);

addServerUrlOptions(secretsGetCommand);
addAccessTokenOptions(secretsGetCommand, "Instafy access token");
addServiceTokenOptions(secretsGetCommand, "Instafy service token (advanced)");

secretsGetCommand
  .option("--json", "Output JSON")
  .action(async (nameOrId, opts) => {
    try {
      await secretsGet({
        nameOrId,
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken:
          opts.accessToken ??
          opts.controllerAccessToken ??
          opts.serviceToken ??
          opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const secretsPutCommand = secretsCommand
  .command("put")
  .description("Create/update a space secret")
  .argument("<name>", "Secret env var name (for example GITHUB_TOKEN)")
  .option("--value <value>", "Secret value")
  .option("--value-stdin", "Read secret value from stdin")
  .option("--description <text>", "Human-readable description")
  .option("--agent-handle <handle>", "Grant to agent handle (repeatable)", collectStringOption, []);

addSpaceOption(
  secretsPutCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);

addServerUrlOptions(secretsPutCommand);
addAccessTokenOptions(secretsPutCommand, "Instafy access token");
addServiceTokenOptions(secretsPutCommand, "Instafy service token (advanced)");

secretsPutCommand
  .option("--json", "Output JSON")
  .action(async (name, opts) => {
    try {
      await secretsPut({
        name,
        value: opts.value,
        valueStdin: opts.valueStdin,
        description: opts.description,
        agentHandles: opts.agentHandle,
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken:
          opts.accessToken ??
          opts.controllerAccessToken ??
          opts.serviceToken ??
          opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const secretsRevokeCommand = secretsCommand
  .command("revoke")
  .description("Revoke (delete) a secret by name or id")
  .argument("<name-or-id>", "Secret name or UUID");

addSpaceOption(
  secretsRevokeCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);

addServerUrlOptions(secretsRevokeCommand);
addAccessTokenOptions(secretsRevokeCommand, "Instafy access token");
addServiceTokenOptions(secretsRevokeCommand, "Instafy service token (advanced)");

secretsRevokeCommand
  .option("--json", "Output JSON")
  .action(async (nameOrId, opts) => {
    try {
      await secretsRevoke({
        nameOrId,
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken:
          opts.accessToken ??
          opts.controllerAccessToken ??
          opts.serviceToken ??
          opts.controllerToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const automationsCommand = program
  .command("automations")
  .description("Manage scheduled automations (run prompts on a schedule)");

failWithGroupHelp(automationsCommand);

const automationsListCommand = automationsCommand
  .command("list")
  .description("List automations for this space");

addSpaceOption(
  automationsListCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);

addServerUrlOptions(automationsListCommand);
addAccessTokenOptions(automationsListCommand, "Instafy access token");

automationsListCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await automationsList({
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const automationsCreateCommand = automationsCommand
  .command("create")
  .description("Create an automation")
  .requiredOption("--name <name>", "Automation name")
  .requiredOption("--prompt <text>", "Prompt to run on schedule")
  .option("--schedule-kind <kind>", "weekly|hourly|once (default: weekly)")
  .option("--run-at <datetime>", "Run time for once schedule (RFC3339 or YYYY-MM-DDTHH:MM[:SS])")
  .option("--interval-hours <n>", "Interval hours (hourly schedule)", (value) => Number(value))
  .option("--days <list>", "Weekdays for weekly schedule (e.g. mo,tu,we,th,fr)")
  .option("--time <hh:mm>", "Time for weekly schedule (24h, e.g. 09:00)")
  .option("--timezone <tz>", "IANA timezone (e.g. America/New_York)")
  .option("--runtime-mode <mode>", "auto|hosted|existing (default: auto)")
  .option("--runtime-provider <id>", "Runtime provider id (optional)")
  .option("--paused", "Create paused");

addSpaceOption(
  automationsCreateCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);

addServerUrlOptions(automationsCreateCommand);
addAccessTokenOptions(automationsCreateCommand, "Instafy access token");

automationsCreateCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await automationsCreate({
        name: opts.name,
        prompt: opts.prompt,
        scheduleKind: opts.scheduleKind,
        runAt: opts.runAt,
        intervalHours: opts.intervalHours,
        days: opts.days,
        time: opts.time,
        timezone: opts.timezone,
        runtimeMode: opts.runtimeMode,
        runtimeProvider: opts.runtimeProvider,
        paused: Boolean(opts.paused),
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const automationsPauseCommand = automationsCommand
  .command("pause")
  .description("Pause an automation")
  .argument("<automation-id>", "Automation UUID");

addServerUrlOptions(automationsPauseCommand);
addAccessTokenOptions(automationsPauseCommand, "Instafy access token");

automationsPauseCommand
  .option("--json", "Output JSON")
  .action(async (automationId, opts) => {
    try {
      await automationsUpdateStatus({
        automationId,
        status: "paused",
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const automationsResumeCommand = automationsCommand
  .command("resume")
  .description("Resume an automation")
  .argument("<automation-id>", "Automation UUID");

addServerUrlOptions(automationsResumeCommand);
addAccessTokenOptions(automationsResumeCommand, "Instafy access token");

automationsResumeCommand
  .option("--json", "Output JSON")
  .action(async (automationId, opts) => {
    try {
      await automationsUpdateStatus({
        automationId,
        status: "active",
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const automationsRunCommand = automationsCommand
  .command("run")
  .description("Run an automation now")
  .argument("<automation-id>", "Automation UUID");

addServerUrlOptions(automationsRunCommand);
addAccessTokenOptions(automationsRunCommand, "Instafy access token");

automationsRunCommand
  .option("--json", "Output JSON")
  .action(async (automationId, opts) => {
    try {
      await automationsRun({
        automationId,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const automationsDeleteCommand = automationsCommand
  .command("delete")
  .description("Delete an automation")
  .argument("<automation-id>", "Automation UUID");

addServerUrlOptions(automationsDeleteCommand);
addAccessTokenOptions(automationsDeleteCommand, "Instafy access token");

automationsDeleteCommand
  .option("--json", "Output JSON")
  .action(async (automationId, opts) => {
    try {
      await automationsDelete({
        automationId,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const configCommand = program.command("config").description("Get/set saved CLI configuration");

failWithGroupHelp(configCommand);

configCommand
  .command("path")
  .description("Print the config file path")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      configPath({ json: opts.json });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

configCommand
  .command("list")
  .description("List saved configuration")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      configList({ json: opts.json });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

configCommand
  .command("get")
  .description("Get a config value (controller-url, studio-url)")
  .argument("<key>", "Config key")
  .option("--json", "Output JSON")
  .action(async (key, opts) => {
    try {
      configGet({ key, json: opts.json });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

configCommand
  .command("set")
  .description("Set a config value (controller-url, studio-url)")
  .argument("<key>", "Config key")
  .argument("<value>", "Config value")
  .option("--json", "Output JSON")
  .action(async (key, value, opts) => {
    try {
      configSet({ key, value, json: opts.json });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

configCommand
  .command("unset")
  .description("Unset a config value (controller-url, studio-url)")
  .argument("<key>", "Config key")
  .option("--json", "Output JSON")
  .action(async (key, opts) => {
    try {
      configUnset({ key, json: opts.json });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const runtimeCommand = program
  .command("runtime")
  .description("Start/stop the local Instafy runtime");

failWithGroupHelp(runtimeCommand);

const runtimeStartCommand = runtimeCommand
  .command("start")
  .description("Start a local runtime for this space");

addSpaceOption(runtimeStartCommand, "Space UUID");

addServerUrlOptions(runtimeStartCommand);
addServiceTokenOptions(runtimeStartCommand, "Instafy service token (advanced)");
addAccessTokenOptions(runtimeStartCommand, "Instafy access token (from Studio)");

runtimeStartCommand
  .option("--supabase-access-token <token>", "Supabase session token (alternative to Studio token)")
  .option("--supabase-access-token-file <path>", "File containing the Supabase session token")
  .option("--runtime-token <token>", "Pre-minted runtime access token (bypasses agent key)")
  .option("--codex-bin <path>", "Path to codex binary (fallback to PATH)")
  .option("--proxy-base-url <url>", "Codex proxy base URL")
  .option("--workspace <path>", "Workspace directory (defaults to ./.instafy/workspace)")
  .option("--runtime-mode <mode>", "Runtime runner (auto|docker|process)", "auto")
  .option("--origin-id <uuid>", "Origin ID to use (auto-generated if omitted)")
  .option("--origin-endpoint <url>", "Explicit origin endpoint (skip tunnel setup when provided)")
  .option("--origin-token <token>", "Runtime/origin access token for Studio registration")
  .option("--runtime-id <uuid>", "Runtime ID to use (advanced)")
  .option("--runtime-lease-id <uuid>", "Runtime lease ID to use (advanced)")
  .option("--display-name <name>", "Human-friendly runtime name")
  .option("--provider <provider>", "Runtime provider label (default: self-hosted)")
  .option("--bind-host <host>", "Origin bind host (default 127.0.0.1)")
  .option("--bind-port <port>", "Origin bind port (default 54332)")
  .option("--detach", "Run runtime in background and exit immediately")
  .option("--log-file <path>", "Write runtime stdout/stderr to a file (implied when detached)")
  .action(async (opts) => {
    try {
      const space = resolveSpaceIdOption(opts);
      await runtimeStart({
        ...opts,
        project: space,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        controllerToken: opts.serviceToken ?? opts.controllerToken,
        controllerAccessToken: opts.accessToken ?? opts.controllerAccessToken,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

runtimeCommand
  .command("status")
  .description("Show runtime health")
  .option("--json", "Output status as JSON")
  .action(async (opts) => {
    try {
      await runtimeStatus({ json: opts.json });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

runtimeCommand
  .command("stop")
  .description("Stop the local Instafy runtime")
  .option("--json", "Output result as JSON")
  .action(async (opts) => {
    try {
      await runtimeStop({ json: opts.json });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const runtimeTokenCommand = runtimeCommand
  .command("token")
  .description("Mint a runtime access token");

addSpaceOption(
  runtimeTokenCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);

addServerUrlOptions(runtimeTokenCommand);
addAccessTokenOptions(runtimeTokenCommand, "Instafy access token (required)");

runtimeTokenCommand
  .option("--runtime-id <uuid>", "Runtime ID to bind token to")
  .option("--scope <scope...>", "Override scopes (default agent.* + origin.*)")
  .option("--json", "Output token as JSON")
  .action(async (opts) => {
    try {
      const project =
        resolveSpaceIdOption(opts)
          ? resolveSpaceIdOption(opts)
          : findProjectManifest(process.cwd()).manifest?.spaceId ?? null;
      if (!project) {
        throw new Error("No space configured. Run `instafy space init` or pass --space.");
      }
      await runtimeToken({
        project,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        controllerAccessToken: opts.accessToken ?? opts.controllerAccessToken,
        runtimeId: opts.runtimeId,
        scopes: opts.scope,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const opsCommand = program
  .command("ops")
  .description("Internal operator support actions");

failWithGroupHelp(opsCommand);

const opsProjectsCommand = opsCommand
  .command("projects")
  .description("Find projects for operator support");

failWithGroupHelp(opsProjectsCommand);

const opsProjectsFindCommand = opsProjectsCommand
  .command("find")
  .description("Search projects by id, name, org, or owner email")
  .requiredOption("--query <text>", "Search text")
  .option("--limit <count>", "Maximum results (default: 10)", Number.parseInt)
  .option("--json", "Output JSON");
addServerUrlOptions(opsProjectsFindCommand);
addAccessTokenOptions(opsProjectsFindCommand, "Instafy access token");
addServiceTokenOptions(opsProjectsFindCommand, "Instafy service token (advanced)");
opsProjectsFindCommand.action(async (opts) => {
  try {
    await opsProjectsSearch({
      query: opts.query,
      limit: opts.limit,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const opsCreditsCommand = opsCommand
  .command("credits")
  .description("Inspect or adjust project credits");

failWithGroupHelp(opsCreditsCommand);

const opsCreditsStatusCommand = opsCreditsCommand
  .command("status")
  .description("Show operator credit status for a project")
  .requiredOption("--project-id <uuid>", "Project UUID")
  .option("--json", "Output JSON");
addServerUrlOptions(opsCreditsStatusCommand);
addAccessTokenOptions(opsCreditsStatusCommand, "Instafy access token");
addServiceTokenOptions(opsCreditsStatusCommand, "Instafy service token (advanced)");
opsCreditsStatusCommand.action(async (opts) => {
  try {
    await opsCreditsStatus({
      projectId: opts.projectId,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const opsCreditsAddCommand = opsCreditsCommand
  .command("add")
  .description("Add credits to a project org balance")
  .requiredOption("--project-id <uuid>", "Project UUID")
  .requiredOption("--amount <credits>", "Credits to add", Number.parseInt)
  .option("--note <text>", "Optional operator note")
  .option("--json", "Output JSON");
addServerUrlOptions(opsCreditsAddCommand);
addAccessTokenOptions(opsCreditsAddCommand, "Instafy access token");
addServiceTokenOptions(opsCreditsAddCommand, "Instafy service token (advanced)");
opsCreditsAddCommand.action(async (opts) => {
  try {
    await opsCreditsAdd({
      projectId: opts.projectId,
      amount: opts.amount,
      note: opts.note,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const opsCreditsSetCommand = opsCreditsCommand
  .command("set")
  .description("Set a project org balance to an exact value")
  .requiredOption("--project-id <uuid>", "Project UUID")
  .requiredOption("--amount <credits>", "Target credit balance", Number.parseInt)
  .option("--note <text>", "Optional operator note")
  .option("--json", "Output JSON");
addServerUrlOptions(opsCreditsSetCommand);
addAccessTokenOptions(opsCreditsSetCommand, "Instafy access token");
addServiceTokenOptions(opsCreditsSetCommand, "Instafy service token (advanced)");
opsCreditsSetCommand.action(async (opts) => {
  try {
    await opsCreditsSet({
      projectId: opts.projectId,
      amount: opts.amount,
      note: opts.note,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const opsRuntimesCommand = opsCommand
  .command("runtimes")
  .description("List and stop project runtimes");

failWithGroupHelp(opsRuntimesCommand);

const opsRuntimesListCommand = opsRuntimesCommand
  .command("list")
  .description("List runtimes for a project")
  .requiredOption("--project-id <uuid>", "Project UUID")
  .option("--json", "Output JSON");
addServerUrlOptions(opsRuntimesListCommand);
addAccessTokenOptions(opsRuntimesListCommand, "Instafy access token");
addServiceTokenOptions(opsRuntimesListCommand, "Instafy service token (advanced)");
opsRuntimesListCommand.action(async (opts) => {
  try {
    await opsRuntimesList({
      projectId: opts.projectId,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const opsRuntimesStopCommand = opsRuntimesCommand
  .command("stop")
  .description("Stop one runtime for a project")
  .requiredOption("--project-id <uuid>", "Project UUID")
  .requiredOption("--runtime-id <uuid>", "Runtime UUID")
  .option("--reason <text>", "Optional operator stop reason")
  .option("--json", "Output JSON");
addServerUrlOptions(opsRuntimesStopCommand);
addAccessTokenOptions(opsRuntimesStopCommand, "Instafy access token");
addServiceTokenOptions(opsRuntimesStopCommand, "Instafy service token (advanced)");
opsRuntimesStopCommand.action(async (opts) => {
  try {
    await opsRuntimesStop({
      projectId: opts.projectId,
      runtimeId: opts.runtimeId,
      reason: opts.reason,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

program
  .command("git")
  .description("Run git against the Instafy canonical checkout (.instafy/.git)")
  .allowUnknownOption(true);

const tunnelCommand = program
  .command("tunnel")
  .description("Create and manage shareable tunnels");

failWithGroupHelp(tunnelCommand);

const tunnelStartCommand = tunnelCommand
  .command("start")
  .description("Create (or reuse) a shareable tunnel URL for a local port (defaults to detached)")
  .option("--port <port>", "Local port to expose (default 3000)")
  .option("--name <name>", "Stable tunnel name (default web)")
  .option("--rotate", "Rotate the stable tunnel hostname before starting");

addSpaceOption(
  tunnelStartCommand,
  "Space UUID (defaults to .instafy/space.json or SPACE_ID)",
);

addServerUrlOptions(tunnelStartCommand);
addAccessTokenOptions(tunnelStartCommand, "Instafy access token (defaults to saved `instafy login` token)");
addServiceTokenOptions(tunnelStartCommand, "Instafy service token (advanced)");

tunnelStartCommand
  .option("--no-detach", "Run in foreground until interrupted")
  .option("--rathole-bin <path>", "Path to rathole binary (or set RATHOLE_BIN)")
  .option("--log-file <path>", "Write tunnel logs to a file (default: ~/.instafy/cli-tunnel-logs/*)")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const space = resolveSpaceIdOption(opts);
      const port = opts.port ? Number(opts.port) : undefined;
      const controllerToken =
        opts.serviceToken ??
        opts.controllerToken ??
        opts.accessToken ??
        opts.controllerAccessToken;
      if (opts.detach === false) {
        await runTunnelCommand({
          project: space,
          controllerUrl: opts.serverUrl ?? opts.controllerUrl,
          controllerToken,
          name: opts.name,
          rotate: Boolean(opts.rotate),
          port,
          ratholeBin: opts.ratholeBin,
        });
        return;
      }

      const started = await startTunnelDetached({
        project: space,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        controllerToken,
        name: opts.name,
        rotate: Boolean(opts.rotate),
        port,
        ratholeBin: opts.ratholeBin,
        logFile: opts.logFile,
      });

      if (opts.json) {
        console.log(JSON.stringify(started, null, 2));
        return;
      }

      console.log(kleur.green(`Tunnel started: ${started.url} (tunnelId=${started.tunnelId})`));
      console.log(kleur.gray(`pid=${started.pid} · port=${started.localPort}`));
      console.log(kleur.gray(`log: ${started.logFile}`));
      console.log("");
      console.log("Next:");
      console.log(`- ${kleur.cyan(`instafy tunnel list`)}`);
      console.log(`- ${kleur.cyan(`instafy tunnel logs ${started.tunnelId} --follow`)}`);
      console.log(`- ${kleur.cyan(`instafy tunnel stop ${started.tunnelId}`)}`);
      if (process.platform !== "win32") {
        console.log(kleur.gray(`(or) tail -n 200 -f ${started.logFile}`));
      }
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

tunnelCommand
  .command("list")
  .description("List local tunnel sessions started by this CLI")
  .option("--all", "Include stopped/stale tunnels")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const tunnels = listTunnelSessions({ all: Boolean(opts.all), json: Boolean(opts.json) });
      if (opts.json) {
        console.log(JSON.stringify(tunnels, null, 2));
        return;
      }
      if (tunnels.length === 0) {
        console.log(kleur.yellow("No tunnels found."));
        return;
      }
      for (const tunnel of tunnels) {
        console.log(`${tunnel.tunnelId} · ${tunnel.url} · port=${tunnel.localPort} · pid=${tunnel.pid}`);
      }
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

tunnelCommand
  .command("stop")
  .description("Stop a local tunnel session and revoke it")
  .argument("[tunnelId]", "Tunnel ID (defaults to the only active tunnel)")
  .option("--server-url <url>", "Instafy server URL")
  .option("--access-token <token>", "Instafy access token (defaults to saved `instafy login` token)")
  .option("--service-token <token>", "Instafy service token (advanced)")
  .option("--json", "Output JSON")
  .action(async (tunnelId, opts) => {
    try {
      const result = await stopTunnelSession({
        tunnelId,
        controllerUrl: opts.serverUrl,
        controllerToken: opts.serviceToken ?? opts.accessToken,
        json: opts.json,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(kleur.green(`Tunnel stopped: ${result.tunnelId}`));
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

tunnelCommand
  .command("logs")
  .description("Show logs for a local tunnel session")
  .argument("[tunnelId]", "Tunnel ID (defaults to the only active tunnel)")
  .option("--lines <n>", "Number of lines to show", "200")
  .option("--follow", "Follow log output (like tail -f)")
  .option("--json", "Output JSON")
  .action(async (tunnelId, opts) => {
    try {
      const lines = typeof opts.lines === "string" ? Number(opts.lines) : undefined;
      await tailTunnelLogs({
        tunnelId,
        lines,
        follow: Boolean(opts.follow),
        json: Boolean(opts.json),
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const orgCommand = program
  .command("team")
  .alias("org")
  .description("Team utilities");

failWithGroupHelp(orgCommand);

const orgListCommand = orgCommand
  .command("list")
  .description("List teams for your account");

addServerUrlOptions(orgListCommand);

orgListCommand
  .option("--access-token <token>", "Instafy or Supabase access token")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await (await import("./org.js")).listOrganizations({
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const profileCommand = program
  .command("profile")
  .description("Manage saved CLI profiles (~/.instafy/profiles)");

failWithGroupHelp(profileCommand);

profileCommand
  .command("list")
  .description("List saved CLI profiles")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const names = listInstafyProfileNames();
      const profiles = names.map((name) => {
        const config = readInstafyProfileConfig(name);
        return {
          name,
          path: getInstafyProfileConfigPath(name),
          controllerUrl: config.controllerUrl ?? null,
          studioUrl: config.studioUrl ?? null,
          accessTokenSet: Boolean(config.accessToken),
          updatedAt: config.updatedAt ?? null,
        };
      });

      if (opts.json) {
        console.log(JSON.stringify({ profiles }, null, 2));
        return;
      }

      if (profiles.length === 0) {
        console.log(kleur.yellow("No profiles found."));
        console.log(`Create one with: ${kleur.cyan("instafy login --profile <name>")}`);
        return;
      }

      console.log(kleur.green("Instafy CLI profiles"));
      for (const profile of profiles) {
        const token = profile.accessTokenSet ? kleur.green("token") : kleur.yellow("no-token");
        console.log(`- ${kleur.cyan(profile.name)} (${token})`);
      }
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const historyCommand = program
  .command("history")
  .description("Inspect conversation history and related runs");

failWithGroupHelp(historyCommand);

const historyMessagesCommand = historyCommand
  .command("messages")
  .description("List messages in a conversation (newest first)")
  .option("--conversation <id>", "Conversation UUID (defaults to INSTAFY_CONVERSATION_ID)");
addServerUrlOptions(historyMessagesCommand);
addAccessTokenOptions(historyMessagesCommand, "Instafy access token");
addServiceTokenOptions(historyMessagesCommand, "Instafy service token (advanced)");
historyMessagesCommand
  .option("--limit <n>", "Max messages to return (1-200, default: 50)", Number.parseInt)
  .option("--cursor <messageId>", "Pagination cursor (message UUID)")
  .option("--no-pretty", "Disable JSON pretty-printing")
  .action(async (opts) => {
    try {
      await historyMessages({
        conversation: opts.conversation,
        limit: opts.limit,
        cursor: opts.cursor,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        pretty: opts.pretty,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const historyRunsCommand = historyCommand
  .command("runs")
  .description("List runs in a conversation (newest first)")
  .option("--conversation <id>", "Conversation UUID (defaults to INSTAFY_CONVERSATION_ID)");
addServerUrlOptions(historyRunsCommand);
addAccessTokenOptions(historyRunsCommand, "Instafy access token");
addServiceTokenOptions(historyRunsCommand, "Instafy service token (advanced)");
historyRunsCommand
  .option("--limit <n>", "Max runs to return (1-200, default: 50)", Number.parseInt)
  .option("--no-pretty", "Disable JSON pretty-printing")
  .action(async (opts) => {
    try {
      await historyRuns({
        conversation: opts.conversation,
        limit: opts.limit,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        pretty: opts.pretty,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const historyConversationsCommand = historyCommand
  .command("conversations")
  .description("List conversations for a space (newest first)")
  .option("--space <id>", "Space UUID (defaults to SPACE_ID or .instafy/space.json)");
addServerUrlOptions(historyConversationsCommand);
addAccessTokenOptions(historyConversationsCommand, "Instafy access token");
addServiceTokenOptions(historyConversationsCommand, "Instafy service token (advanced)");
historyConversationsCommand
  .option("--limit <n>", "Max conversations to return (1-200, default: 50)", Number.parseInt)
  .option("--no-pretty", "Disable JSON pretty-printing")
  .action(async (opts) => {
    try {
      await historyConversations({
        project: opts.space,
        limit: opts.limit,
        controllerUrl: opts.serverUrl ?? opts.controllerUrl,
        accessToken: opts.accessToken ?? opts.controllerAccessToken,
        serviceToken: opts.serviceToken ?? opts.controllerToken,
        pretty: opts.pretty,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const conversationCommand = program
  .command("conversation")
  .description("Find and inspect conversations in a space");

failWithGroupHelp(conversationCommand);

const conversationCreateCommand = conversationCommand
  .command("create")
  .description("Create a blank conversation or linked child thread")
  .option("--space <id>", "Space UUID (defaults to SPACE_ID or .instafy/space.json)")
  .option("--title <title>", "Conversation title")
  .option("--parent <conversationId>", "Parent conversation UUID for a linked child thread")
  .option("--thread-kind <kind>", "Child thread classification, for example agent")
  .option("--json", "Output JSON");
addServerUrlOptions(conversationCreateCommand);
addAccessTokenOptions(conversationCreateCommand, "Instafy access token");
addServiceTokenOptions(conversationCreateCommand, "Instafy service token (advanced)");
conversationCreateCommand.action(async (opts) => {
  try {
    await createConversation({
      project: opts.space,
      title: opts.title,
      parent: opts.parent,
      threadKind: opts.threadKind,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const conversationListCommand = conversationCommand
  .command("list")
  .description("List recent conversations for a space")
  .option("--space <id>", "Space UUID (defaults to SPACE_ID or .instafy/space.json)")
  .option("--include-threads", "Include child threads in addition to root conversations")
  .option("--limit <n>", "Max conversations to return (1-200, default: 50)", Number.parseInt)
  .option("--json", "Output JSON");
addServerUrlOptions(conversationListCommand);
addAccessTokenOptions(conversationListCommand, "Instafy access token");
addServiceTokenOptions(conversationListCommand, "Instafy service token (advanced)");
conversationListCommand.action(async (opts) => {
  try {
    await listConversations({
      project: opts.space,
      includeThreads: opts.includeThreads,
      limit: opts.limit,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const conversationSearchCommand = conversationCommand
  .command("search")
  .description("Search recent conversations by title, preview, and message content")
  .argument("<query...>", "Search text")
  .option("--space <id>", "Space UUID (defaults to SPACE_ID or .instafy/space.json)")
  .option("--include-threads", "Include child threads in addition to root conversations")
  .option("--limit <n>", "Max conversations to inspect/return (1-200, default: 50)", Number.parseInt)
  .option("--json", "Output JSON");
addServerUrlOptions(conversationSearchCommand);
addAccessTokenOptions(conversationSearchCommand, "Instafy access token");
addServiceTokenOptions(conversationSearchCommand, "Instafy service token (advanced)");
conversationSearchCommand.action(async (queryParts, opts) => {
  try {
    await searchConversations({
      query: Array.isArray(queryParts) ? queryParts.join(" ") : String(queryParts ?? ""),
      project: opts.space,
      includeThreads: opts.includeThreads,
      limit: opts.limit,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const conversationShowCommand = conversationCommand
  .command("show")
  .description("Show messages from a conversation by id or title/search text")
  .argument("<conversation...>", "Conversation id or title/search text")
  .option("--space <id>", "Space UUID (defaults to SPACE_ID or .instafy/space.json)")
  .option("--include-threads", "Include child threads in addition to root conversations")
  .option("--limit <n>", "Max messages to return (1-200, default: 80)", Number.parseInt)
  .option("--json", "Output JSON");
addServerUrlOptions(conversationShowCommand);
addAccessTokenOptions(conversationShowCommand, "Instafy access token");
addServiceTokenOptions(conversationShowCommand, "Instafy service token (advanced)");
conversationShowCommand.action(async (targetParts, opts) => {
  try {
    await showConversation({
      target: Array.isArray(targetParts) ? targetParts.join(" ") : String(targetParts ?? ""),
      project: opts.space,
      includeThreads: opts.includeThreads,
      limit: opts.limit,
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

function configureApiCommand(command: Command, method: string) {
  addServerUrlOptions(command);
  addAccessTokenOptions(command, "Instafy access token");
  addServiceTokenOptions(command, "Instafy service token (advanced)");

  command
    .option("--query <key=value>", "Query param (repeatable)", collectStringOption, [])
    .option("--header <header>", "Extra header (repeatable, Key: Value)", collectStringOption, [])
    .option("--json <json>", "JSON body as string")
    .option("--json-file <path>", "JSON body read from file")
    .option("--no-pretty", "Disable JSON pretty-printing")
    .action(async (pathArg, opts) => {
      try {
        await requestControllerApi({
          method,
          path: pathArg,
          controllerUrl: opts.serverUrl ?? opts.controllerUrl,
          accessToken: opts.accessToken ?? opts.controllerAccessToken,
          serviceToken: opts.serviceToken ?? opts.controllerToken,
          query: opts.query,
          headers: opts.header,
          json: opts.json,
          jsonFile: opts.jsonFile,
          pretty: opts.pretty,
        });
      } catch (error) {
        console.error(kleur.red(String(error)));
        process.exit(1);
      }
    });
}

const apiCommand = program
  .command("api", { hidden: true })
  .description("Advanced: authenticated requests to the controller API");

failWithGroupHelp(apiCommand);

const apiGetCommand = apiCommand
  .command("get")
  .description("Advanced: authenticated GET request to the controller API")
  .argument("<path>", "API path (or full URL), e.g. /conversations/<id>/messages?limit=50");
configureApiCommand(apiGetCommand, "GET");

const apiPostCommand = apiCommand
  .command("post")
  .description("Advanced: authenticated POST request to the controller API")
  .argument("<path>", "API path (or full URL)");
configureApiCommand(apiPostCommand, "POST");

const apiPatchCommand = apiCommand
  .command("patch")
  .description("Advanced: authenticated PATCH request to the controller API")
  .argument("<path>", "API path (or full URL)");
configureApiCommand(apiPatchCommand, "PATCH");

const apiDeleteCommand = apiCommand
  .command("delete")
  .description("Advanced: authenticated DELETE request to the controller API")
  .argument("<path>", "API path (or full URL)");
configureApiCommand(apiDeleteCommand, "DELETE");

const otaCommand = program
  .command("ota")
  .description("Operate the mobile OTA control plane");

failWithGroupHelp(otaCommand);

const otaReleasesCommand = otaCommand
  .command("releases")
  .description("List or register OTA releases");

failWithGroupHelp(otaReleasesCommand);

const otaReleasesListCommand = otaReleasesCommand
  .command("list")
  .description("List OTA releases")
  .option("--platform <platform>", "Filter by platform (ios|android)")
  .option("--channel <channel>", "Filter by channel")
  .option("--status <status>", "Filter by release status")
  .option("--json", "Output JSON");

addServerUrlOptions(otaReleasesListCommand);
addAccessTokenOptions(otaReleasesListCommand, "Instafy access token");
addServiceTokenOptions(otaReleasesListCommand, "Instafy service token");

otaReleasesListCommand.action(async (opts) => {
  try {
    await listOtaReleases({
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      platform: opts.platform,
      channel: opts.channel,
      status: opts.status,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const otaReleasesRegisterCommand = otaReleasesCommand
  .command("register")
  .description("Register an OTA release")
  .option("--file <path>", "JSON payload file produced by render-ota-release-payload.mjs")
  .option("--release-id <id>", "Release id")
  .option("--platform <platform>", "Platform (ios|android)")
  .option("--channel <channel>", "Release channel")
  .option("--bundle-version <value>", "Bundle version")
  .option("--git-sha <sha>", "Source git SHA")
  .option("--native-version <value>", "Native app version")
  .option("--min-supported-native-version <value>", "Minimum native version")
  .option("--artifact-url <url>", "Artifact URL")
  .option("--artifact-sha256 <sha>", "Artifact SHA256")
  .option("--artifact-size-bytes <bytes>", "Artifact size in bytes")
  .option("--artifact-type <type>", "Artifact type")
  .option("--signature <signature>", "Artifact signature")
  .option("--rollout-percentage <percent>", "Default rollout percentage")
  .option("--status <status>", "Initial release status")
  .option("--published-at <iso>", "Published timestamp")
  .option("--published-by <value>", "Published by")
  .option("--notes <text>", "Internal notes")
  .option("--json", "Output JSON");

addServerUrlOptions(otaReleasesRegisterCommand);
addAccessTokenOptions(otaReleasesRegisterCommand, "Instafy access token");
addServiceTokenOptions(otaReleasesRegisterCommand, "Instafy service token");

otaReleasesRegisterCommand.action(async (opts) => {
  try {
    await registerOtaRelease({
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      file: opts.file,
      releaseId: opts.releaseId,
      platform: opts.platform,
      channel: opts.channel,
      bundleVersion: opts.bundleVersion,
      gitSha: opts.gitSha,
      nativeVersion: opts.nativeVersion,
      minSupportedNativeVersion: opts.minSupportedNativeVersion,
      artifactUrl: opts.artifactUrl,
      artifactSha256: opts.artifactSha256,
      artifactSizeBytes: opts.artifactSizeBytes,
      artifactType: opts.artifactType,
      signature: opts.signature,
      rolloutPercentage: opts.rolloutPercentage,
      status: opts.status,
      publishedAt: opts.publishedAt,
      publishedBy: opts.publishedBy,
      notes: opts.notes,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const otaChannelsCommand = otaCommand
  .command("channels")
  .description("List or change OTA channel pointers");

failWithGroupHelp(otaChannelsCommand);

const otaChannelsListCommand = otaChannelsCommand
  .command("list")
  .description("List OTA channels")
  .option("--platform <platform>", "Filter by platform (ios|android)")
  .option("--channel <channel>", "Filter by channel")
  .option("--json", "Output JSON");

addServerUrlOptions(otaChannelsListCommand);
addAccessTokenOptions(otaChannelsListCommand, "Instafy access token");
addServiceTokenOptions(otaChannelsListCommand, "Instafy service token");

otaChannelsListCommand.action(async (opts) => {
  try {
    await listOtaChannels({
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      platform: opts.platform,
      channel: opts.channel,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const otaChannelsActivateCommand = otaChannelsCommand
  .command("activate")
  .description("Activate a release on an OTA channel")
  .requiredOption("--platform <platform>", "Platform (ios|android)")
  .requiredOption("--channel <channel>", "Channel name")
  .requiredOption("--release-id <id>", "Release id")
  .requiredOption("--activated-by <value>", "Operator or workflow identity")
  .option("--rollout-percentage <percent>", "Rollout percentage")
  .option("--json", "Output JSON");

addServerUrlOptions(otaChannelsActivateCommand);
addAccessTokenOptions(otaChannelsActivateCommand, "Instafy access token");
addServiceTokenOptions(otaChannelsActivateCommand, "Instafy service token");

otaChannelsActivateCommand.action(async (opts) => {
  try {
    await activateOtaChannelCli({
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      platform: opts.platform,
      channel: opts.channel,
      releaseId: opts.releaseId,
      rolloutPercentage: opts.rolloutPercentage,
      activatedBy: opts.activatedBy,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const otaChannelsRollbackCommand = otaChannelsCommand
  .command("rollback")
  .description("Rollback an OTA channel to the previous or a selected release")
  .requiredOption("--platform <platform>", "Platform (ios|android)")
  .requiredOption("--channel <channel>", "Channel name")
  .requiredOption("--activated-by <value>", "Operator or workflow identity")
  .option("--release-id <id>", "Explicit release id to restore")
  .option("--json", "Output JSON");

addServerUrlOptions(otaChannelsRollbackCommand);
addAccessTokenOptions(otaChannelsRollbackCommand, "Instafy access token");
addServiceTokenOptions(otaChannelsRollbackCommand, "Instafy service token");

otaChannelsRollbackCommand.action(async (opts) => {
  try {
    await rollbackOtaChannelCli({
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      platform: opts.platform,
      channel: opts.channel,
      releaseId: opts.releaseId,
      activatedBy: opts.activatedBy,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const desktopUpdatesCommand = program
  .command("desktop-updates")
  .description("Operate desktop update promotions");

failWithGroupHelp(desktopUpdatesCommand);

const desktopPromotionsCommand = desktopUpdatesCommand
  .command("promotions")
  .description("List or request desktop promotions");

failWithGroupHelp(desktopPromotionsCommand);

const desktopPromotionsListCommand = desktopPromotionsCommand
  .command("list")
  .description("List desktop promotion requests")
  .option("--target-channel <channel>", "Filter by target channel")
  .option("--limit <n>", "Limit number of records")
  .option("--json", "Output JSON");

addServerUrlOptions(desktopPromotionsListCommand);
addAccessTokenOptions(desktopPromotionsListCommand, "Instafy access token");
addServiceTokenOptions(desktopPromotionsListCommand, "Instafy service token");

desktopPromotionsListCommand.action(async (opts) => {
  try {
    await listDesktopPromotions({
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      targetChannel: opts.targetChannel,
      limit: opts.limit,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const desktopPromotionsRequestCommand = desktopPromotionsCommand
  .command("request")
  .description("Request a desktop promotion")
  .requiredOption("--source-channel <channel>", "Source channel (stable)")
  .requiredOption("--target-channel <channel>", "Target channel (internal)")
  .requiredOption("--requested-by <value>", "Operator or workflow identity")
  .option("--notes <text>", "Optional internal notes")
  .option("--json", "Output JSON");

addServerUrlOptions(desktopPromotionsRequestCommand);
addAccessTokenOptions(desktopPromotionsRequestCommand, "Instafy access token");
addServiceTokenOptions(desktopPromotionsRequestCommand, "Instafy service token");

desktopPromotionsRequestCommand.action(async (opts) => {
  try {
    await requestDesktopPromotionCli({
      controllerUrl: opts.serverUrl ?? opts.controllerUrl,
      accessToken: opts.accessToken ?? opts.controllerAccessToken,
      serviceToken: opts.serviceToken ?? opts.controllerToken,
      sourceChannel: opts.sourceChannel,
      targetChannel: opts.targetChannel,
      requestedBy: opts.requestedBy,
      notes: opts.notes,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

export async function runCli(argv: string[] = process.argv) {
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  const args = argv.slice(2);
  if (args[0] === "git") {
    if (args[1] === "credential") {
      try {
        await runGitCredentialHelper(args[2] ?? "");
      } catch (error) {
        console.error(String(error));
        process.exitCode = 1;
      }
      return;
    }
    if (args[1] === "sync") {
      const code = await runInstafyGitSync(args.slice(2));
      process.exitCode = code;
      return;
    }
    const code = runInstafyGit(args.slice(1));
    process.exitCode = code;
    return;
  }
  await program.parseAsync(argv);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runCli(process.argv);
}

// Re-export programmatic APIs for external embedders of the runtime.
export {
  runtimeStart as startRuntime,
  runtimeStatus as getRuntimeStatus,
  runtimeStop as stopRuntime,
  runtimeToken as mintRuntimeToken,
  mintPrivateRuntimeIdentity,
  mintRuntimeAccessToken,
  findProjectManifest,
} from "./runtime.js";
export { projectInit, listProjects } from "./project.js";
export { listOrganizations } from "./org.js";
export type { RuntimeStartOptions, ProjectManifest } from "./runtime.js";
