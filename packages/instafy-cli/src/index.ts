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
import {
  automationsCreate,
  automationsDelete,
  automationsList,
  automationsRun,
  automationsUpdate,
  automationsUpdateStatus,
} from "./automations.js";
import { automationsCreate, automationsDelete, automationsList, automationsRun, automationsUpdateStatus } from "./automations.js";
import {
  credentialsClearDefault,
  credentialsList,
  credentialsRevoke,
  credentialsSetDefault,
  credentialsTest,
} from "./credentials.js";
import { listTunnelSessions, startTunnelDetached, stopTunnelSession, tailTunnelLogs, runTunnelCommand } from "./tunnel.js";
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
  teamAccept,
  teamAddMember,
  teamInvite,
  teamInviteLink,
  teamInvites,
  teamMembersList,
  teamRevokeInvite,
  teamRevokeLink,
} from "./team.js";
import {
  grantProviderBinding,
  revokeProviderBinding,
  showProviderBinding,
} from "./provider-bindings.js";
import {
  providersDiscover,
  providersList,
  providersProbe,
  providersRead,
} from "./providers.js";
import { diagnosticsRunResult, diagnosticsRuntimeEvents } from "./diagnostics.js";
import { supportList, supportReport, supportShow } from "./support.js";

export const program = new Command();
program.showSuggestionAfterError();

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
  return command.option(
    "--server-url <url>",
    "Instafy server URL (default: INSTAFY_SERVER_URL env, then the URL saved by `instafy login`, then http://127.0.0.1:8788; hosted: https://controller.instafy.dev)",
  );
}

