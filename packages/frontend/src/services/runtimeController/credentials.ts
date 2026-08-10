import {
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

export interface CreateCodexCredentialParams {
  authJson: unknown;
  label?: string;
  makeDefault?: boolean;
  provider?: string;
  accessToken?: string | null;
}

export interface CreateCodexCredentialResult {
  success: boolean;
  credentialId?: string;
  kind?: string;
  isDefault?: boolean;
  error?: string;
}

export interface ControllerCredentialListItem {
  id: string;
  kind: string;
  label: string | null;
  isDefault: boolean;
  metadata: unknown;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListMyCredentialsResult {
  success: boolean;
  credentials: ControllerCredentialListItem[];
  error?: string;
}

export interface SetDefaultCredentialResult {
  success: boolean;
  credentialId?: string;
  kind?: string;
  isDefault?: boolean;
  error?: string;
}

export interface ClearDefaultCredentialResult {
  success: boolean;
  error?: string;
}

export interface RevokeCredentialResult {
  success: boolean;
  error?: string;
}

export type DeviceAuthProvider = "codex" | "github" | "gemini";
export type GeminiOauthMode = "code_assist_cli" | "code_assist" | "api";

export interface StartDeviceAuthResult {
  success: boolean;
  sessionId?: string;
  provider?: string;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  pollIntervalSeconds?: number;
  error?: string;
}

export interface DeviceAuthStatusResult {
  success: boolean;
  sessionId?: string;
  provider?: string;
  status?: "pending" | "completed" | "failed" | "cancelled";
  credentialId?: string | null;
  error?: string | null;
}

export interface CancelDeviceAuthResult {
  success: boolean;
  error?: string;
}

export async function createCodexCredential(
  params: CreateCodexCredentialParams,
): Promise<CreateCodexCredentialResult> {
  if (!runtimeControllerEnabled) {
    return {
      success: false,
      error:
        "Runtime controller is not configured. Set VITE_CONTROLLER_URL to enable BYOC credentials.",
    };
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/me/credentials/codex`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        authJson: params.authJson,
        label: params.label,
        // Let the controller decide whether this should become default when the caller does not care.
        // This prevents new connections from unexpectedly overriding an existing default credential.
        makeDefault: params.makeDefault,
        provider: params.provider,
      }),
    });

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to save Codex credentials",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const credentialId =
      typeof payload.credentialId === "string" ? payload.credentialId : undefined;
    const kind = typeof payload.kind === "string" ? payload.kind : undefined;
    const isDefault =
      typeof payload.isDefault === "boolean" ? payload.isDefault : undefined;

    if (!credentialId) {
      return {
        success: false,
        error: "Controller response missing credentialId.",
      };
    }

    return { success: true, credentialId, kind, isDefault };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to save credentials: ${message}` };
  }
}

export interface CredentialTestResult {
  success: boolean;
  ok?: boolean;
  provider?: string | null;
  upstreamEndpoint?: string | null;
  model?: string | null;
  output?: string | null;
  elapsedMs?: number | null;
  error?: string;
}

export async function testMyCredential(
  credentialId: string,
  params?: { accessToken?: string | null },
): Promise<CredentialTestResult> {
  if (!runtimeControllerEnabled) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const normalizedId = credentialId.trim();
  if (!normalizedId) {
    return { success: false, error: "Missing credential id." };
  }

  const requestContext = await resolveControllerRequestContext(params?.accessToken ?? null);
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/me/credentials/${encodeURIComponent(normalizedId)}/test`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvedAccessToken}`,
          accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to test credential",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return {
      success: true,
      ok: typeof payload.ok === "boolean" ? payload.ok : undefined,
      provider: typeof payload.provider === "string" ? payload.provider : null,
      upstreamEndpoint:
        typeof payload.upstreamEndpoint === "string" ? payload.upstreamEndpoint : null,
      model: typeof payload.model === "string" ? payload.model : null,
      output: typeof payload.output === "string" ? payload.output : null,
      elapsedMs: typeof payload.elapsedMs === "number" ? payload.elapsedMs : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to test credential: ${message}` };
  }
}

export async function listMyCredentials(params?: {
  accessToken?: string | null;
}): Promise<ListMyCredentialsResult> {
  if (!runtimeControllerEnabled) {
    return {
      success: false,
      credentials: [],
      error: "Runtime controller is not configured.",
    };
  }

  const requestContext = await resolveControllerRequestContext(
    params?.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, credentials: [], error: "Missing controller session token." };
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/me/credentials`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to load credentials",
        requestContext,
      );
      return { success: false, credentials: [], error: errorMessage };
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      return {
        success: false,
        credentials: [],
        error: "Controller response missing credentials list.",
      };
    }

    const credentials = payload.reduce<ControllerCredentialListItem[]>((result, entry: unknown) => {
        if (!entry || typeof entry !== "object") {
          return result;
        }
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        if (!id) {
          return result;
        }
        result.push({
          id,
          kind: typeof record.kind === "string" ? record.kind : "unknown",
          label: typeof record.label === "string" ? record.label : null,
          isDefault: Boolean(record.isDefault),
          metadata: record.metadata ?? null,
          lastUsedAt: typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
          revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
        });
        return result;
      }, []);

    return { success: true, credentials };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, credentials: [], error: `Unable to load credentials: ${message}` };
  }
}

