import fs from "node:fs";
import kleur from "kleur";
import {
  resolveControllerUrl,
  resolveUserAccessTokenWithSource,
  type AccessTokenSource,
} from "./config.js";
import { fetchWithControllerAuth } from "./controller-fetch.js";
import { formatAuthRejectedError, formatAuthRequiredError } from "./errors.js";
import { findProjectManifest } from "./project-manifest.js";

type SecretRecord = {
  id: string;
  name: string;
  description: string | null;
  agentIds: string[];
  agentHandles: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type SecretsCommonOptions = {
  project?: string;
  controllerUrl?: string;
  accessToken?: string;
  json?: boolean;
  cwd?: string;
};

type SecretsListOptions = SecretsCommonOptions;

type SecretsGetOptions = SecretsCommonOptions & {
  nameOrId: string;
};

type SecretsPutOptions = SecretsCommonOptions & {
  name: string;
  value?: string;
  valueStdin?: boolean;
  description?: string;
  agentHandles?: string[];
};

type SecretsRevokeOptions = SecretsCommonOptions & {
  nameOrId: string;
};

type ControllerAuth = {
  controllerUrl: string;
  accessToken: string;
  tokenSource: AccessTokenSource;
  profile: string | null;
  cwd: string;
};

function resolveProjectId(project?: string, cwd: string = process.cwd()): string {
  const explicit = project?.trim();
  if (explicit) {
    return explicit;
  }

  const fromSpaceEnv = process.env["SPACE_ID"]?.trim();
  if (fromSpaceEnv) {
    return fromSpaceEnv;
  }

  const manifest = findProjectManifest(cwd).manifest;
  if (manifest?.spaceId?.trim()) {
    return manifest.spaceId.trim();
  }

  throw new Error(
    "No space configured. Run `instafy space init` in this folder, set SPACE_ID, or pass --space.",
  );
}

function resolveControllerAuth(
  options: SecretsCommonOptions,
  retryCommand: string,
): ControllerAuth {
  const cwd = options.cwd ?? process.cwd();
  const controllerUrl = resolveControllerUrl({
    controllerUrl: options.controllerUrl ?? null,
    cwd,
  });

  const resolved = resolveUserAccessTokenWithSource({
    accessToken: options.accessToken ?? null,
    cwd,
  });

  if (!resolved.token) {
    throw formatAuthRequiredError({
      retryCommand,
      advancedHint:
        "pass --access-token, or set INSTAFY_ACCESS_TOKEN / SUPABASE_ACCESS_TOKEN",
    });
  }

  return {
    controllerUrl,
    accessToken: resolved.token,
    tokenSource: resolved.source,
    profile: resolved.profile,
    cwd,
  };
}

function normalizeSecretRecord(input: unknown): SecretRecord | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const id = typeof record["id"] === "string" ? record["id"].trim() : "";
  const name = typeof record["name"] === "string" ? record["name"].trim() : "";
  if (!id || !name) {
    return null;
  }

  const description =
    typeof record["description"] === "string" && record["description"].trim()
      ? record["description"].trim()
      : null;

  const toStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }
      if (out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
        continue;
      }
      out.push(trimmed);
    }
    return out;
  };

  const toMaybeString = (value: unknown): string | null => {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
  };

  return {
    id,
    name,
    description,
    agentIds: toStringArray(record["agentIds"]),
    agentHandles: toStringArray(record["agentHandles"]),
    lastUsedAt: toMaybeString(record["lastUsedAt"]),
    revokedAt: toMaybeString(record["revokedAt"]),
    createdAt: toMaybeString(record["createdAt"]),
    updatedAt: toMaybeString(record["updatedAt"]),
  };
}

function normalizeSecretList(payload: unknown): SecretRecord[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const out: SecretRecord[] = [];
  for (const item of payload) {
    const normalized = normalizeSecretRecord(item);
    if (!normalized) {
      continue;
    }
    out.push(normalized);
  }
  return out;
}

