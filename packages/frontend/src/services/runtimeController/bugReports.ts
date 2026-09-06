import {
  readControllerError,
  resolveControllerRequestContext,
  runtimeControllerEnabled,
} from "./core";
import type { BuildLogEntry } from "../../types";

const MAX_SUPPORT_MESSAGE_LENGTH = 4_000;

export interface BugReportScreenshotPayload {
  fileName: string;
  mediaType: string;
  dataBase64: string;
  byteLength: number;
}

export interface SubmitControllerBugReportParams {
  message: string;
  clientRequestId?: string;
  expectedUserId?: string | null;
  details?: string | null;
  projectId?: string | null;
  runtimeId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  metadata?: Record<string, unknown> | null;
  logs?: BuildLogEntry[];
  screenshots?: BugReportScreenshotPayload[];
}

export interface SubmitControllerBugReportResult {
  id: string;
  createdAt: string | null;
}

/** The intentionally small customer projection returned by /support/reports. */
export interface ControllerBugReportSummary {
  id: string;
  createdAt: string | null;
  activityAt: string | null;
  updatedAt: string | null;
  message: string;
  status: string;
  projectId: string | null;
  screenshotCount: number;
  customerLastMessageAt: string | null;
  supportLastMessageAt: string | null;
  resolvedAt: string | null;
  hasUnreadSupportActivity: boolean;
  hasUnreadResolution: boolean;
}

/** Attachment metadata only. The customer API never returns stored attachment bytes. */
export interface ControllerBugReportAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
}

export interface ControllerBugReportDetail {
  id: string;
  createdAt: string | null;
  activityAt: string | null;
  updatedAt: string | null;
  message: string;
  details: string | null;
  status: string;
  projectId: string | null;
  screenshots: ControllerBugReportAttachment[];
  customerLastMessageAt: string | null;
  supportLastMessageAt: string | null;
  resolvedAt: string | null;
  hasUnreadSupportActivity: boolean;
  hasUnreadResolution: boolean;
}

export type ControllerBugReportMessageAuthor = "customer" | "support" | "system";

export interface ControllerBugReportMessage {
  id: string;
  authorType: ControllerBugReportMessageAuthor;
  body: string;
  createdAt: string | null;
}

export interface ControllerBugReportListCursor {
  activityAt: string;
  id: string;
}

export interface ControllerBugReportListPage {
  reports: ControllerBugReportSummary[];
  hasMore: boolean;
  nextCursor: ControllerBugReportListCursor | null;
  unreadCount: number;
  unreadResolutionCount: number;
  unnotifiedResolutionCount: number;
}

export interface AcknowledgeControllerBugReportActivityResult {
  acknowledgedThrough: string;
  hasUnreadSupportActivity: boolean;
  hasUnreadResolution: boolean;
}

export interface ClaimControllerSupportResolutionAlertsResult {
  claimedCount: number;
  latestReportId: string | null;
  latestResolvedAt: string | null;
}

export interface ControllerBugReportMessageListCursor {
  createdAt: string;
  id: string;
}

export interface ControllerBugReportMessageListPage {
  messages: ControllerBugReportMessage[];
  hasMore: boolean;
  nextCursor: ControllerBugReportMessageListCursor | null;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseBugReportSummary(
  value: Record<string, unknown> | null | undefined,
): ControllerBugReportSummary | null {
  if (!value || typeof value.id !== "string" || typeof value.message !== "string") {
    return null;
  }
  return {
    id: value.id,
    createdAt: parseNullableString(value.createdAt),
    activityAt: parseNullableString(value.activityAt),
    updatedAt: parseNullableString(value.updatedAt),
    message: value.message,
    status: typeof value.status === "string" ? value.status : "open",
    projectId: parseNullableString(value.projectId),
    screenshotCount: typeof value.screenshotCount === "number" ? value.screenshotCount : 0,
    customerLastMessageAt: parseNullableString(value.customerLastMessageAt),
    supportLastMessageAt: parseNullableString(value.supportLastMessageAt),
    resolvedAt: parseNullableString(value.resolvedAt),
    hasUnreadSupportActivity: value.hasUnreadSupportActivity === true,
    hasUnreadResolution: value.hasUnreadResolution === true,
  };
}

function parseBugReportAttachment(value: unknown): ControllerBugReportAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.fileName !== "string" ||
    typeof entry.mediaType !== "string"
  ) {
    return null;
  }
  return {
    id: entry.id,
    fileName: entry.fileName,
    mediaType: entry.mediaType,
    byteSize: typeof entry.byteSize === "number" ? entry.byteSize : 0,
  };
}