function addAccessTokenOptions(command: Command, description: string) {
  return command.option("--access-token <token>", description);
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
    "Without a TTY, wait up to 10 minutes for the browser login callback instead of failing fast",
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
          controllerUrl: opts.serverUrl,
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
          controllerUrl: opts.serverUrl,
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
          controllerUrl: opts.serverUrl,
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

  spaceInviteCommand.action(async (email, opts) => {
    try {
      await inviteSpaceMember({
        email,
        role: opts.role,
        project: resolveSpaceIdOption(opts),
        orgId: resolveTeamIdOption(opts),
        path: opts.path,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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

  spaceRoleCommand.action(async (email, role, opts) => {
    try {
      await setSpaceMemberRole({
        email,
        role,
        project: resolveSpaceIdOption(opts),
        orgId: resolveTeamIdOption(opts),
        path: opts.path,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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

agentsListCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await agentsList({
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
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

agentsStatusCommand
  .option("--json", "Output JSON")
  .action(async (groupId, opts) => {
    try {
      await agentPlanGroupStatus({
        groupId,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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

agentsCancelCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await agentJobsCancel({
        group: opts.group,
        job: opts.job,
        reason: opts.reason,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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

secretsListCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await secretsList({
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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

secretsGetCommand
  .option("--json", "Output JSON")
  .action(async (nameOrId, opts) => {
    try {
      await secretsGet({
        nameOrId,
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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

secretsRevokeCommand
  .option("--json", "Output JSON")
  .action(async (nameOrId, opts) => {
    try {
      await secretsRevoke({
        nameOrId,
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
  .option(
    "--silent-when-nothing-to-report",
    "Do not post a completion result or send a result notification when a successful run has no findings",
  )
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
        silentWhenNothingToReport: Boolean(opts.silentWhenNothingToReport),
        paused: Boolean(opts.paused),
        project: resolveSpaceIdOption(opts),
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const automationsUpdateCommand = automationsCommand
  .command("update")
  .description("Update an automation's name, prompt, schedule, or runtime settings in place")
  .argument("<automation-id>", "Automation UUID")
  .option("--name <name>", "New automation name")
  .option("--prompt <text>", "New prompt to run on schedule")
  .option("--prompt-file <path>", "Read the new prompt from a file")
  .option("--schedule-kind <kind>", "weekly|hourly|once")
  .option("--run-at <datetime>", "Run time for once schedule (RFC3339 or YYYY-MM-DDTHH:MM[:SS])")
  .option("--interval-hours <n>", "Interval hours (hourly schedule)", (value) => Number(value))
  .option("--days <list>", "Weekdays for weekly schedule (e.g. mo,tu,we,th,fr)")
  .option("--time <hh:mm>", "Time for weekly schedule (24h, e.g. 09:00)")
  .option("--timezone <tz>", "IANA timezone (e.g. America/New_York)")
  .option("--runtime-mode <mode>", "auto|hosted|existing")
  .option("--runtime-provider <id>", "Runtime provider id")
  .option(
    "--silent-when-nothing-to-report",
    "Do not post a completion result or send a result notification when a successful run has no findings",
  )
  .option(
    "--no-silent-when-nothing-to-report",
    "Always post a completion result and send a result notification",
  );

addServerUrlOptions(automationsUpdateCommand);
addAccessTokenOptions(automationsUpdateCommand, "Instafy access token");

automationsUpdateCommand
  .option("--json", "Output JSON")
  .action(async (automationId, opts) => {
    try {
      await automationsUpdate({
        automationId,
        name: opts.name,
        prompt: opts.prompt,
        promptFile: opts.promptFile,
        scheduleKind: opts.scheduleKind,
        runAt: opts.runAt,
        intervalHours: opts.intervalHours,
        days: opts.days,
        time: opts.time,
        timezone: opts.timezone,
        runtimeMode: opts.runtimeMode,
        runtimeProvider: opts.runtimeProvider,
        silentWhenNothingToReport: opts.silentWhenNothingToReport,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const credentialsCommand = program
  .command("credentials")
  .description("Inspect, verify and pick the AI provider credentials your jobs use");

failWithGroupHelp(credentialsCommand);

const credentialsListCommand = credentialsCommand
  .command("list")
  .description("List your AI credentials (secret material is never shown)")
  .option("--all", "Include revoked credentials");

addServerUrlOptions(credentialsListCommand);
addAccessTokenOptions(credentialsListCommand, "Instafy access token");

credentialsListCommand
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      await credentialsList({
        all: Boolean(opts.all),
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const credentialsTestCommand = credentialsCommand
  .command("test")
  .description("Probe one credential through the proxy against its upstream provider (exit 1 on failure)")
  .argument("<id-or-prefix>", "Credential UUID or unique id prefix");

addServerUrlOptions(credentialsTestCommand);
addAccessTokenOptions(credentialsTestCommand, "Instafy access token");

credentialsTestCommand
  .option("--json", "Output JSON")
  .action(async (idOrPrefix, opts) => {
    try {
      const result = await credentialsTest({
        idOrPrefix,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
      if (!result.ok) {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const credentialsDefaultCommand = credentialsCommand
  .command("default")
  .description("Set the default credential jobs use, or clear it with --clear")
  .argument("[id-or-prefix]", "Credential UUID or unique id prefix")
  .option("--clear", "Clear the default credential instead of setting one");

addServerUrlOptions(credentialsDefaultCommand);
addAccessTokenOptions(credentialsDefaultCommand, "Instafy access token");

credentialsDefaultCommand
  .option("--json", "Output JSON")
  .action(async (idOrPrefix, opts) => {
    try {
      const target = pickTrimmedString(idOrPrefix);
      if (opts.clear && target) {
        throw new Error("Pass either a credential id or --clear, not both.");
      }
      if (!opts.clear && !target) {
        throw new Error("Provide a credential id (or unique prefix), or pass --clear.");
      }
      if (opts.clear) {
        await credentialsClearDefault({
          controllerUrl: opts.serverUrl,
          accessToken: opts.accessToken,
          json: opts.json,
        });
        return;
      }
      await credentialsSetDefault({
        idOrPrefix: target!,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const credentialsRevokeCommand = credentialsCommand
  .command("revoke")
  .description("Revoke a credential (asks for confirmation unless --yes)")
  .argument("<id-or-prefix>", "Credential UUID or unique id prefix")
  .option("--yes", "Skip the confirmation prompt (required when not running in a terminal)");

addServerUrlOptions(credentialsRevokeCommand);
addAccessTokenOptions(credentialsRevokeCommand, "Instafy access token");

credentialsRevokeCommand
  .option("--json", "Output JSON")
  .action(async (idOrPrefix, opts) => {
    try {
      await credentialsRevoke({
        idOrPrefix,
        yes: Boolean(opts.yes),
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        controllerAccessToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        controllerAccessToken: opts.accessToken,
        runtimeId: opts.runtimeId,
        scopes: opts.scope,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const diagnosticsCommand = program
  .command("diagnostics")
  .description("Inspect user-authorized run and runtime diagnostics as stable JSON");

failWithGroupHelp(diagnosticsCommand);

const diagnosticsRuntimeEventsCommand = diagnosticsCommand
  .command("runtime-events")
  .description("Read sanitized runtime events for a space as JSON")
  .option("--space <id>", "Space UUID (defaults to .instafy/space.json or SPACE_ID)")
  .option("--runtime-id <uuid>", "Filter by runtime UUID")
  .option("--session-id <uuid>", "Use a session UUID for project authorization")
  .option("--kind <kind>", "Filter by runtime event kind")
  .option("--since <timestamp>", "Return events at or after an RFC3339 timestamp")
  .option("--limit <count>", "Maximum events (1-200, default: 50)", Number.parseInt);
addServerUrlOptions(diagnosticsRuntimeEventsCommand);
addAccessTokenOptions(diagnosticsRuntimeEventsCommand, "Signed-in user access token");
diagnosticsRuntimeEventsCommand.action(async (opts) => {
  try {
    await diagnosticsRuntimeEvents({
      space: opts.space,
      runtimeId: opts.runtimeId,
      sessionId: opts.sessionId,
      kind: opts.kind,
      since: opts.since,
      limit: opts.limit,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const diagnosticsRunResultCommand = diagnosticsCommand
  .command("run-result")
  .description("Read the authorized persisted result for one run as JSON")
  .argument("<run-id>", "Run UUID");
addServerUrlOptions(diagnosticsRunResultCommand);
addAccessTokenOptions(diagnosticsRunResultCommand, "Signed-in user access token");
diagnosticsRunResultCommand.action(async (runId, opts) => {
  try {
    await diagnosticsRunResult({
      runId,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const supportCommand = program
  .command("support")
  .description("Report issues and view your own support reports");

failWithGroupHelp(supportCommand);

const supportReportCommand = supportCommand
  .command("report")
  .description("Submit a support report as the signed-in user")
  .argument("<summary...>", "Short summary of the issue")
  .option("--details <text>", "Optional details (may be sensitive)")
  .option("--details-file <path>", "Read details from a regular file inside the active workspace")
  .option("--space <id>", "Space UUID (defaults to .instafy/space.json)")
  .option("--no-linked-space", "Do not attach the linked space automatically")
  .option("--runtime-id <uuid>", "Attach a runtime UUID")
  .option("--run-id <uuid>", "Attach a run UUID")
  .option("--conversation-id <uuid>", "Attach a conversation UUID")
  .option("--metadata-file <path>", "Attach a workspace-local JSON metadata object")
  .option("--logs-file <path>", "Attach a workspace-local JSON array of log entries")
  .option(
    "--screenshot <path>",
    "Attach a workspace-local PNG, JPEG, or WebP screenshot",
    collectStringOption,
    [],
  )
  .option("--preview", "Show what would be uploaded without making a request")
  .option("--json", "Output the safe response as JSON");
addServerUrlOptions(supportReportCommand);
addAccessTokenOptions(supportReportCommand, "Signed-in user access token");
supportReportCommand.action(async (summaryParts, opts) => {
  try {
    await supportReport({
      summary: Array.isArray(summaryParts) ? summaryParts.join(" ") : String(summaryParts ?? ""),
      details: opts.details,
      detailsFile: opts.detailsFile,
      space: opts.space,
      useLinkedSpace: opts.linkedSpace,
      runtimeId: opts.runtimeId,
      runId: opts.runId,
      conversationId: opts.conversationId,
      metadataFile: opts.metadataFile,
      logsFile: opts.logsFile,
      screenshots: opts.screenshot,
      preview: opts.preview,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const supportListCommand = supportCommand
  .command("list")
  .description("List support reports submitted by the signed-in user")
  .option("--limit <count>", "Maximum reports (1-100, default: 25)", Number.parseInt)
  .option("--status <status>", "Filter by open, in_progress, or resolved")
  .option("--space <id>", "Filter by space UUID")
  .option("--before <timestamp>", "List reports created before an RFC3339 timestamp")
  .option("--json", "Output the safe report summaries as JSON");
addServerUrlOptions(supportListCommand);
addAccessTokenOptions(supportListCommand, "Signed-in user access token");
supportListCommand.action(async (opts) => {
  try {
    await supportList({
      limit: opts.limit,
      status: opts.status,
      space: opts.space,
      before: opts.before,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const supportShowCommand = supportCommand
  .command("show")
  .description("Show one support report owned by the signed-in user")
  .argument("<report-id>", "Support report UUID")
  .option("--json", "Output the safe report as JSON");
addServerUrlOptions(supportShowCommand);
addAccessTokenOptions(supportShowCommand, "Signed-in user access token");
supportShowCommand.action(async (reportId, opts) => {
  try {
    await supportShow({
      reportId,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
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

tunnelStartCommand
  .option("--no-detach", "Run in foreground until interrupted")
  .option("--rathole-bin <path>", "Path to rathole binary (or set RATHOLE_BIN)")
  .option("--log-file <path>", "Write tunnel logs to a file (default: ~/.instafy/cli-tunnel-logs/*)")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const space = resolveSpaceIdOption(opts);
      const port = opts.port ? Number(opts.port) : undefined;
      const controllerToken = opts.accessToken;
      if (opts.detach === false) {
        await runTunnelCommand({
          project: space,
          controllerUrl: opts.serverUrl,
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
        controllerUrl: opts.serverUrl,
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
  .option("--json", "Output JSON")
  .action(async (tunnelId, opts) => {
    try {
      const result = await stopTunnelSession({
        tunnelId,
        controllerUrl: opts.serverUrl,
        controllerToken: opts.accessToken,
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

function teamScopeCommandFactory(nameAndArgs: string, description: string): Command {
  const command = orgCommand.command(nameAndArgs).description(description);
  addServerUrlOptions(command);
  addAccessTokenOptions(command, "Instafy access token");
  command
    .option("--team-id <team>", "Team id (UUID) or slug (defaults to your only team)")
    .option("--json", "Output JSON");
  return command;
}

const teamMembersCommand = teamScopeCommandFactory("members", "List members of a team");
teamMembersCommand.action(async (opts) => {
  try {
    await teamMembersList({
      teamId: opts.teamId,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const teamInviteCommand = teamScopeCommandFactory(
  "invite <email>",
  "Invite a teammate by email (they must sign in with that email to accept)",
);
teamInviteCommand
  .option("--role <role>", "owner, admin, builder, or viewer (default: builder)")
  .action(async (email, opts) => {
    try {
      await teamInvite({
        email,
        role: opts.role,
        teamId: opts.teamId,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const teamInviteLinkCommand = teamScopeCommandFactory(
  "invite-link",
  "Create a shareable invite link that works with any sign-in method",
);
teamInviteLinkCommand
  .option("--role <role>", "builder or viewer (default: builder)")
  .option("--studio-url <url>", "Studio base URL for the accept link (default: https://instafy.dev)")
  .action(async (opts) => {
    try {
      await teamInviteLink({
        role: opts.role,
        studioUrl: opts.studioUrl,
        teamId: opts.teamId,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const teamInvitesCommand = teamScopeCommandFactory(
  "invites",
  "List pending email invitations and invite links",
);
teamInvitesCommand.action(async (opts) => {
  try {
    await teamInvites({
      teamId: opts.teamId,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const teamAddMemberCommand = teamScopeCommandFactory(
  "add-member",
  "Add an existing Instafy account to a team by user id",
);
teamAddMemberCommand
  .requiredOption("--user-id <uuid>", "User id of an existing Instafy account")
  .option("--role <role>", "owner, admin, builder, or viewer (default: builder)")
  .action(async (opts) => {
    try {
      await teamAddMember({
        userId: opts.userId,
        role: opts.role,
        teamId: opts.teamId,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const teamAcceptCommand = teamScopeCommandFactory(
  "accept <token>",
  "Accept a team invitation or invite link with the current account",
);
teamAcceptCommand.action(async (token, opts) => {
  try {
    await teamAccept({
      token,
      teamId: opts.teamId,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
      json: opts.json,
    });
  } catch (error) {
    console.error(kleur.red(String(error)));
    process.exit(1);
  }
});

const teamRevokeInviteCommand = teamScopeCommandFactory(
  "revoke-invite <invitation-id>",
  "Revoke a pending email invitation",
);
teamRevokeInviteCommand
  .option("--yes", "Skip the confirmation prompt")
  .action(async (invitationId, opts) => {
    try {
      await teamRevokeInvite({
        invitationId,
        yes: opts.yes,
        teamId: opts.teamId,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
        json: opts.json,
      });
    } catch (error) {
      console.error(kleur.red(String(error)));
      process.exit(1);
    }
  });

const teamRevokeLinkCommand = teamScopeCommandFactory(
  "revoke-link <invite-link-id>",
  "Revoke a shareable invite link",
);
teamRevokeLinkCommand
  .option("--yes", "Skip the confirmation prompt")
  .action(async (inviteLinkId, opts) => {
    try {
      await teamRevokeLink({
        inviteLinkId,
        yes: opts.yes,
        teamId: opts.teamId,
        controllerUrl: opts.serverUrl,
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
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
historyRunsCommand
  .option("--limit <n>", "Max runs to return (1-200, default: 50)", Number.parseInt)
  .option("--no-pretty", "Disable JSON pretty-printing")
  .action(async (opts) => {
    try {
      await historyRuns({
        conversation: opts.conversation,
        limit: opts.limit,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
historyConversationsCommand
  .option("--limit <n>", "Max conversations to return (1-200, default: 50)", Number.parseInt)
  .option("--no-pretty", "Disable JSON pretty-printing")
  .action(async (opts) => {
    try {
      await historyConversations({
        project: opts.space,
        limit: opts.limit,
        controllerUrl: opts.serverUrl,
        accessToken: opts.accessToken,
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
conversationCreateCommand.action(async (opts) => {
  try {
    await createConversation({
      project: opts.space,
      title: opts.title,
      parent: opts.parent,
      threadKind: opts.threadKind,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
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
conversationListCommand.action(async (opts) => {
  try {
    await listConversations({
      project: opts.space,
      includeThreads: opts.includeThreads,
      limit: opts.limit,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
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
conversationSearchCommand.action(async (queryParts, opts) => {
  try {
    await searchConversations({
      query: Array.isArray(queryParts) ? queryParts.join(" ") : String(queryParts ?? ""),
      project: opts.space,
      includeThreads: opts.includeThreads,
      limit: opts.limit,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
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
conversationShowCommand.action(async (targetParts, opts) => {
  try {
    await showConversation({
      target: Array.isArray(targetParts) ? targetParts.join(" ") : String(targetParts ?? ""),
      project: opts.space,
      includeThreads: opts.includeThreads,
      limit: opts.limit,
      controllerUrl: opts.serverUrl,
      accessToken: opts.accessToken,
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
