import {
  coerceControllerRuntimeIdleTtlSeconds,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
  safeJson,
} from "./core";
import { logControllerRequestError } from "./logging";
import { createControllerReadBudget } from "./readBudget";

export interface DispatchControllerPromptParams {
  projectId: string;
  sessionId?: string;
  promptText: string;
  intent?: string;
  metadata?: Record<string, unknown> | null;
  parentConversationId?: string | null;
  threadKind?: string | null;
  priority?: number;
  idleTtlSeconds?: number;
  requestedPreview?: boolean;
  runtimeId?: string | null;
  runtimeDisplayName?: string | null;
  preferRuntime?: boolean | null;
  accessToken?: string | null;
}

export interface ControllerConversationParams
  extends DispatchControllerPromptParams {
  conversationMetadata?: Record<string, unknown> | null;
}

export interface ControllerConversationMessageParams
  extends ControllerConversationParams {
  conversationId: string;
  expectedLaneIdle?: boolean;
}

export interface RecordControllerConversationMessageParams {
  conversationId: string;
  projectId: string;
  content: string;
  role?: "assistant" | "user";
  metadata?: Record<string, unknown> | null;
  clientMessageId?: string | null;
  accessToken?: string | null;
}

export type ControllerGroupParticipationDecision =
  | "respond"
  | "claim"
  | "correct"
  | "silent";

export type ControllerGroupParticipationDomain =
  | "direct"
  | "human_directed"
  | "factual"
  | "technical"
  | "decision"
  | "preference"
  | "safety"
  | "social"
  | "arithmetic"
  | "ambiguous";

export interface ResolveControllerConversationParticipationParams {
  conversationId: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  explicitOcto?: boolean;
  replyToOcto?: boolean;
  replyToHuman?: boolean;
  accessToken?: string | null;
}

export interface ControllerConversationParticipationResult {
  decision: ControllerGroupParticipationDecision;
  domain: ControllerGroupParticipationDomain;
  reason: string;
  /** Skill confidence score in the inclusive 0–100 range. */
  confidence: number;
  participantCount: number;
  targetMessageId?: string | null;
  coveredRunId?: string | null;
  coveredJobId?: string | null;
  coverage?:
    | "cancel_active_octo"
    | "await_active_octo"
    | "reuse_completed_octo"
    | null;
  policySkillPath: string;
}

export type ControllerConversationParticipationResolution =
  | ControllerConversationParticipationResult
  | "unsupported";

export interface DispatchControllerPromptResponse {
  runId?: string | null;
  runIds?: string[] | null;
  promptId?: string | null;
  jobId?: string | null;
  jobIds?: string[] | null;
  status: string;
  conversationId?: string | null;
}

export interface CreateControllerConversationResponse {
  conversationId: string;
  initialParticipantUserIds?: string[];
}

export interface ProjectConversationTitleParams {
  projectId: string;
  message: string;
  credentialId?: string | null;
  accessToken?: string | null;
  signal?: AbortSignal;
}

export interface ProjectConversationTitleResult {
  success: boolean;
  title: string | null;
  provider?: string | null;
  model?: string | null;
  credentialId?: string | null;
  error?: string;
}

export interface DispatchControllerBuildParams {
  projectId: string;
  sessionId?: string;
  repoOwner?: string;
  repoName?: string;
  branch?: string;
  workflow?: string;
  metadata?: Record<string, unknown> | null;
  accessToken?: string | null;
}

export interface DispatchControllerBuildResponse {
  runId: string;
  status: string;
  workflowUrl?: string | null;
  message?: string | null;
}

