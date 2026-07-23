import {
  controllerJsonRequest,
} from "./client";
import type { CapabilityId } from "@instafy/sdk/capabilities";

export interface ControllerIntegrationProvider {
  id: string;
  displayName: string;
  description: string;
  authMethods: string[];
  defaultSecretNames: string[];
  defaultScopes: string[];
}

export interface ListIntegrationProvidersResult {
  success: boolean;
  providers: ControllerIntegrationProvider[];
  error?: string;
}

export interface ControllerProjectIntegration {
  id: string;
  projectId: string;
  provider: string;
  status: string;
  connectionType: string;
  credentialId: string | null;
  metadata: Record<string, unknown>;
  requiredScopes: string[];
  capabilities: CapabilityId[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListProjectIntegrationsResult {
  success: boolean;
  integrations: ControllerProjectIntegration[];
  error?: string;
}

export interface UpsertProjectIntegrationParams {
  status?: string;
  connectionType?: string;
  credentialId?: string | null;
  metadata?: Record<string, unknown>;
  requiredScopes?: string[];
  capabilities?: CapabilityId[];
  accessToken?: string | null;
}

export interface UpsertProjectIntegrationResult {
  success: boolean;
  integration?: ControllerProjectIntegration;
  error?: string;
}

export async function listIntegrationProviders(params?: {
  accessToken?: string | null;
}): Promise<ListIntegrationProvidersResult> {
  const response = await controllerJsonRequest<unknown>({
    path: "/integrations/providers",
    accessToken: params?.accessToken ?? null,
    fallbackError: "Unable to load integration providers",
  });

  if (!response.success) {
    return { success: false, providers: [], error: response.error };
  }

  if (!Array.isArray(response.value)) {
    return {
      success: false,
      providers: [],
      error: "Controller response missing integration providers list.",
    };
  }

  const providers: ControllerIntegrationProvider[] = response.value
    .map((entry: unknown) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id) {
        return null;
      }
      const displayName =
        typeof record.displayName === "string" && record.displayName.trim().length > 0
          ? record.displayName.trim()
          : id;
      const description =
        typeof record.description === "string" ? record.description.trim() : "";
      const authMethods = Array.isArray(record.authMethods)
        ? record.authMethods
            .filter((value: unknown): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : [];
      const defaultSecretNames = Array.isArray(record.defaultSecretNames)
        ? record.defaultSecretNames
            .filter((value: unknown): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : [];
      const defaultScopes = Array.isArray(record.defaultScopes)
        ? record.defaultScopes
            .filter((value: unknown): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : [];

      return {
        id,
        displayName,
        description,
        authMethods,
        defaultSecretNames,
        defaultScopes,
      } satisfies ControllerIntegrationProvider;
    })
    .filter((entry): entry is ControllerIntegrationProvider => Boolean(entry));

  return { success: true, providers };
}

export async function listProjectIntegrations(
  projectId: string,
  params?: { accessToken?: string | null },
): Promise<ListProjectIntegrationsResult> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    return { success: false, integrations: [], error: "Missing project id." };
  }

  const response = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(normalizedProjectId)}/integrations`,
    accessToken: params?.accessToken ?? null,
    fallbackError: "Unable to load project integrations",
  });

  if (!response.success) {
    return { success: false, integrations: [], error: response.error };
  }

  if (!Array.isArray(response.value)) {
    return {
      success: false,
      integrations: [],
      error: "Controller response missing integrations list.",
    };
  }

  const integrations = response.value
    .map((entry: unknown) => normalizeProjectIntegrationRecord(entry))
    .filter((entry): entry is ControllerProjectIntegration => Boolean(entry));

  return { success: true, integrations };
}

export async function upsertProjectIntegration(
  projectId: string,
  provider: string,
  params: UpsertProjectIntegrationParams,
): Promise<UpsertProjectIntegrationResult> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    return { success: false, error: "Missing project id." };
  }

  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider) {
    return { success: false, error: "Missing integration provider." };
  }

  const payload: Record<string, unknown> = {};
  if (params.status && params.status.trim().length > 0) {
    payload.status = params.status.trim();
  }
  if (params.connectionType && params.connectionType.trim().length > 0) {
    payload.connectionType = params.connectionType.trim();
  }
  if (typeof params.credentialId === "string" && params.credentialId.trim().length > 0) {
    payload.credentialId = params.credentialId.trim();
  }
  if (params.metadata && typeof params.metadata === "object") {
    payload.metadata = params.metadata;
  }
  if (Array.isArray(params.requiredScopes)) {
    payload.requiredScopes = params.requiredScopes;
  }
  if (Array.isArray(params.capabilities)) {
    payload.capabilities = params.capabilities;
  }

  const response = await controllerJsonRequest<unknown>({
    path: `/projects/${encodeURIComponent(normalizedProjectId)}/integrations/${encodeURIComponent(normalizedProvider)}`,
    method: "PUT",
    accessToken: params.accessToken ?? null,
    body: payload,
    fallbackError: "Unable to update integration",
  });

  if (!response.success) {
    return { success: false, error: response.error };
  }

  const integration = normalizeProjectIntegrationRecord(response.value);
  if (!integration) {
    return { success: false, error: "Controller response missing integration payload." };
  }

  return { success: true, integration };
}

function normalizeProjectIntegrationRecord(value: unknown): ControllerProjectIntegration | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const status = typeof record.status === "string" ? record.status.trim() : "";
  const connectionType =
    typeof record.connectionType === "string" ? record.connectionType.trim() : "";

  if (!id || !projectId || !provider || !status || !connectionType) {
    return null;
  }

  const metadataValue = record.metadata;
  const metadata =
    metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
      ? (metadataValue as Record<string, unknown>)
      : {};

  const requiredScopes = Array.isArray(record.requiredScopes)
    ? record.requiredScopes
        .filter((entry: unknown): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities
        .filter((entry: unknown): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  return {
    id,
    projectId,
    provider,
    status,
    connectionType,
    credentialId: typeof record.credentialId === "string" ? record.credentialId : null,
    metadata,
    requiredScopes,
    capabilities,
    createdBy: typeof record.createdBy === "string" ? record.createdBy : null,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}
