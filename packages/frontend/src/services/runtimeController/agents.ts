import {
  controllerJsonRequest,
} from "./client";

export interface ControllerAgentProfile {
  id: string;
  handle: string;
  displayName: string | null;
  description: string | null;
  avatarSeed: string;
  provider: string;
  model: string | null;
  /** Per-agent reasoning effort (minimal|low|medium|high), or null to inherit. */
  reasoningEffort: string | null;
  credentialId: string | null;
  runtimeId: string | null;
  createdAt: string;
  updatedAt: string;
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
  body: {
    credentialId?: string;
    handle?: string;
    displayName?: string;
    description?: string;
    avatarSeed?: string;
    provider?: string;
    model?: string | null;
    reasoningEffort?: string | null;
  },
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
  body: {
    handle?: string;
    displayName?: string | null;
    description?: string | null;
    avatarSeed?: string;
    credentialId?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    projectId?: string;
    runtimeId?: string | null;
  },
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