async function controllerJsonRequest(
  auth: ControllerAuth,
  retryCommand: string,
  params: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
  },
): Promise<unknown> {
  const url = `${auth.controllerUrl.replace(/\/$/, "")}${params.path}`;
  const headers = new Headers();
  headers.set("accept", "application/json");

  let bodyText: string | undefined;
  if (params.body !== undefined) {
    headers.set("content-type", "application/json");
    bodyText = JSON.stringify(params.body);
  }

  const init: RequestInit = {
    method: params.method,
    headers,
    body: bodyText,
  };

  const { response, accessToken } = await fetchWithControllerAuth({
    url,
    init,
    accessToken: auth.accessToken,
    tokenSource: auth.tokenSource,
    profile: auth.profile,
    cwd: auth.cwd,
  });
  auth.accessToken = accessToken;

  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw formatAuthRejectedError({
        status: response.status,
        responseBody: responseText,
        retryCommand,
        advancedHint:
          "pass --access-token, or set INSTAFY_ACCESS_TOKEN / SUPABASE_ACCESS_TOKEN",
      });
    }

    const suffix = responseText.trim() ? `: ${responseText.trim()}` : "";
    throw new Error(
      `Request failed (${response.status} ${response.statusText})${suffix}`,
    );
  }

  if (!responseText.trim()) {
    return null;
  }

  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }
}

function printSecretListHuman(projectId: string, secrets: SecretRecord[]) {
  console.log(kleur.green(`Space secrets (${projectId})`));
  if (secrets.length === 0) {
    console.log(kleur.yellow("No active secrets found."));
    return;
  }

  for (const secret of secrets) {
    const handles = secret.agentHandles.length > 0 ? secret.agentHandles.join(", ") : "octo";
    const suffix = secret.description ? ` — ${secret.description}` : "";
    console.log(`- ${kleur.cyan(secret.name)} (${secret.id}) [agents: ${handles}]${suffix}`);
  }
}

function printSecretHuman(secret: SecretRecord) {
  console.log(kleur.green(`Secret ${secret.name}`));
  console.log(`id: ${secret.id}`);
  console.log(`description: ${secret.description ?? ""}`);
  console.log(`agentHandles: ${secret.agentHandles.join(", ")}`);
  console.log(`lastUsedAt: ${secret.lastUsedAt ?? ""}`);
  console.log(`updatedAt: ${secret.updatedAt ?? ""}`);
}

async function fetchProjectSecrets(
  auth: ControllerAuth,
  projectId: string,
  retryCommand: string,
): Promise<SecretRecord[]> {
  const payload = await controllerJsonRequest(auth, retryCommand, {
    method: "GET",
    path: `/projects/${encodeURIComponent(projectId)}/secrets`,
  });
  return normalizeSecretList(payload);
}

function findSecretByNameOrId(secrets: SecretRecord[], nameOrId: string): SecretRecord | null {
  const needle = nameOrId.trim();
  if (!needle) {
    return null;
  }

  const byId = secrets.find((secret) => secret.id === needle);
  if (byId) {
    return byId;
  }

  const lowered = needle.toLowerCase();
  return secrets.find((secret) => secret.name.toLowerCase() === lowered) ?? null;
}

function resolveSecretValue(options: SecretsPutOptions): string {
  const inline = options.value;
  const fromStdin = Boolean(options.valueStdin);

  if (inline && fromStdin) {
    throw new Error("Use either --value or --value-stdin, not both.");
  }

  if (fromStdin) {
    const stdinValue = fs.readFileSync(0, "utf8");
    const trimmed = stdinValue.trim();
    if (!trimmed) {
      throw new Error("Secret value from stdin is empty.");
    }
    return trimmed;
  }

  const trimmedInline = inline?.trim() ?? "";
  if (!trimmedInline) {
    throw new Error("Secret value is required. Use --value <value> or --value-stdin.");
  }

  return trimmedInline;
}

export async function secretsList(options: SecretsListOptions) {
  const retryCommand = "instafy secrets list";
  const auth = resolveControllerAuth(options, retryCommand);
  const projectId = resolveProjectId(options.project, auth.cwd);
  const secrets = await fetchProjectSecrets(auth, projectId, retryCommand);

  if (options.json) {
    console.log(JSON.stringify({ projectId, secrets }, null, 2));
    return;
  }

  printSecretListHuman(projectId, secrets);
}

