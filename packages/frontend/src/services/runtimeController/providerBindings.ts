import type {
  ProjectContentCapability,
  ProviderProjectBinding,
  ProviderProjectBindingStatus,
  ProviderProjectBindingStore,
} from "@instafy/sdk/provider-project-binding";
import { fetchLocalWorkspacePresence } from "./origins";
import {
  readWorkspaceFileFromController,
  writeWorkspaceFileToController,
} from "./workspaceFiles";

export const PROVIDER_BINDINGS_PATH = ".instafy/provider-bindings.json";

type WorkspaceAccessParams = {
  projectId: string;
  accessToken?: string | null;
  runtimeId?: string | null;
};

export type UpsertProjectProviderBindingParams = WorkspaceAccessParams & {
  providerId: string;
  purpose?: string | null;
  grantedCapabilities: ProjectContentCapability[];
  grantedPrefix?: string | null;
  rootUri?: string | null;
};

export type RevokeProjectProviderBindingParams = WorkspaceAccessParams & {
  providerId: string;
};

function createEmptyStore(): ProviderProjectBindingStore {
  return {
    version: 1,
    bindings: {},
  };
}

async function readProjectProviderBindingStoreOrEmpty(
  params: WorkspaceAccessParams,
): Promise<ProviderProjectBindingStore> {
  try {
    return await readProjectProviderBindingStore(params);
  } catch {
    return createEmptyStore();
  }
}

function normalizeCapability(value: unknown): ProjectContentCapability | null {
  return value === "project_content_read" || value === "project_content_write" ? value : null;
}

function normalizeCapabilities(values: unknown): ProjectContentCapability[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const allowed = new Set<ProjectContentCapability>();
  for (const value of values) {
    const normalized = normalizeCapability(value);
    if (normalized) {
      allowed.add(normalized);
    }
  }
  const result: ProjectContentCapability[] = [];
  if (allowed.has("project_content_read")) {
    result.push("project_content_read");
  }
  if (allowed.has("project_content_write")) {
    result.push("project_content_write");
  }
  return result;
}

function deriveBindingStatus(capabilities: ProjectContentCapability[]): ProviderProjectBindingStatus {
  if (capabilities.includes("project_content_write")) {
    return "bound_read_write";
  }
  if (capabilities.includes("project_content_read")) {
    return "bound_read_only";
  }
  return "unbound";
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBinding(providerId: string, value: unknown): ProviderProjectBinding | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const normalizedProviderId = normalizeString(record.providerId) ?? providerId.trim();
  if (!normalizedProviderId) {
    return null;
  }
  const grantedCapabilities = normalizeCapabilities(record.grantedCapabilities);
  const createdAt = normalizeString(record.createdAt) ?? new Date(0).toISOString();
  const updatedAt = normalizeString(record.updatedAt) ?? createdAt;

  return {
    providerId: normalizedProviderId,
    projectId: normalizeString(record.projectId),
    rootUri: normalizeString(record.rootUri),
    grantedCapabilities,
    grantedPrefix: normalizeString(record.grantedPrefix),
    purpose: normalizeString(record.purpose),
    status: deriveBindingStatus(grantedCapabilities),
    createdAt,
    updatedAt,
  };
}

function normalizeBindingStore(value: unknown): ProviderProjectBindingStore {
  if (!value || typeof value !== "object") {
    throw new Error("Provider bindings file must contain a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const bindingsRecord =
    record.bindings && typeof record.bindings === "object" ? (record.bindings as Record<string, unknown>) : {};
  const bindings: Record<string, ProviderProjectBinding> = {};

  for (const [providerId, bindingValue] of Object.entries(bindingsRecord)) {
    const normalized = normalizeBinding(providerId, bindingValue);
    if (normalized) {
      bindings[normalized.providerId] = normalized;
    }
  }

  return {
    version: 1,
    bindings,
  };
}

function sortBindings(bindings: Record<string, ProviderProjectBinding>): Record<string, ProviderProjectBinding> {
  return Object.fromEntries(
    Object.entries(bindings).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildStoreText(store: ProviderProjectBindingStore): string {
  return `${JSON.stringify(
    {
      version: 1,
      bindings: sortBindings(store.bindings),
    },
    null,
    2,
  )}\n`;
}

function workspacePathToFileUri(value: string): string {
  const normalized = value.replace(/\\/g, "/").trim();
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }
  return `file://${encodeURI(`/${normalized}`)}`;
}

async function resolveProjectRootUri(params: WorkspaceAccessParams): Promise<string | null> {
  const localWorkspace = await fetchLocalWorkspacePresence({
    projectId: params.projectId,
    accessToken: params.accessToken ?? null,
  });
  const workspacePath = normalizeString(localWorkspace?.path);
  return workspacePath ? workspacePathToFileUri(workspacePath) : null;
}

async function writeBindingStore(
  params: WorkspaceAccessParams,
  store: ProviderProjectBindingStore,
): Promise<ProviderProjectBindingStore | null> {
  const result = await writeWorkspaceFileToController({
    projectId: params.projectId,
    path: PROVIDER_BINDINGS_PATH,
    content: buildStoreText(store),
    accessToken: params.accessToken ?? null,
    runtimeId: params.runtimeId ?? null,
  });
  return result?.ok ? store : null;
}

export async function readProjectProviderBindingStore(
  params: WorkspaceAccessParams,
): Promise<ProviderProjectBindingStore> {
  const response = await readWorkspaceFileFromController({
    projectId: params.projectId,
    path: PROVIDER_BINDINGS_PATH,
    accessToken: params.accessToken ?? null,
    runtimeId: params.runtimeId ?? null,
  });

  if (!response) {
    return createEmptyStore();
  }
  if (!response.isText || typeof response.contentText !== "string") {
    throw new Error("Provider bindings file must be UTF-8 text.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.contentText);
  } catch (error) {
    throw new Error(
      `Provider bindings file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return normalizeBindingStore(parsed);
}

export async function upsertProjectProviderBinding(
  params: UpsertProjectProviderBindingParams,
): Promise<ProviderProjectBinding | null> {
  const providerId = params.providerId.trim();
  if (!providerId) {
    throw new Error("Provider id is required.");
  }

  const grantedCapabilities = normalizeCapabilities(params.grantedCapabilities);
  if (grantedCapabilities.length === 0) {
    throw new Error("At least one project content capability is required.");
  }

  const store = await readProjectProviderBindingStoreOrEmpty(params);
  const existing = store.bindings[providerId] ?? null;
  const timestamp = new Date().toISOString();
  const rootUri =
    normalizeString(params.rootUri) ??
    normalizeString(existing?.rootUri) ??
    (await resolveProjectRootUri(params));

  const binding: ProviderProjectBinding = {
    providerId,
    projectId: params.projectId.trim(),
    rootUri,
    grantedCapabilities,
    grantedPrefix: normalizeString(params.grantedPrefix),
    purpose: normalizeString(params.purpose),
    status: deriveBindingStatus(grantedCapabilities),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  store.bindings[providerId] = binding;
  const saved = await writeBindingStore(params, store);
  return saved ? binding : null;
}

export async function revokeProjectProviderBinding(
  params: RevokeProjectProviderBindingParams,
): Promise<boolean> {
  const providerId = params.providerId.trim();
  if (!providerId) {
    throw new Error("Provider id is required.");
  }

  const store = await readProjectProviderBindingStoreOrEmpty(params);
  if (!store.bindings[providerId]) {
    return true;
  }

  delete store.bindings[providerId];
  const saved = await writeBindingStore(params, store);
  return Boolean(saved);
}
