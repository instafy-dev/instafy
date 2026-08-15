import {
  normalizeUuidParam,
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";

export type ControllerAutomationScheduleKind = "hourly" | "weekly" | "once";
export type ControllerAutomationRuntimeMode = "auto" | "hosted" | "existing";
export type ControllerAutomationStatus = "active" | "paused";

export interface ControllerAutomation {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  promptText: string;
  metadata: Record<string, unknown>;
  scheduleKind: ControllerAutomationScheduleKind;
  runAt: string | null;
  intervalHours: number | null;
  byDay: string[];
  byHour: number | null;
  byMinute: number | null;
  timezone: string;
  runtimeMode: ControllerAutomationRuntimeMode;
  runtimeProvider: string | null;
  conversationId: string | null;
  silentWhenNothingToReport: boolean;
  status: ControllerAutomationStatus;
  lockedUntil: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateControllerAutomationParams {
  projectId: string;
  name: string;
  promptText: string;
  metadata?: Record<string, unknown> | null;
  scheduleKind: ControllerAutomationScheduleKind;
  runAt?: string | null;
  intervalHours?: number | null;
  byDay?: string[] | null;
  byHour?: number | null;
  byMinute?: number | null;
  timezone?: string | null;
  runtimeMode?: ControllerAutomationRuntimeMode | null;
  runtimeProvider?: string | null;
  silentWhenNothingToReport?: boolean | null;
  status?: ControllerAutomationStatus | null;
  accessToken?: string | null;
}

export interface UpdateControllerAutomationParams {
  automationId: string;
  name?: string | null;
  promptText?: string | null;
  metadata?: Record<string, unknown> | null;
  scheduleKind?: ControllerAutomationScheduleKind | null;
  runAt?: string | null;
  intervalHours?: number | null;
  byDay?: string[] | null;
  byHour?: number | null;
  byMinute?: number | null;
  timezone?: string | null;
  runtimeMode?: ControllerAutomationRuntimeMode | null;
  runtimeProvider?: string | null;
  silentWhenNothingToReport?: boolean | null;
  status?: ControllerAutomationStatus | null;
  accessToken?: string | null;
}

function normalizeAutomationPayload(payload: unknown): ControllerAutomation | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const projectId = typeof record.projectId === "string" ? record.projectId : "";
  const userId = typeof record.userId === "string" ? record.userId : "";
  const name = typeof record.name === "string" ? record.name : "";
  const promptText = typeof record.promptText === "string" ? record.promptText : "";
  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};

  const scheduleKind =
    record.scheduleKind === "weekly"
      ? "weekly"
      : record.scheduleKind === "once"
        ? ("once" as const)
        : ("hourly" as const);
  const runAt =
    typeof record.runAt === "string" && record.runAt.trim().length > 0 ? record.runAt : null;
  const intervalHours =
    typeof record.intervalHours === "number" ? record.intervalHours : null;
  const byDay = Array.isArray(record.byDay)
    ? record.byDay.filter((entry): entry is string => typeof entry === "string")
    : [];
  const byHour = typeof record.byHour === "number" ? record.byHour : null;
  const byMinute = typeof record.byMinute === "number" ? record.byMinute : null;
  const timezone = typeof record.timezone === "string" ? record.timezone : "UTC";
  const runtimeMode =
    record.runtimeMode === "hosted"
      ? "hosted"
      : record.runtimeMode === "existing"
        ? "existing"
        : ("auto" as const);
  const runtimeProvider =
    typeof record.runtimeProvider === "string" && record.runtimeProvider.trim()
      ? record.runtimeProvider.trim()
      : null;
  const conversationId =
    typeof record.conversationId === "string" && record.conversationId.trim()
      ? record.conversationId.trim()
      : null;
  const status = record.status === "paused" ? "paused" : ("active" as const);

  const toMaybeString = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value : null;

  return {
    id,
    projectId,
    userId,
    name,
    promptText,
    metadata,
    scheduleKind,
    runAt,
    intervalHours,
    byDay,
    byHour,
    byMinute,
    timezone,
    runtimeMode,
    runtimeProvider,
    conversationId,
    silentWhenNothingToReport: record.silentWhenNothingToReport === true,
    status,
    lockedUntil: toMaybeString(record.lockedUntil),
    lastRunAt: toMaybeString(record.lastRunAt),
    nextRunAt: toMaybeString(record.nextRunAt),
    lastError: toMaybeString(record.lastError),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

export async function fetchProjectAutomationsFromController(params: {
  projectId: string;
  accessToken?: string | null;
}): Promise<ControllerAutomation[] | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = normalizeUuidParam(params.projectId);
  if (!projectId) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    return null;
  }

  const response = await fetch(`${requestContext.baseUrl}/projects/${projectId}/automations`, {
    headers: {
      authorization: `Bearer ${sessionToken}`,
    },
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "fetch automations failed",
      requestContext,
    );
    throw new Error(message);
  }

  const data = (await response.json().catch(() => null)) as unknown;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map(normalizeAutomationPayload)
    .filter((item): item is ControllerAutomation => Boolean(item));
}

