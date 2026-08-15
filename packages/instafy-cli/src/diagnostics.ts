import {
  customerControllerJsonRequest,
  type CustomerControllerAuthOptions,
} from "./customer-controller.js";
import { findProjectManifest } from "./project-manifest.js";

const DIAGNOSTICS_SCHEMA_VERSION = "instafy-diagnostics-v1";

type JsonRecord = Record<string, unknown>;

export type DiagnosticsRuntimeEventsOptions = CustomerControllerAuthOptions & {
  space?: string;
  runtimeId?: string;
  sessionId?: string;
  kind?: string;
  since?: string;
  limit?: number;
};

export type DiagnosticsRunResultOptions = CustomerControllerAuthOptions & {
  runId: string;
};

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireText(value: unknown, label: string): string {
  const text = cleanText(value);
  if (!text) throw new Error(`Diagnostics response omitted ${label}.`);
  return text;
}

function resolveSpaceId(explicitSpace?: string): string {
  const explicit = cleanText(explicitSpace);
  if (explicit) return explicit;

  for (const key of ["SPACE_ID", "INSTAFY_SPACE_ID", "PROJECT_ID", "INSTAFY_PROJECT_ID"]) {
    const value = cleanText(process.env[key]);
    if (value) return value;
  }

  const linked = cleanText(findProjectManifest(process.cwd()).manifest?.spaceId);
  if (linked) return linked;

  throw new Error("No space configured. Pass --space or run `instafy space init`.");
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Diagnostics response ${label} was not a JSON object.`);
  }
  return value as JsonRecord;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function diagnosticsRuntimeEvents(
  options: DiagnosticsRuntimeEventsOptions,
): Promise<void> {
  const spaceId = resolveSpaceId(options.space);
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("--limit must be an integer between 1 and 200.");
  }

  const query = new URLSearchParams({ limit: String(limit) });
  const runtimeId = cleanText(options.runtimeId);
  const sessionId = cleanText(options.sessionId);
  const kind = cleanText(options.kind);
  const since = cleanText(options.since);
  if (runtimeId) query.set("runtimeId", runtimeId);
  if (sessionId) query.set("sessionId", sessionId);
  if (kind) query.set("kind", kind);
  if (since) query.set("since", since);

  const response = await customerControllerJsonRequest<unknown>({
    method: "GET",
    apiPath: `/diagnostics/projects/${encodeURIComponent(spaceId)}/runtime-events?${query.toString()}`,
    operation: "Diagnostics",
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
  });
  if (!Array.isArray(response)) {
    throw new Error("Diagnostics runtime-events response was not a JSON array.");
  }

  const events = response.map((value, index) => {
    const event = requireRecord(value, `event ${index}`);
    return {
      runtimeId: requireText(event["runtimeId"], `event ${index} runtimeId`),
      kind: requireText(event["kind"], `event ${index} kind`),
      createdAt: requireText(event["createdAt"], `event ${index} createdAt`),
      data: Object.prototype.hasOwnProperty.call(event, "data") ? event["data"] : null,
    };
  });

  printJson({
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    kind: "runtime-events",
    spaceId,
    events,
  });
}

export async function diagnosticsRunResult(
  options: DiagnosticsRunResultOptions,
): Promise<void> {
  const runId = cleanText(options.runId);
  if (!runId) throw new Error("A run id is required.");

  const response = requireRecord(
    await customerControllerJsonRequest<unknown>({
      method: "GET",
      apiPath: `/diagnostics/runs/${encodeURIComponent(runId)}/result`,
      operation: "Diagnostics",
      controllerUrl: options.controllerUrl,
      accessToken: options.accessToken,
    }),
    "run-result",
  );

  printJson({
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    kind: "run-result",
    runId: requireText(response["runId"], "runId"),
    conversationId: cleanText(response["conversationId"]),
    status: requireText(response["status"], "status"),
    result: Object.prototype.hasOwnProperty.call(response, "result") ? response["result"] : null,
  });
}