export interface ControllerConversationMessage {
  id: string;
  conversationId: string;
  projectId: string;
  sessionId: string | null;
  createdBy?: string | null;
  promptId: string | null;
  runId: string | null;
  role: "assistant" | "user";
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ControllerConversationMessagesPage {
  messages: ControllerConversationMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ControllerConversationParticipant {
  userId: string;
  displayName?: string | null;
  role: string;
  addedBy: string | null;
  createdAt: string;
}

export interface ControllerConversationParticipantsResponse {
  participants: ControllerConversationParticipant[];
}

export interface ControllerConversationCreated {
  conversationId: string;
  projectId: string;
  sessionId: string | null;
  createdBy: string | null;
  visibility?: string | null;
  metadata: Record<string, unknown> | null;
  parentConversationId?: string | null;
  rootConversationId?: string | null;
  threadKind?: string | null;
  lastMessageId?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  createdAt: string;
  updatedAt: string | null;
  runId?: string | null;
  promptId?: string | null;
}

export interface ControllerConversationUpdated {
  conversationId: string;
  projectId: string;
  sessionId: string | null;
  createdBy: string | null;
  visibility?: string | null;
  metadata: Record<string, unknown> | null;
  parentConversationId?: string | null;
  rootConversationId?: string | null;
  threadKind?: string | null;
  lastMessageId?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface ControllerProjectConversation {
  id: string;
  projectId: string;
  sessionId: string | null;
  createdBy: string | null;
  visibility?: string | null;
  metadata: Record<string, unknown> | null;
  parentConversationId?: string | null;
  rootConversationId?: string | null;
  threadKind?: string | null;
  lastMessageId?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FetchProjectConversationsParams {
  projectId: string;
  limit?: number;
  rootsOnly?: boolean;
  parentConversationId?: string | null;
  rootConversationId?: string | null;
  threadKind?: string | null;
  accessToken?: string | null;
  signal?: AbortSignal;
}

export interface FetchConversationMessagesParams {
  conversationId: string;
  cursor?: string | null;
  limit?: number;
  accessToken?: string | null;
  signal?: AbortSignal;
}

const inFlightBlankConversationRequests = new Map<
  string,
  Promise<CreateControllerConversationResponse | null>
>();
const cachedBlankConversations = new Map<string, CreateControllerConversationResponse>();
const CONTROLLER_MESSAGE_RECORD_RETRY_DELAYS_MS = [300, 1_000] as const;
const CONTROLLER_PARTICIPATION_TIMEOUT_MS = 2_000;

function normalizeClientMessageId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveClientMessageId(
  metadata: Record<string, unknown> | null | undefined,
  explicitClientMessageId: string | null | undefined,
): string {
  const explicit = normalizeClientMessageId(explicitClientMessageId);
  if (explicit) {
    return explicit;
  }

  const fromMetadata = normalizeClientMessageId(
    metadata?.clientMessageId ?? metadata?.client_message_id,
  );
  if (fromMetadata) {
    return fromMetadata;
  }

  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `client-message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function withClientMessageIdMetadata(
  metadata: Record<string, unknown> | null | undefined,
  clientMessageId: string,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    clientMessageId,
  };
}

function isRetryableConversationRecordStatus(status: number): boolean {
  // 500 is retryable here because /messages/record is idempotent: the client
  // always sends a clientMessageId and the controller dedupes it under an
  // advisory lock, so re-sending after a transient server error cannot create
  // duplicate messages. (Observed: a transient DB error surfaced as 500 and
  // silently dropped a chat message during an otherwise green device smoke.)
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function isRetryableConversationRecordError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return false;
    }
    return error instanceof TypeError;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function extractConversationLocalIdFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata) {
    return null;
  }
  const raw = metadata.localId ?? metadata.local_id;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildBlankConversationRequestKey(params: {
  projectId: string;
  metadata: Record<string, unknown> | null | undefined;
  initialParticipantUserIds?: string[];
}): string | null {
  const projectId = params.projectId.trim();
  if (!projectId) {
    return null;
  }
  const localId = extractConversationLocalIdFromMetadata(params.metadata);
  if (!localId) {
    return null;
  }
  return JSON.stringify([projectId, localId, [...(params.initialParticipantUserIds ?? [])].sort()]);
}

export async function updateControllerConversationMetadata(params: {
  conversationId: string;
  metadata: Record<string, unknown> | null;
  accessToken?: string | null;
}): Promise<ControllerProjectConversation | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const sessionToken = requestContext.accessToken;

  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping conversation update.",
    );
    return null;
  }

  const body = {
    metadata: safeJson(params.metadata) ?? {},
  };

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/conversations/${params.conversationId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new Error(
        await readControllerError(
          response,
          "update conversation failed",
          requestContext,
        ),
      );
    }

    return (await response.json()) as ControllerProjectConversation;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] update conversation error:", message);
    return null;
  }
}

export async function requestProjectConversationTitle(
  params: ProjectConversationTitleParams,
): Promise<ProjectConversationTitleResult> {
  if (!runtimeControllerEnabled) {
    return { success: false, title: null, error: "Runtime controller is not configured." };
  }

  const projectId = params.projectId.trim();
  const message = params.message.trim();
  if (!projectId) {
    return { success: false, title: null, error: "Missing project id." };
  }
  if (!message) {
    return { success: false, title: null, error: "Missing message." };
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const resolvedAccessToken = requestContext.accessToken;
  if (!resolvedAccessToken) {
    return { success: false, title: null, error: "Missing controller session token." };
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${encodeURIComponent(projectId)}/conversation/title`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolvedAccessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          message,
          credentialId: params.credentialId ?? null,
        }),
        signal: params.signal,
      },
    );

