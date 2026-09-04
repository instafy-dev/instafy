import {
  ControllerApiError,
  readControllerApiError,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
  safeJson,
} from "./core";

export type ControllerMessageStash = {
  id: string;
  clientStashId: string;
  projectId: string;
  conversationId: string;
  text: string;
  editorState: unknown;
  composerEnvelope: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function normalizeMessageStash(value: unknown): ControllerMessageStash | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const clientStashId =
    typeof record.clientStashId === "string" ? record.clientStashId.trim() : "";
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  const conversationId =
    typeof record.conversationId === "string" ? record.conversationId.trim() : "";
  if (
    !id ||
    !clientStashId ||
    !projectId ||
    !conversationId ||
    typeof record.text !== "string"
  ) {
    return null;
  }
  const composerEnvelope =
    record.composerEnvelope &&
    typeof record.composerEnvelope === "object" &&
    !Array.isArray(record.composerEnvelope)
      ? (record.composerEnvelope as Record<string, unknown>)
      : {};
  return {
    id,
    clientStashId,
    projectId,
    conversationId,
    text: record.text,
    editorState: record.editorState ?? null,
    composerEnvelope,
    createdAt:
      typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    updatedAt:
      typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

export function createMessageStashClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

async function resolveMessageStashRequestContext(accessToken?: string | null) {
  if (!runtimeControllerEnabled) {
    return null;
  }
  const requestContext = await resolveControllerRequestContext(accessToken ?? null);
  if (!requestContext.accessToken) {
    console.warn("[runtime-controller] No access token available; skipping message stash request.");
    return null;
  }
  return requestContext;
}

export async function listMessageStashes(params: {
  conversationId: string;
  accessToken?: string | null;
}): Promise<ControllerMessageStash[] | null> {
  const requestContext = await resolveMessageStashRequestContext(params.accessToken);
  if (!requestContext) {
    return null;
  }
  const response = await fetch(
    `${requestContext.baseUrl}/conversations/${encodeURIComponent(params.conversationId)}/message-stashes`,
    { headers: { authorization: `Bearer ${requestContext.accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      await readControllerError(response, "message stash fetch failed", requestContext),
    );
  }
  const payload = (await response.json()) as unknown;
  return (Array.isArray(payload) ? payload : [])
    .map(normalizeMessageStash)
    .filter((stash): stash is ControllerMessageStash => Boolean(stash));
}

export async function createMessageStash(params: {
  conversationId: string;
  clientStashId: string;
  text: string;
  editorState: unknown;
  composerEnvelope: Record<string, unknown>;
  accessToken?: string | null;
}): Promise<ControllerMessageStash | null> {
  const requestContext = await resolveMessageStashRequestContext(params.accessToken);
  if (!requestContext) {
    return null;
  }
  const response = await fetch(
    `${requestContext.baseUrl}/conversations/${encodeURIComponent(params.conversationId)}/message-stashes`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${requestContext.accessToken}`,
      },
      body: JSON.stringify({
        clientStashId: params.clientStashId,
        text: params.text,
        editorState: params.editorState,
        composerEnvelope: safeJson(params.composerEnvelope) ?? {},
      }),
    },
  );
  if (!response.ok) {
    throw new ControllerApiError(
      await readControllerApiError(
        response,
        "message stash create failed",
        requestContext,
      ),
    );
  }
  const stash = normalizeMessageStash(await response.json());
  if (!stash) {
    throw new Error("Controller returned an invalid message stash.");
  }
  if (stash.clientStashId !== params.clientStashId) {
    throw new Error("Controller returned a mismatched message stash id.");
  }
  return stash;
}

export async function deleteMessageStash(params: {
  conversationId: string;
  stashId: string;
  accessToken?: string | null;
}): Promise<boolean> {
  const requestContext = await resolveMessageStashRequestContext(params.accessToken);
  if (!requestContext) {
    return false;
  }
  const response = await fetch(
    `${requestContext.baseUrl}/conversations/${encodeURIComponent(params.conversationId)}/message-stashes/${encodeURIComponent(params.stashId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${requestContext.accessToken}` },
    },
  );
  if (!response.ok) {
    throw new Error(
      await readControllerError(response, "message stash delete failed", requestContext),
    );
  }
  const payload = (await response.json()) as { ok?: unknown } | null;
  return payload?.ok === true;
}
