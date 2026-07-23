import {
  controllerBaseUrl,
  readControllerError,
  resolveControllerAccessToken,
  runtimeControllerEnabled,
} from "./core";

export interface ControllerProjectSecret {
  id: string;
  name: string;
  description: string | null;
  agentIds: string[];
  agentHandles: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListProjectSecretsResult {
  success: boolean;
  secrets: ControllerProjectSecret[];
  error?: string;
}

export async function listProjectSecrets(
  projectId: string,
  params?: { accessToken?: string | null },
): Promise<ListProjectSecretsResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, secrets: [], error: "Runtime controller is not configured." };
  }

  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    return { success: false, secrets: [], error: "Missing project id." };
  }

  const accessToken = await resolveControllerAccessToken(params?.accessToken ?? null);
  if (!accessToken) {
    return { success: false, secrets: [], error: "Missing controller session token." };
  }

  try {
    const response = await fetch(
      `${controllerBaseUrl}/projects/${encodeURIComponent(normalizedProjectId)}/secrets`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(response, "Unable to load secrets");
      return { success: false, secrets: [], error: errorMessage };
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      return { success: false, secrets: [], error: "Controller response missing secrets list." };
    }

    const secrets: ControllerProjectSecret[] = payload
      .map((entry: unknown) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        const name = typeof record.name === "string" ? record.name : "";
        if (!id || !name) {
          return null;
        }
        return {
          id,
          name,
          description: typeof record.description === "string" ? record.description : null,
          agentIds: Array.isArray(record.agentIds)
            ? record.agentIds.filter((value: unknown): value is string => typeof value === "string")
            : [],
          agentHandles: Array.isArray(record.agentHandles)
            ? record.agentHandles.filter((value: unknown): value is string => typeof value === "string")
            : [],
          lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
          revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
        };
      })
      .filter((entry): entry is ControllerProjectSecret => Boolean(entry));

    return { success: true, secrets };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, secrets: [], error: `Unable to load secrets: ${message}` };
  }
}

export interface CreateProjectSecretParams {
  name: string;
  value: string;
  description?: string | null;
  agentHandles?: string[];
  accessToken?: string | null;
}

export interface CreateProjectSecretResult {
  success: boolean;
  secretId?: string;
  error?: string;
}

export async function createProjectSecret(
  projectId: string,
  params: CreateProjectSecretParams,
): Promise<CreateProjectSecretResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    return { success: false, error: "Missing project id." };
  }

  const accessToken = await resolveControllerAccessToken(params.accessToken ?? null);
  if (!accessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(
      `${controllerBaseUrl}/projects/${encodeURIComponent(normalizedProjectId)}/secrets`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          name: params.name,
          value: params.value,
          description: params.description ?? undefined,
          agentHandles: params.agentHandles ?? [],
        }),
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(response, "Unable to create secret");
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const secretId = typeof payload.id === "string" ? payload.id : undefined;
    if (!secretId) {
      return { success: false, error: "Controller response missing secret id." };
    }
    return { success: true, secretId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to create secret: ${message}` };
  }
}

export interface UpdateProjectSecretParams {
  description?: string | null;
  value?: string;
  agentHandles?: string[];
  accessToken?: string | null;
}

export interface UpdateProjectSecretResult {
  success: boolean;
  secret?: ControllerProjectSecret;
  error?: string;
}

export async function updateProjectSecret(
  projectId: string,
  secretId: string,
  params: UpdateProjectSecretParams,
): Promise<UpdateProjectSecretResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const normalizedProjectId = projectId.trim();
  const normalizedSecretId = secretId.trim();
  if (!normalizedProjectId) {
    return { success: false, error: "Missing project id." };
  }
  if (!normalizedSecretId) {
    return { success: false, error: "Missing secret id." };
  }

  const accessToken = await resolveControllerAccessToken(params.accessToken ?? null);
  if (!accessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(
      `${controllerBaseUrl}/projects/${encodeURIComponent(normalizedProjectId)}/secrets/${encodeURIComponent(
        normalizedSecretId,
      )}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.value ? { value: params.value } : {}),
          ...(params.agentHandles ? { agentHandles: params.agentHandles } : {}),
        }),
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(response, "Unable to update secret");
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as unknown;
    const record =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    const secret = record
      ? ({
          id: typeof record.id === "string" ? record.id : normalizedSecretId,
          name: typeof record.name === "string" ? record.name : "",
          description: typeof record.description === "string" ? record.description : null,
          agentIds: Array.isArray(record.agentIds)
            ? record.agentIds.filter((value: unknown): value is string => typeof value === "string")
            : [],
          agentHandles: Array.isArray(record.agentHandles)
            ? record.agentHandles.filter((value: unknown): value is string => typeof value === "string")
            : [],
          lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
          revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
        } satisfies ControllerProjectSecret)
      : null;

    if (!secret?.id || !secret?.name) {
      return { success: false, error: "Controller response missing updated secret." };
    }

    return { success: true, secret };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to update secret: ${message}` };
  }
}

export interface RevokeProjectSecretResult {
  success: boolean;
  error?: string;
}

export async function revokeProjectSecret(
  projectId: string,
  secretId: string,
  params?: { accessToken?: string | null },
): Promise<RevokeProjectSecretResult> {
  if (!runtimeControllerEnabled || !controllerBaseUrl) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const normalizedProjectId = projectId.trim();
  const normalizedSecretId = secretId.trim();
  if (!normalizedProjectId) {
    return { success: false, error: "Missing project id." };
  }
  if (!normalizedSecretId) {
    return { success: false, error: "Missing secret id." };
  }

  const accessToken = await resolveControllerAccessToken(params?.accessToken ?? null);
  if (!accessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(
      `${controllerBaseUrl}/projects/${encodeURIComponent(normalizedProjectId)}/secrets/${encodeURIComponent(
        normalizedSecretId,
      )}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(response, "Unable to revoke secret");
      return { success: false, error: errorMessage };
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to revoke secret: ${message}` };
  }
}