export async function createProjectAutomationInController(
  params: CreateControllerAutomationParams,
): Promise<ControllerAutomation | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const projectId = normalizeUuidParam(params.projectId);
  if (!projectId) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    return null;
  }

  const body: Record<string, unknown> = {
    name: params.name,
    promptText: params.promptText,
    scheduleKind: params.scheduleKind,
    runAt: params.runAt ?? undefined,
    intervalHours: params.intervalHours ?? undefined,
    byDay: params.byDay ?? undefined,
    byHour: params.byHour ?? undefined,
    byMinute: params.byMinute ?? undefined,
    timezone: params.timezone ?? undefined,
    runtimeMode: params.runtimeMode ?? undefined,
    runtimeProvider: params.runtimeProvider ?? undefined,
    silentWhenNothingToReport: params.silentWhenNothingToReport ?? undefined,
    status: params.status ?? undefined,
    metadata: params.metadata ?? undefined,
  };

  const response = await fetch(`${requestContext.baseUrl}/projects/${projectId}/automations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "create automation failed",
      requestContext,
    );
    throw new Error(message);
  }

  const data = (await response.json().catch(() => null)) as unknown;
  return normalizeAutomationPayload(data);
}

export async function updateAutomationInController(
  params: UpdateControllerAutomationParams,
): Promise<ControllerAutomation | null> {
  if (!runtimeControllerEnabled) {
    return null;
  }

  const automationId = normalizeUuidParam(params.automationId);
  if (!automationId) {
    return null;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    return null;
  }

  const body: Record<string, unknown> = {};
  const writeIfDefined = (key: string, value: unknown) => {
    if (typeof value !== "undefined") {
      body[key] = value;
    }
  };

  writeIfDefined("name", params.name ?? undefined);
  writeIfDefined("promptText", params.promptText ?? undefined);
  writeIfDefined("metadata", params.metadata ?? undefined);
  writeIfDefined("scheduleKind", params.scheduleKind ?? undefined);
  writeIfDefined("runAt", params.runAt ?? undefined);
  writeIfDefined("intervalHours", params.intervalHours ?? undefined);
  writeIfDefined("byDay", params.byDay ?? undefined);
  writeIfDefined("byHour", params.byHour ?? undefined);
  writeIfDefined("byMinute", params.byMinute ?? undefined);
  writeIfDefined("timezone", params.timezone ?? undefined);
  writeIfDefined("runtimeMode", params.runtimeMode ?? undefined);
  writeIfDefined("runtimeProvider", params.runtimeProvider ?? undefined);
  writeIfDefined(
    "silentWhenNothingToReport",
    params.silentWhenNothingToReport ?? undefined,
  );
  writeIfDefined("status", params.status ?? undefined);

  const response = await fetch(`${requestContext.baseUrl}/automations/${automationId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "update automation failed",
      requestContext,
    );
    throw new Error(message);
  }

  const data = (await response.json().catch(() => null)) as unknown;
  return normalizeAutomationPayload(data);
}

export async function deleteAutomationInController(params: {
  automationId: string;
  accessToken?: string | null;
}): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }

  const automationId = normalizeUuidParam(params.automationId);
  if (!automationId) {
    return false;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    return false;
  }

  const response = await fetch(`${requestContext.baseUrl}/automations/${automationId}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${sessionToken}`,
    },
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "delete automation failed",
      requestContext,
    );
    throw new Error(message);
  }

  return true;
}

export async function runAutomationNowInController(params: {
  automationId: string;
  accessToken?: string | null;
}): Promise<boolean> {
  if (!runtimeControllerEnabled) {
    return false;
  }

  const automationId = normalizeUuidParam(params.automationId);
  if (!automationId) {
    return false;
  }

  const requestContext = await resolveControllerRequestContext(params.accessToken ?? null);
  const sessionToken = requestContext.accessToken;
  if (!sessionToken) {
    return false;
  }

  const response = await fetch(`${requestContext.baseUrl}/automations/${automationId}/run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
    },
  });

  if (!response.ok) {
    const message = await readControllerError(
      response,
      "run automation failed",
      requestContext,
    );
    throw new Error(message);
  }

  return true;
}