export async function secretsGet(options: SecretsGetOptions) {
  const retryCommand = "instafy secrets get";
  const auth = resolveControllerAuth(options, retryCommand);
  const projectId = resolveProjectId(options.project, auth.cwd);
  const secrets = await fetchProjectSecrets(auth, projectId, retryCommand);
  const found = findSecretByNameOrId(secrets, options.nameOrId);

  if (!found) {
    throw new Error(`Secret \"${options.nameOrId}\" not found in space ${projectId}.`);
  }

  if (options.json) {
    console.log(JSON.stringify({ projectId, secret: found }, null, 2));
    return;
  }

  printSecretHuman(found);
}

export async function secretsPut(options: SecretsPutOptions) {
  const retryCommand = "instafy secrets put";
  const auth = resolveControllerAuth(options, retryCommand);
  const projectId = resolveProjectId(options.project, auth.cwd);

  const name = options.name.trim();
  if (!name) {
    throw new Error("Secret name is required.");
  }

  const value = resolveSecretValue(options);
  const description = options.description?.trim() || undefined;

  const agentHandles = Array.from(
    new Set(
      (options.agentHandles ?? [])
        .map((entry) => entry.trim().replace(/^@+/, "").toLowerCase())
        .filter(Boolean),
    ),
  );

  const existing = findSecretByNameOrId(
    await fetchProjectSecrets(auth, projectId, retryCommand),
    name,
  );

  let id: string | null = existing?.id ?? null;
  if (existing) {
    await controllerJsonRequest(auth, retryCommand, {
      method: "PATCH",
      path: `/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(existing.id)}`,
      body: {
        value,
        ...(description !== undefined ? { description } : {}),
        ...(agentHandles.length > 0 ? { agentHandles } : {}),
      },
    });
  } else {
    const payload = await controllerJsonRequest(auth, retryCommand, {
      method: "POST",
      path: `/projects/${encodeURIComponent(projectId)}/secrets`,
      body: {
        name,
        value,
        ...(description ? { description } : {}),
        ...(agentHandles.length > 0 ? { agentHandles } : {}),
      },
    });

    id =
      payload && typeof payload === "object" && typeof (payload as Record<string, unknown>)["id"] === "string"
        ? ((payload as Record<string, unknown>)["id"] as string)
        : id;
  }

  if (options.json) {
    console.log(JSON.stringify({ projectId, id, name, mode: existing ? "updated" : "created" }, null, 2));
    return;
  }

  if (existing) {
    if (id) {
      console.log(kleur.green(`Updated secret ${name} (${id}) in space ${projectId}.`));
      return;
    }
    console.log(kleur.green(`Updated secret ${name} in space ${projectId}.`));
    return;
  }

  if (id) {
    console.log(kleur.green(`Saved secret ${name} (${id}) in space ${projectId}.`));
    return;
  }
  console.log(kleur.green(`Saved secret ${name} in space ${projectId}.`));
}

export async function secretsRevoke(options: SecretsRevokeOptions) {
  const retryCommand = "instafy secrets revoke";
  const auth = resolveControllerAuth(options, retryCommand);
  const projectId = resolveProjectId(options.project, auth.cwd);
  const secrets = await fetchProjectSecrets(auth, projectId, retryCommand);
  const found = findSecretByNameOrId(secrets, options.nameOrId);

  if (!found) {
    throw new Error(`Secret \"${options.nameOrId}\" not found in space ${projectId}.`);
  }

  await controllerJsonRequest(auth, retryCommand, {
    method: "DELETE",
    path: `/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(found.id)}`,
  });

  if (options.json) {
    console.log(JSON.stringify({ projectId, revoked: { id: found.id, name: found.name } }, null, 2));
    return;
  }

  console.log(kleur.green(`Revoked secret ${found.name} (${found.id}) from space ${projectId}.`));
}