export async function setDefaultCredential(
  credentialId: string,
  params?: { accessToken?: string | null },
): Promise<SetDefaultCredentialResult> {
  if (!runtimeControllerEnabled) {
    return {
      success: false,
      error: "Runtime controller is not configured.",
    };
  }

  const normalizedId = credentialId.trim();
  if (!normalizedId) {
    return { success: false, error: "Missing credential id." };
  }

  const requestContext = await resolveControllerRequestContext(
    params?.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/me/credentials/${encodeURIComponent(normalizedId)}/default`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvedAccessToken}`,
          accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to update default credential",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const resolvedCredentialId =
      typeof payload.credentialId === "string" ? payload.credentialId : undefined;
    const kind = typeof payload.kind === "string" ? payload.kind : undefined;
    const isDefault =
      typeof payload.isDefault === "boolean" ? payload.isDefault : undefined;

    if (!resolvedCredentialId) {
      return {
        success: false,
        error: "Controller response missing credentialId.",
      };
    }

    return { success: true, credentialId: resolvedCredentialId, kind, isDefault };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to update default credential: ${message}` };
  }
}

export async function clearDefaultCredential(params?: {
  accessToken?: string | null;
}): Promise<ClearDefaultCredentialResult> {
  if (!runtimeControllerEnabled) {
    return {
      success: false,
      error: "Runtime controller is not configured.",
    };
  }

  const requestContext = await resolveControllerRequestContext(
    params?.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/me/credentials/default`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to switch to managed AI",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to switch to managed AI: ${message}` };
  }
}

export async function startDeviceAuth(
  provider: DeviceAuthProvider,
  params?: {
    accessToken?: string | null;
    geminiOauthMode?: GeminiOauthMode | null;
    label?: string | null;
  },
): Promise<StartDeviceAuthResult> {
  if (!runtimeControllerEnabled) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const requestContext = await resolveControllerRequestContext(params?.accessToken ?? null);
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    let startUrl = `${requestContext.baseUrl}/me/auth/device/${encodeURIComponent(provider)}/start`;
    if (provider === "gemini" && (params?.geminiOauthMode || params?.label)) {
      const search = new URLSearchParams();
      if (params?.geminiOauthMode) {
        search.set("oauthMode", params.geminiOauthMode);
      }
      const label = (params?.label ?? "").trim();
      if (label.length > 0) {
        search.set("label", label);
      }
      startUrl = `${startUrl}?${search.toString()}`;
    }

    const response = await fetch(startUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to start device login",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return {
      success: true,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
      provider: typeof payload.provider === "string" ? payload.provider : undefined,
      verificationUrl: typeof payload.verificationUrl === "string" ? payload.verificationUrl : undefined,
      userCode: typeof payload.userCode === "string" ? payload.userCode : undefined,
      expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : undefined,
      pollIntervalSeconds: typeof payload.pollIntervalSeconds === "number" ? payload.pollIntervalSeconds : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to start device login: ${message}` };
  }
}

export async function getDeviceAuthStatus(
  sessionId: string,
  params?: { accessToken?: string | null },
): Promise<DeviceAuthStatusResult> {
  if (!runtimeControllerEnabled) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const normalizedId = sessionId.trim();
  if (!normalizedId) {
    return { success: false, error: "Missing device auth session id." };
  }

  const requestContext = await resolveControllerRequestContext(params?.accessToken ?? null);
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/me/auth/device/${encodeURIComponent(normalizedId)}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to check device login",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const status = typeof payload.status === "string" ? payload.status : undefined;
    const normalizedStatus =
      status === "pending" || status === "completed" || status === "failed" || status === "cancelled"
        ? status
        : undefined;

    return {
      success: true,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
      provider: typeof payload.provider === "string" ? payload.provider : undefined,
      status: normalizedStatus,
      credentialId: typeof payload.credentialId === "string" ? payload.credentialId : null,
      error: typeof payload.error === "string" ? payload.error : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to check device login: ${message}` };
  }
}

