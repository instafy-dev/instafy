import {
  ControllerApiError,
  readControllerApiError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
  safeJson,
} from "./core";

export type ConversationSendIntentMode = "queue" | "steer";

export type ConversationSendIntentRequest = Record<string, unknown>;

export type ConversationSendIntentResult = {
  clientSendId: string;
  requestedMode: ConversationSendIntentMode;
  appliedMode: ConversationSendIntentMode;
  state: string;
  deduplicated: boolean;
  queueEntry: Record<string, unknown> | null;
  commandId: string | null;
  jobId: string | null;
  runId: string | null;
  messageId: string | null;
  sequence: number | null;
};

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeMode(value: unknown): ConversationSendIntentMode | null {
  return value === "queue" || value === "steer" ? value : null;
}

export function normalizeConversationSendIntentResult(
  value: unknown,
): ConversationSendIntentResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const clientSendId = readString(record, "clientSendId");
  const requestedMode = normalizeMode(record.requestedMode);
  const appliedMode = normalizeMode(record.appliedMode);
  const state = readString(record, "state") ?? readString(record, "status");
  if (!clientSendId || !requestedMode || !appliedMode || !state) {
    return null;
  }
  const queueEntry =
    record.queueEntry && typeof record.queueEntry === "object" && !Array.isArray(record.queueEntry)
      ? (record.queueEntry as Record<string, unknown>)
      : null;
  return {
    clientSendId,
    requestedMode,
    appliedMode,
    state,
    deduplicated: record.deduplicated === true,
    queueEntry,
    commandId: readString(record, "commandId"),
    jobId: readString(record, "jobId"),
    runId: readString(record, "runId"),
    messageId: readString(record, "messageId"),
    sequence:
      typeof record.sequence === "number" && Number.isFinite(record.sequence)
        ? record.sequence
        : null,
  };
}

export function createConversationClientSendId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `send-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createConversationSendIntentAttemptKey(params: {
  conversationId: string;
  mode: ConversationSendIntentMode;
  request: ConversationSendIntentRequest;
  expectedActiveJobId?: string | null;
  targetAgentHandles?: string[];
}): string {
  return JSON.stringify({
    conversationId: params.conversationId,
    mode: params.mode,
    request: safeJson(params.request) ?? {},
    expectedActiveJobId: params.expectedActiveJobId ?? null,
    targetAgentHandles: params.targetAgentHandles ?? [],
  });
}

export async function sendConversationIntent(params: {
  conversationId: string;
  clientSendId: string;
  mode: ConversationSendIntentMode;
  request: ConversationSendIntentRequest;
  expectedActiveJobId?: string | null;
  targetAgentHandles?: string[];
  accessToken?: string | null;
}): Promise<ConversationSendIntentResult | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  if (!requestContext.accessToken) {
    console.warn("[runtime-controller] No access token available; skipping send intent.");
    return null;
  }

  const response = await fetch(
    `${requestContext.baseUrl}/conversations/${encodeURIComponent(params.conversationId)}/send-intents`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${requestContext.accessToken}`,
      },
      body: JSON.stringify({
        clientSendId: params.clientSendId,
        mode: params.mode,
        request: safeJson(params.request) ?? {},
        ...(params.expectedActiveJobId
          ? { expectedActiveJobId: params.expectedActiveJobId }
          : {}),
        ...(params.targetAgentHandles
          ? { targetAgentHandles: params.targetAgentHandles }
          : {}),
      }),
    },
  );

  if (!response.ok) {
    throw new ControllerApiError(
      await readControllerApiError(response, "send intent failed", requestContext),
    );
  }

  const result = normalizeConversationSendIntentResult(await response.json());
  if (!result) {
    throw new Error("Controller returned an invalid send intent response.");
  }
  return result;
}