    if (!response.ok) {
      const errorMessage = await readControllerError(
        response,
        "Unable to generate conversation title",
        requestContext,
      );
      return { success: false, title: null, error: errorMessage };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return {
      success: true,
      title: typeof payload.title === "string" ? payload.title : null,
      provider: typeof payload.provider === "string" ? payload.provider : null,
      model: typeof payload.model === "string" ? payload.model : null,
      credentialId: typeof payload.credentialId === "string" ? payload.credentialId : null,
      error: typeof payload.error === "string" ? payload.error : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { success: false, title: null, error: "Request aborted." };
    }
    const messageText = error instanceof Error ? error.message : String(error);
    return { success: false, title: null, error: `Unable to generate conversation title: ${messageText}` };
  }
}

export async function createControllerConversation(
  params: ControllerConversationParams,
): Promise<DispatchControllerPromptResponse | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const sessionToken = requestContext.accessToken;

  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping conversation creation.",
    );
    return null;
  }

  const body = {
    sessionId: params.sessionId ?? null,
    promptText: params.promptText,
    intent: params.intent ?? "feature",
    metadata: safeJson(params.metadata) ?? {},
    conversationMetadata: safeJson(params.conversationMetadata) ?? undefined,
    parentConversationId: params.parentConversationId ?? undefined,
    threadKind: params.threadKind ?? undefined,
    priority: params.priority ?? undefined,
    idleTtlSeconds: coerceControllerRuntimeIdleTtlSeconds(params.idleTtlSeconds),
    runtimeId: params.runtimeId ?? undefined,
    runtimeDisplayName: params.runtimeDisplayName ?? undefined,
    preferRuntime: params.preferRuntime ?? undefined,
    ui:
      params.requestedPreview === undefined
        ? undefined
        : { requestedPreview: params.requestedPreview },
  };

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/projects/${params.projectId}/conversations`,
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
        "create conversation failed",
        requestContext,
      );
      throw new Error(message);
    }

    const data = (await response.json()) as DispatchControllerPromptResponse;
    return {
      ...data,
      conversationId: data.conversationId ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[runtime-controller] create conversation error:", message);
    throw new Error(message);
  }
}

export interface CreateBlankControllerConversationParams extends Pick<
  DispatchControllerPromptParams,
  "projectId" | "sessionId" | "metadata" | "parentConversationId" | "threadKind" | "accessToken"
> {
  /** Authorized participants added atomically when creating a private conversation. */
  initialParticipantUserIds?: string[];
}

export async function createBlankControllerConversation(
  params: CreateBlankControllerConversationParams,
): Promise<CreateControllerConversationResponse | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const sessionToken = requestContext.accessToken;

  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping conversation creation.",
    );
    return null;
  }

  const body = {
    sessionId: params.sessionId ?? null,
    metadata: safeJson(params.metadata) ?? {},
    parentConversationId: params.parentConversationId ?? undefined,
    threadKind: params.threadKind ?? undefined,
    initialParticipantUserIds: params.initialParticipantUserIds,
  };

  const request = async (): Promise<CreateControllerConversationResponse | null> => {
    try {
      const response = await fetch(
        `${requestContext.baseUrl}/projects/${params.projectId}/conversations/blank`,
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
        throw new Error(
          await readControllerError(
            response,
            "create blank conversation failed",
            requestContext,
          ),
        );
      }

      const data = (await response.json()) as CreateControllerConversationResponse;
      return {
        conversationId: data.conversationId,
        ...(Array.isArray(data.initialParticipantUserIds)
          ? { initialParticipantUserIds: data.initialParticipantUserIds.filter((id): id is string => typeof id === "string") }
          : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        "[runtime-controller] create blank conversation error:",
        message,
      );
      return null;
    }
  };

  const requestKey = buildBlankConversationRequestKey({
    projectId: params.projectId,
    metadata: params.metadata ?? null,
    initialParticipantUserIds: params.initialParticipantUserIds,
  });

  if (!requestKey) {
    return await request();
  }

  const cachedConversation = cachedBlankConversations.get(requestKey) ?? null;
  if (cachedConversation) {
    return cachedConversation;
  }

  const inFlight = inFlightBlankConversationRequests.get(requestKey);
  if (inFlight) {
    return await inFlight;
  }

  const promise = request().finally(() => {
    inFlightBlankConversationRequests.delete(requestKey);
  });
  inFlightBlankConversationRequests.set(requestKey, promise);
  const result = await promise;
  if (result?.conversationId) {
    cachedBlankConversations.set(requestKey, result);
  }
  return result;
}

export async function listControllerConversationParticipants(params: {
  conversationId: string;
  accessToken?: string | null;
}): Promise<ControllerConversationParticipant[] | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping conversation participants fetch.",
    );
    return null;
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/conversations/${params.conversationId}/participants`,
      {
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        await readControllerError(
          response,
          "fetch conversation participants failed",
          requestContext,
        ),
      );
    }

    const payload =
      (await response.json()) as ControllerConversationParticipantsResponse;
    return Array.isArray(payload.participants) ? payload.participants : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[runtime-controller] fetch conversation participants error:",
      message,
    );
    return null;
  }
}

