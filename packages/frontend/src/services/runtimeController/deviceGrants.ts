import { controllerJsonRequest, type ControllerJsonRequestResult } from "./client";
import { readControllerError, resolveControllerRequestContext, runtimeControllerEnabled } from "./core";

/**
 * A person's revocable consent that one of their agents may call named tools
 * on one of their own devices, in turns that person starts in one
 * conversation. Its routes answer 404 to anyone device grants are off for. A
 * device that heartbeats `status: "stopped"` serves no grant until it says
 * otherwise.
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
}

export interface CreateControllerDeviceGrantParams {
  projectId: string;
  agentId: string;
  providerId: string;
  deviceId: string;
  /** Tools the device's published catalog names. */
  toolIds: string[];
  conversationId: string;
}

function grantsPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/device-grants`;
}

/**
 * The signed-in person's live grants in the space; none where grants are off
 * for them (every grant route answers them 404). Rejects when they could not be
 * read, so a failed read never looks like a person without grants.
 */
export async function listControllerDeviceGrants(params: {
  projectId: string;
}): Promise<ControllerDeviceGrant[]> {
  const fallback = "Unable to list device grants";
  const context = runtimeControllerEnabled ? await resolveControllerRequestContext(null) : null;
  if (!context?.baseUrl || !context.accessToken) {
    throw new Error(`${fallback}: no controller session`);
  }
  const response = await fetch(`${context.baseUrl}${grantsPath(params.projectId)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${context.accessToken}`, accept: "application/json" },
  });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(await readControllerError(response, fallback, context));
  }
  const value: unknown = JSON.parse(await response.text());
  if (!Array.isArray(value)) {
    throw new Error(`${fallback}: not a list`);
  }
  return value as ControllerDeviceGrant[];
}

/**
 * Grants the signed-in person's agent tools their own device publishes. It
 * replaces, revoking them, the person's live grants to the same agent that it
 * could not work beside: the one of the same device, which is how a person
 * grants it other tools, and those in the same conversation that name one of
 * its tools.
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
      conversationId: params.conversationId,
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
