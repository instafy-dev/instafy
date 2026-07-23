import fs from "node:fs";
import path from "node:path";
import kleur from "kleur";
import { stdin as input } from "node:process";
import {
  getInstafyProfileConfigPath,
  resolveConfiguredStudioUrl,
  resolveControllerUrl,
  resolveUserAccessTokenWithSource,
  type AccessTokenSource,
} from "./config.js";
import { formatAuthRejectedError, formatAuthRequiredError } from "./errors.js";
import { findProjectManifest } from "./project-manifest.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";

let promptsModule: Promise<typeof import("@clack/prompts")> | null = null;

async function loadPrompts() {
  promptsModule ??= import("@clack/prompts");
  return promptsModule;
}

export interface ProjectInitOptions {
  path?: string;
  controllerUrl?: string;
  accessToken?: string;
  profile?: string;
  projectType?: string;
  orgName?: string;
  orgSlug?: string;
  orgId?: string;
  ownerUserId?: string;
  json?: boolean;
}

export interface ProjectListOptions {
  controllerUrl?: string;
  accessToken?: string;
  orgId?: string;
  orgSlug?: string;
  json?: boolean;
}

export interface ProjectDefaultsRefreshOptions {
  project?: string;
  path?: string;
  controllerUrl?: string;
  accessToken?: string;
  json?: boolean;
}

export interface ProjectProfileOptions {
  profile?: string | null;
  path?: string;
  unset?: boolean;
  json?: boolean;
}

interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  role?: string | null;
}

interface CreateOrgResponse {
  org_id?: string;
  orgId?: string;
  id?: string;
  org_slug?: string | null;
  orgSlug?: string | null;
  org_name?: string | null;
  orgName?: string | null;
}

interface CreateProjectResponse {
  project_id?: string;
  projectId?: string;
  org_id?: string | null;
  orgId?: string | null;
  org_name?: string | null;
  orgName?: string | null;
}

interface ProjectSummary {
  project_id: string;
  org_id?: string | null;
  org_slug?: string | null;
  org_name?: string | null;
  owner_user_id?: string | null;
  project_type?: string | null;
  status?: string | null;
}

function getTeamDisplayName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (
    !trimmed ||
    trimmed === "Personal organization" ||
    trimmed === "Personal team" ||
    trimmed === "Personal workspace"
  ) {
    return "Personal";
  }
  return trimmed;
}

interface ProjectMemoryBootstrapResponse {
  ok?: boolean;
  seeded?: boolean;
  fileCount?: number;
  rev?: string | null;
  reason?: string | null;
}

type ControllerAuth = {
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile: string | null;
  cwd: string | null;
};

async function controllerFetch(
  controllerUrl: string,
  auth: ControllerAuth,
  pathname: string,
  init?: RequestInit,
): Promise<Response> {
  const { response, accessToken } = await fetchWithControllerAuth({
    url: `${controllerUrl}${pathname}`,
    init,
    accessToken: auth.accessToken,
    tokenSource: auth.tokenSource,
    profile: auth.profile,
    cwd: auth.cwd,
  });
  auth.accessToken = accessToken;
  return response;
}

async function fetchOrganizations(
  controllerUrl: string,
  auth: ControllerAuth,
  retryCommand: string,
): Promise<OrgSummary[]> {
  const response = await controllerFetch(controllerUrl, auth, "/orgs");
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
        retryCommand,
      });
    }
    throw new Error(`Team list failed (${response.status} ${response.statusText}): ${text}`);
  }
  const body = (await response.json()) as { orgs?: OrgSummary[] };
  return Array.isArray(body.orgs) ? body.orgs : [];
}

async function fetchOrgProjects(
  controllerUrl: string,
  auth: ControllerAuth,
  orgId: string,
  retryCommand: string,
): Promise<ProjectSummary[]> {
  const response = await controllerFetch(
    controllerUrl,
    auth,
    `/orgs/${encodeURIComponent(orgId)}/projects`,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
        retryCommand,
      });
    }
    throw new Error(`Space list failed (${response.status} ${response.statusText}): ${text}`);
  }
  const body = (await response.json()) as { projects?: ProjectSummary[] };
  return Array.isArray(body.projects) ? body.projects : [];
}