export async function addControllerConversationParticipant(params: {
  conversationId: string;
  userId: string;
  role?: string | null;
  accessToken?: string | null;
}): Promise<ControllerConversationParticipant[] | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping conversation participant add.",
    );
    return null;
  }

  const body: Record<string, unknown> = {
    userId: params.userId,
  };
  if (typeof params.role === "string" && params.role.trim().length > 0) {
    body.role = params.role.trim();
  }

  try {
    const response = await fetch(
      `${requestContext.baseUrl}/conversations/${params.conversationId}/participants`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new Error(
        await readControllerError(
          response,
          "add conversation participant failed",
          requestContext,
        ),
      );
    }

    const payload =
      (await response.json()) as ControllerConversationParticipantsResponse;
    return Array.isArray(payload.participants) ? payload.participants : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[runtime-controller] add conversation participant error:",
      message,
    );
    return null;
  }
}

export async function recordControllerConversationMessage(
  params: RecordControllerConversationMessageParams,
): Promise<ControllerConversationMessage | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const sessionToken = requestContext.accessToken;

  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping conversation message record.",
    );
    return null;
  }

  const clientMessageId = resolveClientMessageId(
    params.metadata,
    params.clientMessageId ?? null,
  );
  const metadata = withClientMessageIdMetadata(params.metadata, clientMessageId);
  const body = {
    projectId: params.projectId,
    content: params.content,
    role: params.role ?? "user",
    metadata: safeJson(metadata) ?? {},
    clientMessageId,
  };

  for (let attempt = 0; attempt <= CONTROLLER_MESSAGE_RECORD_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(
        `${requestContext.baseUrl}/conversations/${params.conversationId}/messages/record`,
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
        if (
          isRetryableConversationRecordStatus(response.status) &&
          attempt < CONTROLLER_MESSAGE_RECORD_RETRY_DELAYS_MS.length
        ) {
          await sleep(CONTROLLER_MESSAGE_RECORD_RETRY_DELAYS_MS[attempt] ?? 0);
          continue;
        }
        throw new Error(
          await readControllerError(
            response,
            "record conversation message failed",
            requestContext,
          ),
        );
      }

      const data = (await response.json()) as ControllerConversationMessage;
      return {
        ...data,
        metadata:
          data.metadata && typeof data.metadata === "object" ? data.metadata : {},
      };
    } catch (error) {
      if (
        isRetryableConversationRecordError(error) &&
        attempt < CONTROLLER_MESSAGE_RECORD_RETRY_DELAYS_MS.length
      ) {
        await sleep(CONTROLLER_MESSAGE_RECORD_RETRY_DELAYS_MS[attempt] ?? 0);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        "[runtime-controller] record conversation message error:",
        message,
      );
      return null;
    }
  }

  return null;
}

