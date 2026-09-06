import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  customerControllerJsonRequest,
  type CustomerControllerAuthOptions,
} from "./customer-controller.js";
import { findProjectManifest } from "./project-manifest.js";

const MAX_SUMMARY_CHARS = 500;
const MAX_DETAILS_BYTES = 20_000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_LOGS_BYTES = 1024 * 1024;
const MAX_LOG_ENTRIES = 500;
const MAX_SCREENSHOTS = 6;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SCREENSHOT_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

type SupportAuthOptions = CustomerControllerAuthOptions;

export type SupportReportOptions = SupportAuthOptions & {
  summary: string;
  details?: string;
  detailsFile?: string;
  space?: string;
  useLinkedSpace?: boolean;
  runtimeId?: string;
  runId?: string;
  conversationId?: string;
  metadataFile?: string;
  logsFile?: string;
  screenshots?: string[];
  clientRequestId?: string;
  preview?: boolean;
  json?: boolean;
};

export type SupportListOptions = SupportAuthOptions & {
  limit?: number;
  status?: string;
  space?: string;
  before?: string;
  beforeCreatedAt?: string;
  beforeCreatedId?: string;
  beforeActivityAt?: string;
  beforeActivityId?: string;
  json?: boolean;
};

export type SupportShowOptions = SupportAuthOptions & {
  reportId: string;
  json?: boolean;
};

export type SupportMessagesOptions = SupportAuthOptions & {
  reportId: string;
  limit?: number;
  beforeCreatedAt?: string;
  beforeMessageId?: string;
  json?: boolean;
};

export type SupportReplyOptions = SupportAuthOptions & {
  reportId: string;
  message: string;
  clientRequestId?: string;
  json?: boolean;
};

type ScreenshotPayload = {
  fileName: string;
  mediaType: string;
  dataBase64: string;
  byteLength: number;
};

type JsonRecord = Record<string, unknown>;

type SafeSupportMessage = {
  id: string;
  authorType: "customer" | "support" | "system";
  body: string;
  createdAt: string;
};

type SafeSupportReportCursor =
  | { activityAt: string; id: string }
  | { createdAt: string; id: string };

type SafeSupportMessageCursor = {
  createdAt: string;
  id: string;
};

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRfc3339(value: string): boolean {
  const match = RFC3339.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    !Number.isNaN(Date.parse(value))
  );
}

function requiredCursorTimestamp(value: unknown, flag: string): string {
  const timestamp = cleanText(value);
  if (!timestamp || !isRfc3339(timestamp)) {
    throw new Error(`${flag} must be an RFC3339 timestamp.`);
  }
  return timestamp;
}

function requiredCursorUuid(value: unknown, flag: string): string {
  const id = cleanText(value);
  if (!id || !UUID.test(id)) {
    throw new Error(`${flag} must be a UUID.`);
  }
  return id;
}