async function createOrganization(
  controllerUrl: string,
  auth: ControllerAuth,
  payload: Record<string, unknown>,
  retryCommand: string,
): Promise<{ orgId: string; orgName: string | null }> {
  const response = await controllerFetch(controllerUrl, auth, "/orgs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
        retryCommand,
      });
    }
    throw new Error(
      `Team creation failed (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const json = (await response.json()) as CreateOrgResponse;
  const orgId = json.org_id ?? json.orgId ?? json.id;
  if (!orgId) {
    throw new Error(
      `Team creation response missing an id (expected org_id/orgId/id). Raw: ${JSON.stringify(json)}`,
    );
  }

  return { orgId, orgName: json.org_name ?? json.orgName ?? null };
}

async function resolveOrg(
  controllerUrl: string,
  auth: ControllerAuth,
  options: ProjectInitOptions,
  retryCommand: string,
): Promise<{ orgId: string; orgName: string | null }> {
  if (options.orgId) {
    return { orgId: options.orgId, orgName: options.orgName ?? null };
  }

  const orgSlug = options.orgSlug?.trim() || null;
  const orgName = options.orgName?.trim() || null;
  const studioUrl = resolveConfiguredStudioUrl({ profile: options.profile ?? null }) ?? "https://staging.instafy.dev";
  const studioOrgUrl = `${studioUrl.replace(/\/$/, "")}/studio?panel=settings`;
  const allowInteractive = Boolean(
    input.isTTY && process.stdout.isTTY && options.json !== true && process.env.CI !== "true",
  );

  async function promptAndCreateOrg() {
    const { isCancel, text } = await loadPrompts();

    const enteredName = await text({
      message: "Team name",
      defaultValue: "Personal",
    });
    if (isCancel(enteredName)) {
      throw new Error("Cancelled.");
    }
    const chosenName = String(enteredName).trim() || "Personal";

    const enteredSlug = await text({
      message: "Team slug (optional)",
    });
    if (isCancel(enteredSlug)) {
      throw new Error("Cancelled.");
    }
    const chosenSlug = String(enteredSlug).trim();

    const payload: Record<string, unknown> = {
      orgName: chosenName,
    };
    if (options.ownerUserId) {
      payload.ownerUserId = options.ownerUserId;
    }
    if (chosenSlug) {
      payload.orgSlug = chosenSlug;
    }

    const created = await createOrganization(controllerUrl, auth, payload, retryCommand);
    return { orgId: created.orgId, orgName: created.orgName ?? chosenName };
  }

  if (orgSlug) {
    const orgs = await fetchOrganizations(controllerUrl, auth, retryCommand);
    const matches = orgs.filter((org) => org.slug === orgSlug);
    if (matches.length === 1) {
      return { orgId: matches[0]!.id, orgName: matches[0]!.name ?? null };
    }
  }

  if (!orgSlug && !orgName) {
    const orgs = await fetchOrganizations(controllerUrl, auth, retryCommand);
    if (orgs.length === 0) {
      if (allowInteractive) {
        const { confirm, isCancel } = await loadPrompts();

        console.log(kleur.yellow("No teams found for this account."));
        console.log("");
        console.log(`Create one in Studio: ${kleur.cyan(studioOrgUrl)}`);
        console.log("");

        const shouldCreate = await confirm({
          message: "Create a new team now?",
          initialValue: true,
        });
        if (isCancel(shouldCreate) || !shouldCreate) {
          throw new Error("No team selected.");
        }
        return await promptAndCreateOrg();
      }

      throw new Error(
        `No teams found.\n\nNext:\n- Create a team in Studio: ${studioOrgUrl}\n- Or rerun: instafy space init --team-name \"My Team\"`,
      );
    }

    if (orgs.length === 1) {
      return { orgId: orgs[0]!.id, orgName: orgs[0]!.name ?? null };
    }

    if (allowInteractive) {
      const { isCancel, select } = await loadPrompts();

      const selection = await select({
        message: "Choose a team for this space",
        options: [
          { value: "__create__", label: "+ Create a new team" },
          ...orgs.map((org) => ({
            value: org.id,
            label: getTeamDisplayName(org.name),
            hint: `${org.slug ? `${org.slug} · ` : ""}${org.id}`,
          })),
        ],
        initialValue: orgs[0]!.id,
      });
      if (isCancel(selection)) {
        throw new Error("Cancelled.");
      }
      if (selection === "__create__") {
        return await promptAndCreateOrg();
      }

      const pickedOrg = orgs.find((org) => org.id === selection);
      if (!pickedOrg) {
        throw new Error("Selected team not found.");
      }
      return { orgId: pickedOrg.id, orgName: pickedOrg.name ?? null };
    }

    throw new Error(
      "Multiple teams found.\n\nNext:\n- instafy team list\n- instafy space init --team-id <uuid>",
    );
  }

  if (orgSlug && !orgName) {
    if (allowInteractive) {
      const { isCancel, text } = await loadPrompts();

      console.log(kleur.yellow("Team slug did not match an existing team."));
      console.log(`Create one in Studio: ${kleur.cyan(studioOrgUrl)}`);
      console.log("");

      const enteredName = await text({
        message: "Team name",
        defaultValue: "Personal",
      });
      if (isCancel(enteredName)) {
        throw new Error("Cancelled.");
      }
      const chosenName = String(enteredName).trim() || "Personal";
      const payload: Record<string, unknown> = { orgName: chosenName, orgSlug };
      if (options.ownerUserId) {
        payload.ownerUserId = options.ownerUserId;
      }
      const created = await createOrganization(controllerUrl, auth, payload, retryCommand);
      return { orgId: created.orgId, orgName: created.orgName ?? chosenName };
    }

    throw new Error(
      `Team slug "${orgSlug}" did not match an existing team, and a team name is required to create one.\n\nNext:\n- Create a team in Studio: ${studioOrgUrl}\n- Or rerun: instafy space init --team-name \"My Team\" --team-slug "${orgSlug}"`,
    );
  }

  const payload: Record<string, unknown> = {};
  if (orgName) {
    payload.orgName = orgName;
  }
  if (orgSlug) {
    payload.orgSlug = orgSlug;
  }
  if (options.ownerUserId) {
    payload.ownerUserId = options.ownerUserId;
  }

  if (!payload.orgName) {
    throw new Error(
      `Team name is required.\n\nNext:\n- Create a team in Studio: ${studioOrgUrl}\n- Or rerun: instafy space init --team-name \"My Team\"`,
    );
  }

  const created = await createOrganization(controllerUrl, auth, payload, retryCommand);
  return { orgId: created.orgId, orgName: created.orgName ?? orgName ?? null };
}