export async function resolveControllerConversationParticipation(
  params: ResolveControllerConversationParticipationParams,
): Promise<ControllerConversationParticipationResolution | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping conversation participation resolution.",
    );
    return null;
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    CONTROLLER_PARTICIPATION_TIMEOUT_MS,
  );
  try {
    const response = await fetch(
      `${requestContext.baseUrl}/conversations/${params.conversationId}/participation/resolve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          content: params.content,
          metadata: safeJson(params.metadata) ?? {},
          explicitOcto: params.explicitOcto ?? false,
          replyToOcto: params.replyToOcto ?? false,
          replyToHuman: params.replyToHuman ?? false,
        }),
        signal: abortController.signal,
      },
    );

    // Distinguish staggered rollout from an unhealthy resolver. Axum's missing
    // route response is an empty/plain "Not Found" 404, while handler-level
    // missing resources use the structured ApiError JSON contract.
    if (response.status === 405) {
      return "unsupported";
    }
    if (response.status === 404) {
      const responseText = await response.text().catch(() => "");
      const normalized = responseText.trim().toLowerCase();
      if (normalized === "" || normalized === "not found" || normalized === "404 not found") {
        return "unsupported";
      }
      console.warn(
        "[runtime-controller] Participation resolver returned a resource-level 404.",
      );
      return null;
    }
    if (!response.ok) {
      const message = await readControllerError(
        response,
        "conversation participation resolution failed",
        requestContext,
      );
      throw new Error(message);
    }

    const data = (await response.json()) as Partial<ControllerConversationParticipationResult>;
    const decision = data.decision;
    const domain = data.domain;
    const validDecision =
      decision === "respond" ||
      decision === "claim" ||
      decision === "correct" ||
      decision === "silent";
    const validDomain =
      domain === "direct" ||
      domain === "human_directed" ||
      domain === "factual" ||
      domain === "technical" ||
      domain === "decision" ||
      domain === "preference" ||
      domain === "safety" ||
      domain === "social" ||
      domain === "arithmetic" ||
      domain === "ambiguous";
    const coverage =
      data.coverage === "cancel_active_octo" ||
      data.coverage === "await_active_octo" ||
      data.coverage === "reuse_completed_octo"
        ? data.coverage
        : null;
    const coverageWasProvided = data.coverage !== undefined && data.coverage !== null;
    const coveredRunId =
      typeof data.coveredRunId === "string" && data.coveredRunId.trim()
        ? data.coveredRunId.trim()
        : null;
    const coveredJobId =
      typeof data.coveredJobId === "string" && data.coveredJobId.trim()
        ? data.coveredJobId.trim()
        : null;
    if (
      !validDecision ||
      !validDomain ||
      typeof data.reason !== "string" ||
      typeof data.confidence !== "number" ||
      !Number.isFinite(data.confidence) ||
      data.confidence < 0 ||
      data.confidence > 100 ||
      typeof data.participantCount !== "number" ||
      !Number.isFinite(data.participantCount) ||
      !Number.isInteger(data.participantCount) ||
      data.participantCount < 0 ||
      (coverageWasProvided && !coverage) ||
      (coverage && (!coveredRunId || !coveredJobId)) ||
      typeof data.policySkillPath !== "string"
    ) {
      console.warn(
        "[runtime-controller] Ignoring malformed conversation participation response.",
      );
      return null;
    }

    return {
      decision,
      domain,
      reason: data.reason,
      confidence: data.confidence,
      participantCount: data.participantCount,
      targetMessageId:
        typeof data.targetMessageId === "string" ? data.targetMessageId : null,
      coveredRunId,
      coveredJobId,
      coverage,
      policySkillPath: data.policySkillPath,
    };
  } catch (error) {
    logControllerRequestError(
      "[runtime-controller] conversation participation resolution error:",
      error,
      { suppressLikelyConnectionNoise: true },
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function sendControllerConversationMessage(
  params: ControllerConversationMessageParams,
): Promise<DispatchControllerPromptResponse | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(
    params.accessToken ?? null,
  );
  const sessionToken = requestContext.accessToken;

  if (!sessionToken) {
    console.warn(
      "[runtime-controller] No access token available; skipping conversation message.",
    );
    return null;
  }

  const body = {
    sessionId: params.sessionId ?? null,
    promptText: params.promptText,
    intent: params.intent ?? "feature",
    metadata: safeJson(params.metadata) ?? {},
    conversationMetadata: safeJson(params.conversationMetadata) ?? undefined,
    priority: params.priority ?? undefined,
    idleTtlSeconds: coerceControllerRuntimeIdleTtlSeconds(params.idleTtlSeconds),
    runtimeId: params.runtimeId ?? undefined,
    runtimeDisplayName: params.runtimeDisplayName ?? undefined,
    preferRuntime: params.preferRuntime ?? undefined,
    expectedLaneIdle: params.expectedLaneIdle ?? undefined,
    ui:
      params.requestedPreview === undefined
        ? undefined
        : { requestedPreview: params.requestedPreview },
  };

  const response = await fetch(
    `${requestContext.baseUrl}/conversations/${params.conversationId}/messages`,
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
      "conversation message failed",
      requestContext,
    );
    throw new Error(message);
  }

  const data = (await response.json()) as DispatchControllerPromptResponse;
  return {
    ...data,
    conversationId: data.conversationId ?? params.conversationId ?? null,
  };
}

export async function interruptControllerConversationRuns(params: {
  conversationId: string;
  reason?: string | null;
  accessToken?: string | null;
}): Promise<string[] | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;

  if (!sessionToken) {
    console.warn("[runtime-controller] No access token available; skipping conversation interrupt.");
    return null;
  }

  const body = {
    reason: params.reason ?? undefined,
  };

  const response = await fetch(`${requestContext.baseUrl}/conversations/${params.conversationId}/interrupt`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "conversation interrupt failed",
      requestContext,
    );
    throw new Error(message);
  }

  const data = (await response.json()) as { canceledRunIds?: unknown } | null;
  const canceledRunIds = Array.isArray(data?.canceledRunIds)
    ? data?.canceledRunIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  return canceledRunIds;
}

export async function fetchConversationMessagesFromController(
  params: FetchConversationMessagesParams,
): Promise<ControllerConversationMessagesPage | "not_found" | "access_denied" | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const budget = createControllerReadBudget(params.signal);
  try {
    const requestContext = await budget.wait(() =>
      resolveControllerRequestContext(params.accessToken ?? null),
    );
    budget.signal.throwIfAborted();
    const sessionToken = requestContext.accessToken;
    if (!sessionToken) {
      console.warn(
        "[runtime-controller] No access token available; skipping conversation history fetch.",
      );
      return null;
    }

    const search = new URLSearchParams();
    if (params.limit) search.set("limit", String(params.limit));
    if (params.cursor) search.set("cursor", params.cursor);

    const response = await budget.wait(() => fetch(
      `${requestContext.baseUrl}/conversations/${params.conversationId}/messages?${search.toString()}`,
      {
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
        signal: budget.signal,
      },
    ));
    budget.signal.throwIfAborted();

    if (response.status === 404) {
      return "not_found";
    }

    if (response.status === 403) {
      // Revoked permission is terminal. A 401 still uses the auth-recovery
      // path below, which can discard an expired override and retry the live session.
      // Do not wait for an error body to clear cached, now-inaccessible history.
      void response.body?.cancel().catch(() => undefined);
      return "access_denied";
    }

    if (!response.ok) {
      throw new Error(
        await budget.wait(() => readControllerError(
          response,
          "fetch messages failed",
          requestContext,
        )),
      );
    }

    const data = await budget.wait<ControllerConversationMessagesPage>(
      () => response.json(),
    );
    budget.signal.throwIfAborted();
    const normalized: ControllerConversationMessagesPage = {
      messages: (data.messages ?? []).map((message) => ({
        ...message,
        metadata:
          message.metadata && typeof message.metadata === "object"
            ? message.metadata
            : {},
      })),
      nextCursor: data.nextCursor ?? null,
      hasMore: Boolean(data.hasMore),
    };
    return normalized;
  } catch (error) {
    // Let query cancellation stop the entire page chain. Returning null here
    // would turn an obsolete read into a retryable history failure.
    budget.signal.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      "[runtime-controller] fetch conversation messages error:",
      message,
    );
    return null;
  } finally {
    budget.dispose();
  }
}

export async function fetchProjectConversationsFromController(
  params: FetchProjectConversationsParams,
): Promise<ControllerProjectConversation[] | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const budget = createControllerReadBudget(params.signal);
  try {
    const requestContext = await budget.wait(() => resolveControllerRequestContext(params.accessToken ?? null));
    const sessionToken = requestContext.accessToken;

    if (!sessionToken) {
      console.warn(
        "[runtime-controller] No access token available; skipping project conversations fetch.",
      );
      return null;
    }

    const search = new URLSearchParams();
    if (params.limit) {
      search.set("limit", String(params.limit));
    }
    if (params.rootsOnly) {
      search.set("rootsOnly", "true");
    }
    if (params.parentConversationId) {
      search.set("parentConversationId", params.parentConversationId);
    }
    if (params.rootConversationId) {
      search.set("rootConversationId", params.rootConversationId);
    }
    if (params.threadKind) {
      search.set("threadKind", params.threadKind);
    }

    const response = await budget.wait(() => fetch(
      `${requestContext.baseUrl}/projects/${params.projectId}/conversations?${search.toString()}`,
      {
        signal: budget.signal,
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      },
    ));

    if (!response.ok) {
      const errorMessage = await budget.wait(() => readControllerError(
        response,
        "fetch project conversations failed",
        requestContext,
      ));
      throw new Error(errorMessage);
    }

    const data = (await budget.wait(() => response.json())) as ControllerProjectConversation[];
    return (data ?? []).map((conversation) => ({
      ...conversation,
      metadata:
        conversation.metadata && typeof conversation.metadata === "object"
          ? conversation.metadata
          : {},
    }));
  } catch (error) {
    params.signal?.throwIfAborted();
    logControllerRequestError(
      "[runtime-controller] fetch project conversations error:",
      error,
      {
        suppressLikelyConnectionNoise: true,
      },
    );
    return null;
  } finally {
    budget.dispose();
  }
}
