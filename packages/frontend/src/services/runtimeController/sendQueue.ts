import type { DispatchControllerPromptResponse } from "./conversations";
import {
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
  safeJson,
} from "./core";

export const CONVERSATION_SEND_QUEUE_EVENT = "instafy:conversation-send-queue";

export interface ConversationSendQueueEventDetail {
  projectId: string | null;
  conversationId: string | null;
  data: Record<string, unknown> | null;
}

export type ControllerSendQueueEntryStatus = "queued" | "failed";

export interface ControllerSendQueueEntry {
  id: string;
  conversationId: string;
  status: ControllerSendQueueEntryStatus;
  targetAgentHandles: string[];
  message: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string;
  dispatchedAt: string | null;
}

export interface ControllerSendQueueCancelResult {
  ok: boolean;
  entry: ControllerSendQueueEntry | null;
}

export type ControllerSendQueueDispatchOutcome =
  | "dispatched"
  | "alreadyDispatched"
  | "queued"
  | "notFound";

export interface ControllerSendQueueDispatchResult {
  outcome: ControllerSendQueueDispatchOutcome;
  response: DispatchControllerPromptResponse | null;
}

function normalizeSendQueueEntry(value: unknown): ControllerSendQueueEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const conversationId =
    typeof record.conversationId === "string" ? record.conversationId.trim() : "";
  if (!id || !conversationId) {
    return null;
  }
  const targetAgentHandles = Array.isArray(record.targetAgentHandles)
    ? record.targetAgentHandles.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : [];
  const message =
    record.message && typeof record.message === "object" && !Array.isArray(record.message)
      ? (record.message as Record<string, unknown>)
      : {};
  return {
    id,
    conversationId,
    status: record.status === "failed" ? "failed" : "queued",
    targetAgentHandles,
    message,
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : null,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    dispatchedAt: typeof record.dispatchedAt === "string" ? record.dispatchedAt : null,
  };
}

export async function listSendQueue(params: {
  conversationId: string;
  accessToken?: string | null;
}): Promise<ControllerSendQueueEntry[] | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping send queue fetch.",
    );
    return null;
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/conversations/${encodeURIComponent(params.conversationId)}/send-queue`,
      {
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      },
    );

    if (!response.ok) {
      const message = await readControllerError(
        response,
        "fetch send queue failed",
        requestContext,
      );
      throw new Error(message);
    }

    const payload = (await response.json()) as unknown;
    return (Array.isArray(payload) ? payload : [])
      .map(normalizeSendQueueEntry)
      .filter((entry): entry is ControllerSendQueueEntry => Boolean(entry));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] fetch send queue error:", message);
    return null;
  }
}

export async function enqueueSendQueueEntry(params: {
  conversationId: string;
  message: Record<string, unknown>;
  targetAgentHandles: string[];
  accessToken?: string | null;
}): Promise<ControllerSendQueueEntry | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping send queue enqueue.",
    );
    return null;
  }

  const body = {
    message: safeJson(params.message) ?? {},
    targetAgentHandles: params.targetAgentHandles,
  };

  const response = await fetch(
    `${requestContext.baseUrl}/conversations/${encodeURIComponent(params.conversationId)}/send-queue`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "send queue enqueue failed",
      requestContext,
    );
    throw new Error(message);
  }

  return normalizeSendQueueEntry(await response.json());
}

export async function cancelSendQueueEntry(params: {
  conversationId: string;
  entryId: string;
  accessToken?: string | null;
}): Promise<ControllerSendQueueCancelResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping send queue cancel.",
    );
    return null;
  }

  const response = await fetch(
    `${requestContext.baseUrl}/conversations/${encodeURIComponent(params.conversationId)}/send-queue/${encodeURIComponent(params.entryId)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${sessionToken}`,
      },
    },
  );

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "send queue cancel failed",
      requestContext,
    );
    throw new Error(message);
  }

  const data = (await response.json()) as { ok?: unknown; entry?: unknown } | null;
  return {
    ok: data?.ok === true,
    entry: normalizeSendQueueEntry(data?.entry),
  };
}

export async function dispatchSendQueueEntryNow(params: {
  conversationId: string;
  entryId: string;
  accessToken?: string | null;
}): Promise<ControllerSendQueueDispatchResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping send queue dispatch.",
    );
    return null;
  }

  const response = await fetch(
    `${requestContext.baseUrl}/conversations/${encodeURIComponent(params.conversationId)}/send-queue/${encodeURIComponent(params.entryId)}/dispatch`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    if (response.status === 404) {
      // The entry id is unknown or was canceled; it is no longer queued.
      return { outcome: "notFound", response: null };
    }
    const message = await readControllerError(
      response,
      "send queue dispatch failed",
      requestContext,
    );
    throw new Error(message);
  }

  const data = (await response.json()) as DispatchControllerPromptResponse & {
    alreadyDispatched?: unknown;
    queued?: unknown;
  };
  if (data.alreadyDispatched === true) {
    // The server drain claimed and dispatched the entry before this request.
    return { outcome: "alreadyDispatched", response: null };
  }
  if (data.queued === true) {
    return { outcome: "queued", response: null };
  }
  return {
    outcome: "dispatched",
    response: {
      ...data,
      conversationId: data.conversationId ?? params.conversationId ?? null,
    },
  };
}