export async function cancelDeviceAuth(
  sessionId: string,
  params?: { accessToken?: string | null },
): Promise<CancelDeviceAuthResult> {
  if (!runtimeControllerEnabled) {
    return { success: false, error: "Runtime controller is not configured." };
  }

  const normalizedId = sessionId.trim();
  if (!normalizedId) {
    return { success: false, error: "Missing device auth session id." };
  }

  const requestContext = await resolveControllerRequestContext(params?.accessToken ?? null);
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/me/auth/device/${encodeURIComponent(normalizedId)}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        accept: "application/json",
      },
    });

    if (response.status === 204) {
      return { success: true };
    }

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to cancel device login",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to cancel device login: ${message}` };
  }
}

export async function revokeMyCredential(
  credentialId: string,
  params?: { accessToken?: string | null },
): Promise<RevokeCredentialResult> {
  if (!runtimeControllerEnabled) {
    return {
      success: false,
      error: "Runtime controller is not configured.",
    };
  }

  const normalizedId = credentialId.trim();
  if (!normalizedId) {
    return { success: false, error: "Missing credential id." };
  }

  const requestContext = await resolveControllerRequestContext(
    params?.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/me/credentials/${encodeURIComponent(normalizedId)}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${resolvedAccessToken}`,
          accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to revoke credential",
        requestContext,
      );
      return { success: false, error: errorMessage };
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Unable to revoke credential: ${message}` };
  }
}

export interface CredentialRequirementsResult {
  success: boolean;
  requiresUserCredentials: boolean;
  proxyBackend: string | null;
  hasDefaultCredential: boolean;
  managedAi: {
    enabled: boolean;
    available: boolean;
    label: string;
    creditBurnAmount: number;
    dailyPromptLimit: number;
    dailyPromptsUsed: number;
    remainingPrompts: number | null;
  } | null;
  error?: string;
}

export async function getCredentialRequirements(params?: {
  accessToken?: string | null;
}): Promise<CredentialRequirementsResult> {
  if (!runtimeControllerEnabled) {
    return {
      success: false,
      requiresUserCredentials: false,
      proxyBackend: null,
      hasDefaultCredential: false,
      managedAi: null,
      error: "Runtime controller is not configured.",
    };
  }

  const requestContext = await resolveControllerRequestContext(
    params?.accessToken ?? null,
  );
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return {
      success: false,
      requiresUserCredentials: false,
      proxyBackend: null,
      hasDefaultCredential: false,
      managedAi: null,
      error: "Missing controller session token.",
    };
  }

  try {
    const response = await fetch(`${requestContext.baseUrl}/me/credentials/requirements`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${resolvedAccessToken}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to load credential requirements",
        requestContext,
      );
      return {
        success: false,
        requiresUserCredentials: false,
        proxyBackend: null,
        hasDefaultCredential: false,
        managedAi: null,
        error: errorMessage,
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const managedAiPayload =
      payload.managedAi && typeof payload.managedAi === "object"
        ? (payload.managedAi as Record<string, unknown>)
        : null;
    return {
      success: true,
      requiresUserCredentials: Boolean(payload.requiresUserCredentials),
      proxyBackend: typeof payload.proxyBackend === "string" ? payload.proxyBackend : null,
      hasDefaultCredential: Boolean(payload.hasDefaultCredential),
      managedAi: managedAiPayload
        ? {
            enabled: Boolean(managedAiPayload.enabled),
            available: Boolean(managedAiPayload.available),
            label:
              typeof managedAiPayload.label === "string" && managedAiPayload.label.trim().length > 0
                ? managedAiPayload.label
                : "Instafy AI",
            creditBurnAmount:
              typeof managedAiPayload.creditBurnAmount === "number"
                ? managedAiPayload.creditBurnAmount
                : 0,
            dailyPromptLimit:
              typeof managedAiPayload.dailyPromptLimit === "number"
                ? managedAiPayload.dailyPromptLimit
                : 0,
            dailyPromptsUsed:
              typeof managedAiPayload.dailyPromptsUsed === "number"
                ? managedAiPayload.dailyPromptsUsed
                : 0,
            remainingPrompts:
              typeof managedAiPayload.remainingPrompts === "number"
                ? managedAiPayload.remainingPrompts
                : null,
          }
        : null,
      error: typeof payload.error === "string" ? payload.error : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      requiresUserCredentials: false,
      proxyBackend: null,
      hasDefaultCredential: false,
      managedAi: null,
      error: `Unable to load credential requirements: ${message}`,
    };
  }
}