export async function listProjects(options: ProjectListOptions): Promise<ProjectSummary[]> {
  const controllerUrl = resolveControllerUrl({ controllerUrl: options.controllerUrl ?? null });
  const resolved = resolveUserAccessTokenWithSource({ accessToken: options.accessToken ?? null });

  if (!resolved.token) {
    throw formatAuthRequiredError({ retryCommand: "instafy space list" });
  }

  const retryCommand = "instafy space list";
  const auth: ControllerAuth = {
    accessToken: resolved.token,
    tokenSource: resolved.source,
    profile: resolved.profile,
    cwd: process.cwd(),
  };
  const orgs = await fetchOrganizations(controllerUrl, auth, retryCommand);
  let targetOrgs = orgs;
  if (options.orgId) {
    targetOrgs = orgs.filter((org) => org.id === options.orgId);
    if (targetOrgs.length === 0) {
      throw new Error(`No team found for id ${options.orgId}`);
    }
  } else if (options.orgSlug) {
    targetOrgs = orgs.filter((org) => org.slug === options.orgSlug);
    if (targetOrgs.length === 0) {
      throw new Error(`No team found for slug ${options.orgSlug}`);
    }
  }

  const summaries: Array<{ org: OrgSummary; projects: ProjectSummary[] }> = [];
  for (const org of targetOrgs) {
    const projects = await fetchOrgProjects(controllerUrl, auth, org.id, retryCommand);
    summaries.push({ org, projects });
  }

  if (options.json) {
    console.log(JSON.stringify(summaries, null, 2));
  } else if (summaries.length === 0) {
    console.log(kleur.yellow("No teams found for this account."));
  } else {
    for (const summary of summaries) {
      console.log(`${kleur.green(getTeamDisplayName(summary.org.name))} (${summary.org.id})`);
      if (summary.projects.length === 0) {
        console.log(kleur.yellow("  No spaces found."));
        continue;
      }
      for (const project of summary.projects) {
        const type = project.project_type ? ` · ${project.project_type}` : "";
        const status = project.status ? ` · ${project.status}` : "";
        console.log(`  ${project.project_id}${type}${status}`);
      }
    }
  }

  return summaries.flatMap((summary) => summary.projects);
}