function parseBugReportDetail(
  value: Record<string, unknown> | null | undefined,
): ControllerBugReportDetail | null {
  if (!value || typeof value.id !== "string" || typeof value.message !== "string") {
    return null;
  }
  return {
    id: value.id,
    createdAt: parseNullableString(value.createdAt),
    activityAt: parseNullableString(value.activityAt),
    updatedAt: parseNullableString(value.updatedAt),
    message: value.message,
    details: parseNullableString(value.details),
    status: typeof value.status === "string" ? value.status : "open",
    projectId: parseNullableString(value.projectId),
    screenshots: Array.isArray(value.screenshots)
      ? value.screenshots
          .map((attachment) => parseBugReportAttachment(attachment))
          .filter((attachment): attachment is ControllerBugReportAttachment => attachment !== null)
      : [],
    customerLastMessageAt: parseNullableString(value.customerLastMessageAt),
    supportLastMessageAt: parseNullableString(value.supportLastMessageAt),
    resolvedAt: parseNullableString(value.resolvedAt),
    hasUnreadSupportActivity: value.hasUnreadSupportActivity === true,
    hasUnreadResolution: value.hasUnreadResolution === true,
  };
}

function parseBugReportMessage(value: unknown): ControllerBugReportMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.body !== "string" ||
    (entry.authorType !== "customer" &&
      entry.authorType !== "support" &&
      entry.authorType !== "system")
  ) {
    return null;
  }
  return {
    id: entry.id,
    authorType: entry.authorType,
    body: entry.body,
    createdAt: parseNullableString(entry.createdAt),
  };
}

async function resolveSupportRequestContext(loginMessage: string) {
  if (!runtimeControllerEnabled) {
    throw new Error("Support is unavailable in this environment.");
  }
  const requestContext = await resolveControllerRequestContext(null);
  if (!requestContext.accessToken) {
    throw new Error(loginMessage);
  }
  return { requestContext, accessToken: requestContext.accessToken };
}

export async function submitControllerBugReport(
  params: SubmitControllerBugReportParams,
): Promise<SubmitControllerBugReportResult | null> {
  const { requestContext, accessToken } = await resolveSupportRequestContext(
    "Login required to submit support reports.",
  );

  const response = await fetch(`${requestContext.baseUrl}/support/reports`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: params.message,
      clientRequestId:
        params.clientRequestId?.trim() || createControllerBugReportRequestId(),
      expectedUserId: params.expectedUserId ?? null,
      details: params.details ?? null,
      projectId: params.projectId ?? null,
      runtimeId: params.runtimeId ?? null,
      runId: params.runId ?? null,
      conversationId: params.conversationId ?? null,
      metadata: params.metadata ?? {},
      logs: params.logs ?? [],
      screenshots: params.screenshots ?? [],
    }),
  });

  if (!response.ok) {
    const message = await readControllerError(response, "support report failed", requestContext);
    throw new Error(message);
  }

  const body = (await response.json().catch(() => null)) as
    | { id?: string | null; createdAt?: string | null }
    | null;

  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) {
    throw new Error("Support report submitted but the controller did not return an id.");
  }

  return {
    id,
    createdAt: typeof body?.createdAt === "string" ? body.createdAt : null,
  };
}

function parseBugReportListCursor(value: unknown): ControllerBugReportListCursor | null {
  if (!value || typeof value !== "object") return null;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.activityAt === "string" && typeof cursor.id === "string"
    ? { activityAt: cursor.activityAt, id: cursor.id }
    : null;
}

