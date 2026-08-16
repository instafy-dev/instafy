import fs from "node:fs";
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
  preview?: boolean;
  json?: boolean;
};

export type SupportListOptions = SupportAuthOptions & {
  limit?: number;
  status?: string;
  space?: string;
  before?: string;
  json?: boolean;
};

export type SupportShowOptions = SupportAuthOptions & {
  reportId: string;
  json?: boolean;
};

type ScreenshotPayload = {
  fileName: string;
  mediaType: string;
  dataBase64: string;
  byteLength: number;
};

type JsonRecord = Record<string, unknown>;

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  return {
    id: cleanText(value["id"]),
    createdAt: cleanText(value["createdAt"]),
    updatedAt: cleanText(value["updatedAt"]),
    summary: cleanText(value["message"]) ?? "",
    status: cleanText(value["status"]) ?? "open",
    projectId: cleanText(value["projectId"]),
    screenshotCount:
      typeof value["screenshotCount"] === "number" ? value["screenshotCount"] : 0,
  };
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
    runtimeId: cleanText(value["runtimeId"]),
    runId: cleanText(value["runId"]),
    conversationId: cleanText(value["conversationId"]),
    screenshotCount: screenshots.length,
    screenshots,
  };
  return detail;
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

export async function supportReport(options: SupportReportOptions): Promise<void> {
  const summary = options.summary.replace(/\s+/g, " ").trim();
  if (!summary) throw new Error("A support report summary is required.");
  if (summary.length > MAX_SUMMARY_CHARS) {
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
  if (before) query.set("before_created_at", before);

  const response = await customerControllerJsonRequest<{ reports?: JsonRecord[] }>({
    method: "GET",
    apiPath: `/support/reports?${query.toString()}`,
    operation: "Support",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
  });
  const reports = Array.isArray(response.reports) ? response.reports.map(safeSummary) : [];
  if (options.json) {
    printJson({ reports });
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
      status: report["status"],
      summary: report["summary"],
      space: report["projectId"] ?? "",
      screenshots: report["screenshotCount"],
    })),
  );
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
