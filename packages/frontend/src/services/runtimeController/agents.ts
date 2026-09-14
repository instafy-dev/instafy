import { createControllerReadBudget } from "./readBudget";
import { readControllerError, resolveControllerRequestContext } from "./core";
import {
  controllerJsonRequest,
} from "./client";

export type { ControllerAgentProfile } from "@instafy/sdk/agents";
import {
  type ControllerAgentProfile, type CreateMyAgentInput, type UpdateMyAgentInput,
  type ControllerPublicAgentProfile, getProjectAgentProfile,
} from "@instafy/sdk/agents";

export async function getPublicAgentProfile(projectId: string, agentId: string, params?: { accessToken?: string | null; signal?: AbortSignal }) {
  const budget = createControllerReadBudget(params?.signal);
  try {
    const context = await budget.wait(() => resolveControllerRequestContext(params?.accessToken ?? null));
    if (!context.baseUrl || !context.accessToken) throw new Error("Sign in to view this profile.");
    const profile = await getProjectAgentProfile(async (path, init) => {
      const response = await budget.wait(() => fetch(`${context.baseUrl}${path}`, {
        method: init.method, headers: { authorization: `Bearer ${context.accessToken}`, accept: "application/json" },
        signal: budget.signal,
      }));
      if (!response.ok) throw new Error(await budget.wait(() => readControllerError(response, "Unable to load agent profile.", context)));
      const value = await budget.wait(() => response.json()) as ControllerPublicAgentProfile;
      if (!value || value.id !== agentId || typeof value.handle !== "string" || typeof value.avatarSeed !== "string"
        || ![value.displayName, value.bio].every((field) => field === null || typeof field === "string")) {
        throw new Error("Invalid agent profile response.");
      }
      return { id: value.id, handle: value.handle, displayName: value.displayName, avatarSeed: value.avatarSeed, bio: value.bio };
    }, { projectId, agentId, signal: budget.signal });
    return { success: true as const, value: profile };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error.message : "Unable to load agent profile." };
  } finally {
    budget.dispose();
  }
}

export interface ListMyAgentsResult {
  success: boolean;
  agents: ControllerAgentProfile[];
  error?: string;
}

export interface CreateMyAgentResult {
  success: boolean;
  agent?: ControllerAgentProfile;
  error?: string;
}

export interface UpdateMyAgentResult {
  success: boolean;
  agent?: ControllerAgentProfile;
  error?: string;
}

export interface DeleteMyAgentResult {
  success: boolean;
  error?: string;
}

function mapAgentPayload(payload: Record<string, unknown>): ControllerAgentProfile | null {
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) {
    return null;
  }
  const handle = typeof payload.handle === "string" ? payload.handle : "";
  if (!handle) {
    return null;
  }
  return {
    id,
    handle,
    displayName: typeof payload.displayName === "string" ? payload.displayName : null,
    description: typeof payload.description === "string" ? payload.description : null,
    bio: typeof payload.bio === "string" ? payload.bio : null,
    avatarSeed: typeof payload.avatarSeed === "string" ? payload.avatarSeed : id,
    provider: typeof payload.provider === "string" ? payload.provider : "openai",
    model: typeof payload.model === "string" ? payload.model : null,
    reasoningEffort: typeof payload.reasoningEffort === "string" ? payload.reasoningEffort : null,
    credentialId: typeof payload.credentialId === "string" ? payload.credentialId : null,
    runtimeId: typeof payload.runtimeId === "string" ? payload.runtimeId : null,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : "",
    updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : "",
  };
}

export async function listMyAgents(params?: {
  accessToken?: string | null;
  projectId?: string | null;
}): Promise<ListMyAgentsResult> {
  const response = await controllerJsonRequest<unknown>({
    path: "/me/agents",
    accessToken: params?.accessToken ?? null,
    searchParams: {
      projectId: params?.projectId ?? null,
    },
    fallbackError: "Unable to load agents",
  });

  if (!response.success) {
    return { success: false, agents: [], error: response.error };
  }

  if (!Array.isArray(response.value)) {
    return { success: false, agents: [], error: "Controller response missing agents list." };
  }

  const agents = response.value
    .map((entry) => (entry && typeof entry === "object" ? mapAgentPayload(entry as Record<string, unknown>) : null))
    .filter((entry): entry is ControllerAgentProfile => Boolean(entry));

  return { success: true, agents };
}

export async function createMyAgent(
  body: CreateMyAgentInput,
  params?: { accessToken?: string | null }
): Promise<CreateMyAgentResult> {
  const response = await controllerJsonRequest<Record<string, unknown>>({
    path: "/me/agents",
    method: "POST",
    accessToken: params?.accessToken ?? null,
    body,
    fallbackError: "Unable to create agent",
  });

  if (!response.success) {
    return { success: false, error: response.error };
  }

  const agent = mapAgentPayload(response.value);
  if (!agent) {
    return { success: false, error: "Controller response missing agent." };
  }

  return { success: true, agent };
}

export async function updateMyAgent(
  agentId: string,
  body: UpdateMyAgentInput,
  params?: { accessToken?: string | null }
): Promise<UpdateMyAgentResult> {
  const normalizedId = agentId.trim();
  if (!normalizedId) {
    return { success: false, error: "Missing agent id." };
  }

  const response = await controllerJsonRequest<Record<string, unknown>>({
    path: `/me/agents/${encodeURIComponent(normalizedId)}`,
    method: "PATCH",
    accessToken: params?.accessToken ?? null,
    body,
    fallbackError: "Unable to update agent",
  });

  if (!response.success) {
    return { success: false, error: response.error };
  }

  const agent = mapAgentPayload(response.value);
  if (!agent) {
    return { success: false, error: "Controller response missing agent." };
  }

  return { success: true, agent };
}

export async function deleteMyAgent(
  agentId: string,
  params?: { accessToken?: string | null }
): Promise<DeleteMyAgentResult> {
  const normalizedId = agentId.trim();
  if (!normalizedId) {
    return { success: false, error: "Missing agent id." };
  }

  const response = await controllerJsonRequest<unknown>({
    path: `/me/agents/${encodeURIComponent(normalizedId)}`,
    method: "DELETE",
    accessToken: params?.accessToken ?? null,
    fallbackError: "Unable to delete agent",
    allowEmptyResponse: true,
  });

  if (!response.success) {
    return { success: false, error: response.error };
  }

  return { success: true };
}