export async function listControllerBugReportPage(
  limit = 25,
  before: ControllerBugReportListCursor | null = null,
  expectedUserId: string | null = null,
): Promise<ControllerBugReportListPage> {
  const { requestContext, accessToken } = await resolveSupportRequestContext(
    "Login required to view support reports.",
  );

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  const normalizedExpectedUserId = expectedUserId?.trim() ?? "";
  if (normalizedExpectedUserId) {
    params.set("expected_user_id", normalizedExpectedUserId);
  }
  if (before) {
    params.set("before_activity_at", before.activityAt);
    params.set("before_activity_id", before.id);
  }
  const response = await fetch(`${requestContext.baseUrl}/support/reports?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const message = await readControllerError(response, "support report list failed", requestContext);
    throw new Error(message);
  }

  const body = (await response.json().catch(() => null)) as
    | {
        reports?: Record<string, unknown>[];
        hasMore?: boolean;
        nextCursor?: unknown;
        unreadCount?: number;
        unreadResolutionCount?: number;
        unnotifiedResolutionCount?: number;
      }
    | null;

  const reports = Array.isArray(body?.reports)
    ? body.reports
        .map((report) => parseBugReportSummary(report))
        .filter((report): report is ControllerBugReportSummary => report !== null)
    : [];
  const nextCursor = parseBugReportListCursor(body?.nextCursor);
  return {
    reports,
    hasMore: body?.hasMore === true && nextCursor !== null,
    nextCursor,
    unreadCount: typeof body?.unreadCount === "number" ? body.unreadCount : 0,
    unreadResolutionCount:
      typeof body?.unreadResolutionCount === "number" ? body.unreadResolutionCount : 0,
    unnotifiedResolutionCount:
      typeof body?.unnotifiedResolutionCount === "number"
        ? body.unnotifiedResolutionCount
        : 0,
  };
}

export async function listControllerBugReports(
  limit = 25,
  expectedUserId: string | null = null,
): Promise<ControllerBugReportSummary[]> {
  return (await listControllerBugReportPage(limit, null, expectedUserId)).reports;
}

export async function getControllerBugReport(
  bugReportId: string,
): Promise<ControllerBugReportDetail> {
  const { requestContext, accessToken } = await resolveSupportRequestContext(
    "Login required to view support reports.",
  );

  const response = await fetch(
    `${requestContext.baseUrl}/support/reports/${encodeURIComponent(bugReportId)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) {
    const message = await readControllerError(response, "support report load failed", requestContext);
    throw new Error(message);
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const report = parseBugReportDetail(body);
  if (!report) {
    throw new Error("Support report response was missing required fields.");
  }
  return report;
}

export async function acknowledgeControllerBugReportActivity(
  bugReportId: string,
  seenThrough: string,
): Promise<AcknowledgeControllerBugReportActivityResult> {
  const normalizedSeenThrough = seenThrough.trim();
  if (!normalizedSeenThrough || Number.isNaN(Date.parse(normalizedSeenThrough))) {
    throw new Error("Support activity timestamp is invalid.");
  }
  const { requestContext, accessToken } = await resolveSupportRequestContext(
    "Login required to acknowledge support activity.",
  );
  const response = await fetch(
    `${requestContext.baseUrl}/support/reports/${encodeURIComponent(bugReportId)}/acknowledge`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ seenThrough: normalizedSeenThrough }),
    },
  );
  if (!response.ok) {
    const message = await readControllerError(
      response,
      "support activity acknowledgement failed",
      requestContext,
    );
    throw new Error(message);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.acknowledgedThrough !== "string") {
    throw new Error("Support activity was acknowledged but the controller returned an invalid response.");
  }
  return {
    acknowledgedThrough: body.acknowledgedThrough,
    hasUnreadSupportActivity: body.hasUnreadSupportActivity === true,
    hasUnreadResolution: body.hasUnreadResolution === true,
  };
}

export async function claimControllerSupportResolutionAlerts(
  expectedUserId: string,
): Promise<ClaimControllerSupportResolutionAlertsResult> {
  const normalizedExpectedUserId = expectedUserId.trim();
  if (!normalizedExpectedUserId) {
    throw new Error("Login required to check support resolution alerts.");
  }
  const { requestContext, accessToken } = await resolveSupportRequestContext(
    "Login required to check support resolution alerts.",
  );
  const response = await fetch(`${requestContext.baseUrl}/support/resolution-alerts/claim`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedUserId: normalizedExpectedUserId }),
  });
  if (!response.ok) {
    const message = await readControllerError(
      response,
      "support resolution alert claim failed",
      requestContext,
    );
    throw new Error(message);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return {
    claimedCount:
      typeof body?.claimedCount === "number" && Number.isFinite(body.claimedCount)
        ? Math.max(0, Math.floor(body.claimedCount))
        : 0,
    latestReportId:
      typeof body?.latestReportId === "string" && body.latestReportId.trim()
        ? body.latestReportId
        : null,
    latestResolvedAt:
      typeof body?.latestResolvedAt === "string" && body.latestResolvedAt.trim()
        ? body.latestResolvedAt
        : null,
  };
}