function readRegularFile(filePath: string, maxBytes: number, label: string): Buffer {
  const resolved = path.resolve(filePath);
  const manifestPath = findProjectManifest(process.cwd()).path;
  const workspaceRoot = manifestPath
    ? path.dirname(path.dirname(manifestPath))
    : process.cwd();
  const canonicalRoot = fs.realpathSync(workspaceRoot);
  const canonicalParent = fs.realpathSync(path.dirname(resolved));
  const canonicalTarget = path.join(canonicalParent, path.basename(resolved));
  const relativeTarget = path.relative(canonicalRoot, canonicalTarget);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(`${label} must stay inside the active Instafy workspace.`);
  }
  const initialStat = fs.lstatSync(canonicalTarget);
  if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink.`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(canonicalTarget, fs.constants.O_RDONLY | noFollow);
  try {
    const openedStat = fs.fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== initialStat.dev ||
      openedStat.ino !== initialStat.ino ||
      openedStat.size > maxBytes
    ) {
      throw new Error(`${label} must be a regular file no larger than ${maxBytes} bytes.`);
    }
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > maxBytes) {
      throw new Error(`${label} must be ${maxBytes} bytes or smaller.`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJsonFile(filePath: string, maxBytes: number, label: string): unknown {
  const bytes = readRegularFile(filePath, maxBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function resolveDetails(options: SupportReportOptions): string | null {
  if (options.details && options.detailsFile) {
    throw new Error("Pass either --details or --details-file, not both.");
  }
  if (options.detailsFile) {
    const value = readRegularFile(options.detailsFile, MAX_DETAILS_BYTES, "Details file")
      .toString("utf8")
      .trim();
    return value || null;
  }
  const details = cleanText(options.details);
  if (details && Buffer.byteLength(details, "utf8") > MAX_DETAILS_BYTES) {
    throw new Error(`Details must be ${MAX_DETAILS_BYTES} bytes or smaller.`);
  }
  return details;
}

function resolveMetadata(filePath?: string): JsonRecord | null {
  if (!filePath) return null;
  const parsed = readJsonFile(filePath, MAX_METADATA_BYTES, "Metadata file");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Metadata file must contain a JSON object.");
  }
  return parsed as JsonRecord;
}

function resolveLogs(filePath?: string): unknown[] | null {
  if (!filePath) return null;
  const parsed = readJsonFile(filePath, MAX_LOGS_BYTES, "Logs file");
  if (!Array.isArray(parsed)) {
    throw new Error("Logs file must contain a JSON array.");
  }
  if (parsed.length > MAX_LOG_ENTRIES) {
    throw new Error(`Logs file may contain at most ${MAX_LOG_ENTRIES} entries.`);
  }
  return parsed;
}

function detectRasterMediaType(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function resolveScreenshots(filePaths: string[] = []): ScreenshotPayload[] {
  if (filePaths.length > MAX_SCREENSHOTS) {
    throw new Error(`At most ${MAX_SCREENSHOTS} screenshots can be attached.`);
  }
  let totalBytes = 0;
  return filePaths.map((filePath) => {
    const bytes = readRegularFile(filePath, MAX_SCREENSHOT_BYTES, "Screenshot");
    const mediaType = detectRasterMediaType(bytes);
    if (!mediaType) {
      throw new Error("Screenshots must be PNG, JPEG, or WebP raster images.");
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_SCREENSHOT_TOTAL_BYTES) {
      throw new Error(
        `Screenshot attachments may total at most ${MAX_SCREENSHOT_TOTAL_BYTES} bytes.`,
      );
    }
    return {
      fileName: path.basename(filePath),
      mediaType,
      dataBase64: bytes.toString("base64"),
      byteLength: bytes.length,
    };
  });
}

function resolveLinkedSpace(options: SupportReportOptions): string | null {
  const explicit = cleanText(options.space);
  if (explicit) return explicit;
  if (options.useLinkedSpace === false) return null;
  return cleanText(findProjectManifest(process.cwd()).manifest?.spaceId);
}

function safeSummary(value: JsonRecord): JsonRecord {
  const createdAt = cleanText(value["createdAt"]);
  const updatedAt = cleanText(value["updatedAt"]);
  return {
    id: cleanText(value["id"]),
    createdAt,
    activityAt: cleanText(value["activityAt"]) ?? updatedAt ?? createdAt,
    updatedAt,
    summary: cleanText(value["message"]) ?? "",
    status: cleanText(value["status"]) ?? "open",
    projectId: cleanText(value["projectId"]),
    screenshotCount:
      typeof value["screenshotCount"] === "number" ? value["screenshotCount"] : 0,
  };
}

function safeSupportReportCursor(value: unknown): SafeSupportReportCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  const activityAt = cleanText(record["activityAt"]);
  const createdAt = cleanText(record["createdAt"]);
  const id = cleanText(record["id"]);
  if (!id || !UUID.test(id) || Boolean(activityAt) === Boolean(createdAt)) {
    return null;
  }
  if (activityAt && isRfc3339(activityAt)) return { activityAt, id };
  if (createdAt && isRfc3339(createdAt)) return { createdAt, id };
  return null;
}

function safeSupportMessageCursor(value: unknown): SafeSupportMessageCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  const createdAt = cleanText(record["createdAt"]);
  const id = cleanText(record["id"]);
  if (!createdAt || !isRfc3339(createdAt) || !id || !UUID.test(id)) {
    return null;
  }
  return { createdAt, id };
}

function safeDetail(value: JsonRecord): JsonRecord {
  const screenshots = Array.isArray(value["screenshots"])
    ? value["screenshots"].map((entry) => {
        const screenshot = entry && typeof entry === "object" ? (entry as JsonRecord) : {};
        return {
          id: cleanText(screenshot["id"]),
          fileName: cleanText(screenshot["fileName"]),
          mediaType: cleanText(screenshot["mediaType"]),
          byteSize: typeof screenshot["byteSize"] === "number" ? screenshot["byteSize"] : 0,
        };
      })
    : [];
  const detail: JsonRecord = {
    ...safeSummary(value),
    details: cleanText(value["details"]),
    screenshotCount: screenshots.length,
    screenshots,
  };
  return detail;
}

function safeSupportMessage(value: unknown): SafeSupportMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  const id = cleanText(record["id"]);
  const authorType = cleanText(record["authorType"]);
  const body = cleanText(record["body"]);
  const createdAt = cleanText(record["createdAt"]);
  if (
    !id ||
    !body ||
    !createdAt ||
    (authorType !== "customer" && authorType !== "support" && authorType !== "system")
  ) {
    return null;
  }
  return { id, authorType, body, createdAt };
}

function requireSupportMessage(value: unknown): SafeSupportMessage {
  const message = safeSupportMessage(value);
  if (!message) {
    throw new Error("Support response contained an invalid message.");
  }
  return message;
}

function supportAuthorLabel(authorType: SafeSupportMessage["authorType"]): string {
  if (authorType === "customer") return "You";
  if (authorType === "support") return "Support";
  return "Status";
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

export async function supportReport(options: SupportReportOptions): Promise<void> {
  const summary = options.summary.replace(/\s+/g, " ").trim();
  if (!summary) throw new Error("A support report summary is required.");
  if (Array.from(summary).length > MAX_SUMMARY_CHARS) {
    throw new Error(`Support report summary must be ${MAX_SUMMARY_CHARS} characters or shorter.`);
  }

  const details = resolveDetails(options);
  const projectId = resolveLinkedSpace(options);
  const runtimeId = cleanText(options.runtimeId);
  const runId = cleanText(options.runId);
  const conversationId = cleanText(options.conversationId);
  if (!projectId && (runtimeId || runId || conversationId)) {
    throw new Error("--space is required when runtime, run, or conversation context is supplied.");
  }
  const metadata = resolveMetadata(options.metadataFile);
  const logs = resolveLogs(options.logsFile);
  const screenshots = resolveScreenshots(options.screenshots);

  const payload: JsonRecord = { message: summary };
  if (details) payload["details"] = details;
  if (projectId) payload["projectId"] = projectId;
  if (runtimeId) payload["runtimeId"] = runtimeId;
  if (runId) payload["runId"] = runId;
  if (conversationId) payload["conversationId"] = conversationId;
  if (metadata) payload["metadata"] = metadata;
  if (logs) payload["logs"] = logs;
  if (screenshots.length) payload["screenshots"] = screenshots;

  if (options.preview) {
    const preview = {
      upload: false,
      supportAccountIdentityIncluded: true,
      summary,
      detailsIncluded: Boolean(details),
      projectId,
      runtimeId,
      runId,
      conversationId,
      metadataKeys: metadata ? Object.keys(metadata).sort() : [],
      logEntryCount: logs?.length ?? 0,
      screenshots: screenshots.map(({ fileName, mediaType, byteLength }) => ({
        fileName,
        mediaType,
        byteLength,
      })),
    };
    printJson(preview);
    return;
  }

  const clientRequestId = cleanText(options.clientRequestId) ?? randomUUID();
  if (!UUID.test(clientRequestId)) {
    throw new Error("--client-request-id must be a UUID.");
  }
  payload["clientRequestId"] = clientRequestId;
  console.error(
    `Support report request id: ${clientRequestId} (reuse it only to retry this exact report).`,
  );

  const response = await customerControllerJsonRequest<JsonRecord>({
    method: "POST",
    apiPath: "/support/reports",
    operation: "Support",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    body: payload,
  });
  const result = {
    id: cleanText(response["id"]),
    createdAt: cleanText(response["createdAt"]),
    status: "open",
  };
  if (!result.id) {
    throw new Error("Support report was submitted but the controller returned no report id.");
  }
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`Support report ${result.id} submitted${result.createdAt ? ` at ${result.createdAt}` : ""}.`);
}

export async function supportList(options: SupportListOptions): Promise<void> {
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer between 1 and 100.");
  }
  const status = cleanText(options.status);
  if (status && !["open", "in_progress", "resolved"].includes(status)) {
    throw new Error("--status must be open, in_progress, or resolved.");
  }
  const query = new URLSearchParams({ limit: String(limit) });
  if (status) query.set("status", status);
  const projectId = cleanText(options.space);
  if (projectId) query.set("project_id", projectId);
  const before = cleanText(options.before);
  const beforeCreatedAt = cleanText(options.beforeCreatedAt);
  const beforeCreatedId = cleanText(options.beforeCreatedId);
  const beforeActivityAt = cleanText(options.beforeActivityAt);
  const beforeActivityId = cleanText(options.beforeActivityId);
  if (Boolean(beforeCreatedAt) !== Boolean(beforeCreatedId)) {
    throw new Error(
      "--before-created-at and --before-created-id must be used together.",
    );
  }
  if (Boolean(beforeActivityAt) !== Boolean(beforeActivityId)) {
    throw new Error(
      "--before-activity-at and --before-activity-id must be used together.",
    );
  }
  if (before && (beforeCreatedAt || beforeActivityAt)) {
    throw new Error("--before cannot be combined with the paired cursor flags.");
  }
  if (beforeCreatedAt && beforeActivityAt) {
    throw new Error("Created-at and activity cursor flags cannot be combined.");
  }
  if (before) {
    query.set("before_created_at", requiredCursorTimestamp(before, "--before"));
  }
  if (beforeCreatedAt && beforeCreatedId) {
    query.set(
      "before_created_at",
      requiredCursorTimestamp(beforeCreatedAt, "--before-created-at"),
    );
    query.set(
      "before_created_id",
      requiredCursorUuid(beforeCreatedId, "--before-created-id"),
    );
  }
  if (beforeActivityAt && beforeActivityId) {
    query.set(
      "before_activity_at",
      requiredCursorTimestamp(beforeActivityAt, "--before-activity-at"),
    );
    query.set(
      "before_activity_id",
      requiredCursorUuid(beforeActivityId, "--before-activity-id"),
    );
  }

  const response = await customerControllerJsonRequest<{
    reports?: JsonRecord[];
    hasMore?: unknown;
    nextCursor?: unknown;
  }>({
    method: "GET",
    apiPath: `/support/reports?${query.toString()}`,
    operation: "Support",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
  });
  const reports = Array.isArray(response.reports) ? response.reports.map(safeSummary) : [];
  const nextCursor = safeSupportReportCursor(response.nextCursor);
  const hasMore = response.hasMore === true && nextCursor !== null;
  if (options.json) {
    printJson({ reports, hasMore, nextCursor: hasMore ? nextCursor : null });
    return;
  }
  if (!reports.length) {
    console.log("No support reports found.");
    return;
  }
  console.table(
    reports.map((report) => ({
      id: report["id"],
      createdAt: report["createdAt"],
      activityAt: report["activityAt"],
      status: report["status"],
      summary: report["summary"],
      space: report["projectId"] ?? "",
      screenshots: report["screenshotCount"],
    })),
  );
  if (hasMore && nextCursor) {
    if ("activityAt" in nextCursor) {
      console.log(
        `More reports: rerun with --before-activity-at ${nextCursor.activityAt} --before-activity-id ${nextCursor.id}`,
      );
    } else {
      console.log(
        `More reports: rerun with --before-created-at ${nextCursor.createdAt} --before-created-id ${nextCursor.id}`,
      );
    }
  }
}

export async function supportShow(options: SupportShowOptions): Promise<void> {
  const reportId = cleanText(options.reportId);
  if (!reportId) throw new Error("A support report id is required.");
  const response = await customerControllerJsonRequest<JsonRecord>({
    method: "GET",
    apiPath: `/support/reports/${encodeURIComponent(reportId)}`,
    operation: "Support",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
  });
  const report = safeDetail(response);
  if (options.json) {
    printJson(report);
    return;
  }
  console.log(`${report["summary"]} (${report["status"]})`);
  console.log(`Report: ${report["id"]}`);
  if (report["createdAt"]) console.log(`Created: ${report["createdAt"]}`);
  if (report["projectId"]) console.log(`Space: ${report["projectId"]}`);
  if (report["details"]) console.log(`\n${report["details"]}`);
  const screenshots = Array.isArray(report["screenshots"]) ? report["screenshots"] : [];
  if (screenshots.length) console.log(`\nScreenshots: ${screenshots.length} (content not printed)`);
}

export async function supportMessages(options: SupportMessagesOptions): Promise<void> {
  const reportId = cleanText(options.reportId);
  if (!reportId) throw new Error("A support report id is required.");
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer between 1 and 100.");
  }
  const beforeCreatedAt = cleanText(options.beforeCreatedAt);
  const beforeMessageId = cleanText(options.beforeMessageId);
  if (Boolean(beforeCreatedAt) !== Boolean(beforeMessageId)) {
    throw new Error(
      "--before-created-at and --before-message-id must be used together.",
    );
  }
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeCreatedAt && beforeMessageId) {
    query.set(
      "before_created_at",
      requiredCursorTimestamp(beforeCreatedAt, "--before-created-at"),
    );
    query.set(
      "before_message_id",
      requiredCursorUuid(beforeMessageId, "--before-message-id"),
    );
  }
  const response = await customerControllerJsonRequest<{
    messages?: unknown[];
    hasMore?: unknown;
    nextCursor?: unknown;
  }>({
    method: "GET",
    apiPath: `/support/reports/${encodeURIComponent(reportId)}/messages?${query.toString()}`,
    operation: "Support",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
  });
  const messages = Array.isArray(response.messages)
    ? response.messages.map(safeSupportMessage).filter((message): message is SafeSupportMessage => message !== null)
    : [];
  const nextCursor = safeSupportMessageCursor(response.nextCursor);
  const hasMore = response.hasMore === true && nextCursor !== null;
  if (options.json) {
    printJson({ messages, hasMore, nextCursor: hasMore ? nextCursor : null });
    return;
  }
  if (!messages.length) {
    console.log("No support follow-ups yet.");
    return;
  }
  for (const message of messages) {
    console.log(`[${message.createdAt}] ${supportAuthorLabel(message.authorType)}: ${message.body}`);
  }
  if (hasMore && nextCursor) {
    console.log(
      `Older messages: rerun with --before-created-at ${nextCursor.createdAt} --before-message-id ${nextCursor.id}`,
    );
  }
}

export async function supportReply(options: SupportReplyOptions): Promise<void> {
  const reportId = cleanText(options.reportId);
  if (!reportId) throw new Error("A support report id is required.");
  const message = cleanText(options.message);
  if (!message) throw new Error("A follow-up message is required.");
  if (
    Array.from(message).length > MAX_MESSAGE_CHARS ||
    Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES
  ) {
    throw new Error(
      `A follow-up must be at most ${MAX_MESSAGE_CHARS} characters and ${MAX_MESSAGE_BYTES} bytes.`,
    );
  }
  const clientRequestId = cleanText(options.clientRequestId) ?? randomUUID();
  if (!UUID.test(clientRequestId)) {
    throw new Error("--client-request-id must be a UUID.");
  }
  console.error(
    `Support follow-up request id: ${clientRequestId} (reuse it only to retry this exact message).`,
  );
  const response = await customerControllerJsonRequest<{ message?: unknown }>({
    method: "POST",
    apiPath: `/support/reports/${encodeURIComponent(reportId)}/messages`,
    operation: "Support",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
    body: {
      body: message,
      clientRequestId,
    },
  });
  const posted = requireSupportMessage(response.message);
  if (options.json) {
    printJson({ message: posted });
    return;
  }
  console.log(`Follow-up added to support report ${reportId}.`);
}
