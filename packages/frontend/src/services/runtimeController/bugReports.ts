import {
  controllerBaseUrl,
  readControllerError,
  resolveControllerAccessToken,
  runtimeControllerEnabled,
} from "./core";
import type { BuildLogEntry } from "../../types";

export interface BugReportScreenshotPayload {
  fileName: string;
  mediaType: string;
  dataBase64: string;
  byteLength: number;
}

export interface SubmitControllerBugReportParams {
  message: string;
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

export interface ControllerBugReportSummary {
  id: string;
  createdAt: string | null;
  message: string;
  details: string | null;
  status: string;
  reporterEmail: string | null;
  userId: string | null;
  projectId: string | null;
  runtimeId: string | null;
  runId: string | null;
  conversationId: string | null;
  metadata: Record<string, unknown>;
  logs: unknown[];
  screenshotCount: number;
}

export interface ControllerBugReportAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  dataBase64: string;
}

export interface ControllerBugReportDetail extends ControllerBugReportSummary {
  screenshots: ControllerBugReportAttachment[];
}

function parseBugReportSummary(
  value: Record<string, unknown> | null | undefined,
): ControllerBugReportSummary | null {
  if (!value || typeof value.id !== "string" || typeof value.message !== "string") {
    return null;
  }
  return {
    id: value.id,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    message: value.message,
    details: typeof value.details === "string" ? value.details : null,
    status: typeof value.status === "string" ? value.status : "open",
    reporterEmail: typeof value.reporterEmail === "string" ? value.reporterEmail : null,
    userId: typeof value.userId === "string" ? value.userId : null,
    projectId: typeof value.projectId === "string" ? value.projectId : null,
    runtimeId: typeof value.runtimeId === "string" ? value.runtimeId : null,
    runId: typeof value.runId === "string" ? value.runId : null,
    conversationId: typeof value.conversationId === "string" ? value.conversationId : null,
    metadata:
      value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
        ? (value.metadata as Record<string, unknown>)
        : {},
    logs: Array.isArray(value.logs) ? value.logs : [],
    screenshotCount: typeof value.screenshotCount === "number" ? value.screenshotCount : 0,
  };
}

export async function submitControllerBugReport(
  params: SubmitControllerBugReportParams,
): Promise<SubmitControllerBugReportResult | null> {
  if (!runtimeControllerEnabled) {
    throw new Error("Bug reports are unavailable in this environment.");
  }

  const accessToken = await resolveControllerAccessToken(null);
  if (!accessToken) {
    throw new Error("Login required to submit bug reports.");
  }

  const response = await fetch(`${controllerBaseUrl}/bug-reports`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: params.message,
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
    const message = await readControllerError(response, "bug report failed");
    throw new Error(message);
  }

  const body = (await response.json().catch(() => null)) as
    | { id?: string | null; createdAt?: string | null }
    | null;

  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) {
    throw new Error("Bug report submitted but the controller did not return an id.");
  }

  return {
    id,
    createdAt: typeof body?.createdAt === "string" ? body.createdAt : null,
  };
}

export async function listControllerBugReports(limit = 25): Promise<ControllerBugReportSummary[]> {
  if (!runtimeControllerEnabled) {
    throw new Error("Bug reports are unavailable in this environment.");
  }

  const accessToken = await resolveControllerAccessToken(null);
  if (!accessToken) {
    throw new Error("Login required to view bug reports.");
  }

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  const response = await fetch(`${controllerBaseUrl}/bug-reports?${params.toString()}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const message = await readControllerError(response, "bug report list failed");
    throw new Error(message);
  }

  const body = (await response.json().catch(() => null)) as
    | { reports?: Record<string, unknown>[] }
    | null;

  return Array.isArray(body?.reports)
    ? body.reports
        .map((report) => parseBugReportSummary(report))
        .filter((report): report is ControllerBugReportSummary => report !== null)
    : [];
}

export async function getControllerBugReport(
  bugReportId: string,
): Promise<ControllerBugReportDetail> {
  if (!runtimeControllerEnabled) {
    throw new Error("Bug reports are unavailable in this environment.");
  }

  const accessToken = await resolveControllerAccessToken(null);
  if (!accessToken) {
    throw new Error("Login required to view bug reports.");
  }

  const response = await fetch(`${controllerBaseUrl}/bug-reports/${bugReportId}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const message = await readControllerError(response, "bug report load failed");
    throw new Error(message);
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const summary = parseBugReportSummary(body);
  if (!summary) {
    throw new Error("Bug report response was missing required fields.");
  }
  const screenshots = Array.isArray(body?.screenshots)
    ? body.screenshots
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const value = entry as Record<string, unknown>;
          if (
            typeof value.id !== "string" ||
            typeof value.fileName !== "string" ||
            typeof value.mediaType !== "string" ||
            typeof value.dataBase64 !== "string"
          ) {
            return null;
          }
          return {
            id: value.id,
            fileName: value.fileName,
            mediaType: value.mediaType,
            byteSize: typeof value.byteSize === "number" ? value.byteSize : 0,
            dataBase64: value.dataBase64,
          } satisfies ControllerBugReportAttachment;
        })
        .filter((entry): entry is ControllerBugReportAttachment => entry !== null)
    : [];

  return {
    ...summary,
    screenshots,
  };
}