function parseBugReportMessageListCursor(
  value: unknown,
): ControllerBugReportMessageListCursor | null {
  if (!value || typeof value !== "object") return null;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.createdAt === "string" && typeof cursor.id === "string"
    ? { createdAt: cursor.createdAt, id: cursor.id }
    : null;
}

export async function listControllerBugReportMessagePage(
  bugReportId: string,
  options: {
    limit?: number;
    before?: ControllerBugReportMessageListCursor | null;
  } = {},
): Promise<ControllerBugReportMessageListPage> {
  const { requestContext, accessToken } = await resolveSupportRequestContext(
    "Login required to view support conversations.",
  );
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.before) {
    params.set("before_created_at", options.before.createdAt);
    params.set("before_message_id", options.before.id);
  }
  const query = params.size ? `?${params.toString()}` : "";
  const response = await fetch(
    `${requestContext.baseUrl}/support/reports/${encodeURIComponent(bugReportId)}/messages${query}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    const message = await readControllerError(
      response,
      "support conversation load failed",
      requestContext,
    );
    throw new Error(message);
  }
  const responseBody = (await response.json().catch(() => null)) as
    | { messages?: unknown[]; hasMore?: boolean; nextCursor?: unknown }
    | null;
  const messages = Array.isArray(responseBody?.messages)
    ? responseBody.messages
        .map((message) => parseBugReportMessage(message))
        .filter((message): message is ControllerBugReportMessage => message !== null)
    : [];
  const nextCursor = parseBugReportMessageListCursor(responseBody?.nextCursor);
  return {
    messages,
    hasMore: responseBody?.hasMore === true && nextCursor !== null,
    nextCursor,
  };
}

export async function listControllerBugReportMessages(
  bugReportId: string,
): Promise<ControllerBugReportMessage[]> {
  return (await listControllerBugReportMessagePage(bugReportId)).messages;
}

export function createControllerBugReportRequestId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fall through to a locally generated v4 UUID. The value is an idempotency
    // key, not a credential, so the fallback only needs collision resistance.
  }

  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function createControllerBugReportMessageRequestId(): string {
  return createControllerBugReportRequestId();
}

export async function postControllerBugReportMessage(
  bugReportId: string,
  body: string,
  clientRequestId?: string,
): Promise<ControllerBugReportMessage> {
  const normalizedBody = body.trim();
  if (!normalizedBody) {
    throw new Error("Write a message before sending.");
  }
  if (Array.from(normalizedBody).length > MAX_SUPPORT_MESSAGE_LENGTH) {
    throw new Error(
      `Support messages must be ${MAX_SUPPORT_MESSAGE_LENGTH.toLocaleString()} characters or shorter.`,
    );
  }
  const { requestContext, accessToken } = await resolveSupportRequestContext(
    "Login required to reply to support conversations.",
  );
  const requestId = clientRequestId?.trim() || createControllerBugReportMessageRequestId();
  const response = await fetch(
    `${requestContext.baseUrl}/support/reports/${encodeURIComponent(bugReportId)}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: normalizedBody,
        clientRequestId: requestId,
      }),
    },
  );
  if (!response.ok) {
    const message = await readControllerError(
      response,
      "support conversation reply failed",
      requestContext,
    );
    throw new Error(message);
  }
  const responseBody = (await response.json().catch(() => null)) as
    | { message?: unknown }
    | Record<string, unknown>
    | null;
  const message = parseBugReportMessage(
    responseBody && "message" in responseBody ? responseBody.message : responseBody,
  );
  if (!message) {
    throw new Error("Support reply was accepted but the controller returned an invalid message.");
  }
  return message;
}
