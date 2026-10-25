import { controllerJsonRequest, type ControllerJsonRequestResult } from "./client";

/**
 * Coarse per-turn call limits, under the controller's fixed cap on a turn's
 * calls in all. The device keeps its own, finer ones.
 */
export interface ControllerDeviceGrantBudgets {
  /** Calls one turn may make to one tool, by tool id. */
  callsPerTool?: Record<string, number>;
}

/**
 * A person's revocable consent that one of their agents may call named tools
 * on one of their own devices, in turns that person starts in one
 * conversation. The controller offers these routes only where device grants
 * are enabled; elsewhere they answer 404. A device's own stop is an interrupt
 * of its grant's conversation.
 */
export interface ControllerDeviceGrant {
  id: string;
  /** The grant's person: the device's owner, whose own turns get it. */
  userId: string;
  agentId: string;
  providerId: string;
  deviceId: string;
  toolIds: string[];
  /** Only turns in this conversation, one the person started, get the grant. */
  conversationId: string;
  /** Granted turns run only on this runtime while it is in the space. */
  runtimeId?: string;
  /** Speech the device heard (`metadata.input.kind: "voice"`) starts granted turns too. */
  voice: boolean;
  /**
   * Listed grants only: the device is no longer the person's, or its catalog
   * changed since it was granted, so its turns get none of it until the
   * person grants it again.
   */
  changed?: boolean;
}

export interface CreateControllerDeviceGrantParams {
  projectId: string;
  agentId: string;
  providerId: string;
  deviceId: string;
  /** Tools the device's published catalog names. */
  toolIds: string[];
  budgets?: ControllerDeviceGrantBudgets;
  conversationId: string;
  runtimeId?: string | null;
  voice?: boolean;
}

function grantsPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/device-grants`;
}

/**
 * The signed-in person's live grants in the space; none where grants are off
 * for them (the route answers 404). Rejects when they could not be read, so a
 * failed read never looks like a person without grants.
 */
export async function listControllerDeviceGrants(params: {
  projectId: string;
}): Promise<ControllerDeviceGrant[]> {
  const response = await controllerJsonRequest<unknown>({
    path: grantsPath(params.projectId),
    fallbackError: "Unable to list device grants",
    allowNotFound: true,
  });
  if (!response.success) {
    throw new Error(response.error);
  }
  if (response.value === undefined) {
    return [];
  }
  if (!Array.isArray(response.value)) {
    throw new Error("Unable to list device grants: not a list");
  }
  return response.value as ControllerDeviceGrant[];
}

/**
 * Grants the signed-in person's agent tools of their own device, pinning the
 * catalog the device publishes now. It replaces a live grant of the same
 * device to the same agent, which is how a person grants a changed device
 * again.
 */
export function createControllerDeviceGrant(
  params: CreateControllerDeviceGrantParams,
): Promise<ControllerJsonRequestResult<ControllerDeviceGrant>> {
  return controllerJsonRequest<ControllerDeviceGrant>({
    path: grantsPath(params.projectId),
    method: "POST",
    body: {
      agentId: params.agentId,
      providerId: params.providerId,
      deviceId: params.deviceId,
      toolIds: params.toolIds,
      budgets: params.budgets ?? undefined,
      conversationId: params.conversationId,
      runtimeId: params.runtimeId ?? undefined,
      voice: params.voice ?? undefined,
    },
    fallbackError: "Unable to grant the device",
  });
}

/** Revokes one of the person's grants and cancels its turns' open requests. */
export function revokeControllerDeviceGrant(params: {
  projectId: string;
  grantId: string;
}): Promise<ControllerJsonRequestResult<{ revoked: boolean }>> {
  return controllerJsonRequest<{ revoked: boolean }>({
    path: `${grantsPath(params.projectId)}/${encodeURIComponent(params.grantId)}`,
    method: "DELETE",
    fallbackError: "Unable to revoke the device grant",
  });
}