export async function projectInit(options: ProjectInitOptions): Promise<CreateProjectResponse> {
  const rootDir = path.resolve(options.path ?? process.cwd());
  const controllerUrl = resolveControllerUrl({
    controllerUrl: options.controllerUrl ?? null,
    profile: options.profile ?? null,
    cwd: rootDir,
  });
  const resolved = resolveUserAccessTokenWithSource({
    accessToken: options.accessToken ?? null,
    profile: options.profile ?? null,
    cwd: rootDir,
  });

  if (!resolved.token) {
    throw formatAuthRequiredError({
      retryCommand: "instafy space init",
      advancedHint: "pass --access-token or set INSTAFY_ACCESS_TOKEN / SUPABASE_ACCESS_TOKEN",
    });
  }

  const retryCommand = "instafy space init";
  const auth: ControllerAuth = {
    accessToken: resolved.token,
    tokenSource: resolved.source,
    profile: resolved.profile,
    cwd: rootDir,
  };
  const org = await resolveOrg(controllerUrl, auth, options, retryCommand);
  const body = {
    projectType: options.projectType,
    ownerUserId: options.ownerUserId,
  };

  const response = await controllerFetch(
    controllerUrl,
    auth,
    `/orgs/${encodeURIComponent(org.orgId)}/projects`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
        retryCommand,
      });
    }
    throw new Error(
      `Space creation failed (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const json = (await response.json()) as CreateProjectResponse;
  if (!json.project_id && json.projectId) {
    json.project_id = json.projectId;
  }
  if (!json.org_id && json.orgId) {
    json.org_id = json.orgId;
  }
  if (!json.org_name && json.orgName) {
    json.org_name = json.orgName;
  }
  if (!json.project_id) {
    throw new Error(
      `Space creation response missing a space id (expected project_id/projectId). Raw: ${JSON.stringify(json)}`,
    );
  }
  const manifestDir = path.join(rootDir, ".instafy");
  const manifestPath = path.join(manifestDir, "space.json");

  try {
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          spaceId: json.project_id,
          orgId: json.org_id ?? org.orgId ?? null,
          orgName: json.org_name ?? org.orgName ?? null,
          controllerUrl,
          profile: options.profile ?? null,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Space created but failed to write manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (options.json) {
    console.log(
      JSON.stringify({
        spaceId: json.project_id,
        orgId: json.org_id ?? org.orgId ?? null,
        orgName: json.org_name ?? org.orgName ?? null,
        manifest: manifestPath,
      }),
    );
  } else {
    console.log(kleur.green(`Space created: ${json.project_id}`));
    const resolvedOrgName = json.org_name ?? org.orgName;
    const resolvedOrgId = json.org_id ?? org.orgId;
    if (resolvedOrgName) {
      console.log(
        kleur.cyan(`Team: ${getTeamDisplayName(resolvedOrgName)}${resolvedOrgId ? ` (${resolvedOrgId})` : ""}`),
      );
    }
    console.log(kleur.cyan(`Manifest written to ${manifestPath}`));
  }

  return json;
}

export async function refreshProjectDefaults(
  options: ProjectDefaultsRefreshOptions,
): Promise<ProjectMemoryBootstrapResponse> {
  const rootDir = path.resolve(options.path ?? process.cwd());
  const manifestLookup = findProjectManifest(rootDir);
  const manifest = manifestLookup.manifest;
  const projectId = options.project?.trim() || manifest?.spaceId?.trim() || "";
  if (!projectId) {
    throw new Error(
      "Space id is required. Link the folder with `instafy space init` or pass --space <uuid>.",
    );
  }

  const controllerUrl = resolveControllerUrl({
    controllerUrl: options.controllerUrl ?? manifest?.controllerUrl ?? null,
    profile: manifest?.profile ?? null,
    cwd: rootDir,
  });
  const resolved = resolveUserAccessTokenWithSource({
    accessToken: options.accessToken ?? null,
    profile: manifest?.profile ?? null,
    cwd: rootDir,
  });
  if (!resolved.token) {
    throw formatAuthRequiredError({
      retryCommand: "instafy space defaults refresh",
      advancedHint: "pass --access-token or set INSTAFY_ACCESS_TOKEN / SUPABASE_ACCESS_TOKEN",
    });
  }

  const retryCommand = "instafy space defaults refresh";
  const auth: ControllerAuth = {
    accessToken: resolved.token,
    tokenSource: resolved.source,
    profile: resolved.profile,
    cwd: rootDir,
  };

  const response = await controllerFetch(
    controllerUrl,
    auth,
    `/projects/${encodeURIComponent(projectId)}/memory/bootstrap`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: text,
        retryCommand,
      });
    }
    throw new Error(
      `Space defaults refresh failed (${response.status} ${response.statusText}): ${text}`,
    );
  }

  const payload = (await response.json()) as ProjectMemoryBootstrapResponse;
  const normalized: ProjectMemoryBootstrapResponse = {
    ok: payload.ok !== false,
    seeded: payload.seeded === true,
    fileCount: typeof payload.fileCount === "number" ? payload.fileCount : 0,
    rev: typeof payload.rev === "string" && payload.rev.trim().length > 0 ? payload.rev.trim() : null,
    reason:
      typeof payload.reason === "string" && payload.reason.trim().length > 0
        ? payload.reason.trim()
        : null,
  };

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          projectId,
          ok: normalized.ok,
          seeded: normalized.seeded,
          fileCount: normalized.fileCount,
          rev: normalized.rev ?? null,
          reason: normalized.reason ?? null,
        },
        null,
        2,
      ),
    );
  } else {
    const status = normalized.seeded
      ? kleur.green("Defaults refreshed.")
      : kleur.yellow("No default files changed.");
    console.log(status);
    console.log(`Space: ${projectId}`);
    if (normalized.fileCount) {
      console.log(`Files updated: ${normalized.fileCount}`);
    }
    if (normalized.rev) {
      console.log(`Rev: ${normalized.rev}`);
    }
    if (normalized.reason) {
      console.log(`Reason: ${normalized.reason}`);
    }
  }

  return normalized;
}

export function projectProfile(options: ProjectProfileOptions): { path: string; profile: string | null } {
  const rootDir = path.resolve(options.path ?? process.cwd());
  const manifestInfo = findProjectManifest(rootDir);
  if (!manifestInfo.path || !manifestInfo.manifest) {
    throw new Error("No space configured. Run `instafy space init` in this folder first.");
  }

  const shouldUpdate = options.unset === true || typeof options.profile === "string";
  const currentProfile =
    typeof manifestInfo.manifest.profile === "string" && manifestInfo.manifest.profile.trim()
      ? manifestInfo.manifest.profile.trim()
      : null;

  if (!shouldUpdate) {
    if (options.json) {
      console.log(JSON.stringify({ ok: true, path: manifestInfo.path, profile: currentProfile }, null, 2));
    } else {
      console.log(kleur.green("Space profile"));
      console.log(`Manifest: ${manifestInfo.path}`);
      console.log(`Profile: ${currentProfile ?? kleur.yellow("(none)")}`);
    }
    return { path: manifestInfo.path, profile: currentProfile };
  }

  const nextProfileRaw =
    options.unset === true ? null : typeof options.profile === "string" ? options.profile.trim() : null;
  const nextProfile = nextProfileRaw && nextProfileRaw.length > 0 ? nextProfileRaw : null;
  if (nextProfile) {
    getInstafyProfileConfigPath(nextProfile);
  }

  const updated: Record<string, unknown> = { ...manifestInfo.manifest };
  if (nextProfile) {
    updated.profile = nextProfile;
  } else {
    delete updated.profile;
  }

  fs.writeFileSync(manifestInfo.path, JSON.stringify(updated, null, 2), "utf8");

  if (options.json) {
    console.log(JSON.stringify({ ok: true, path: manifestInfo.path, profile: nextProfile }, null, 2));
  } else {
    console.log(kleur.green("Updated space profile."));
    console.log(`Manifest: ${manifestInfo.path}`);
    console.log(`Profile: ${nextProfile ?? kleur.yellow("(none)")}`);
  }

  return { path: manifestInfo.path, profile: nextProfile };
}
