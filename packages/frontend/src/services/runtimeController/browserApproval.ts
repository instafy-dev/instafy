export type RuntimeSharedBrowserApprovalKind = "origin" | "action";
export type RuntimeSharedBrowserApprovalDecision = "allow_origin" | "allow_once" | "deny";
export type RuntimeSharedBrowserApprovalOperation =
  | "approve-origin"
  | "navigate"
  | "click"
  | "type"
  | "form-submit"
  | "press-key"
  | "press-enter"
  | "press-space";

export type RuntimeSharedBrowserApprovalRequest = {
  version: 1;
  approvalId: string;
  kind: RuntimeSharedBrowserApprovalKind;
  ownerId: string;
  runId: string;
  initiatorUserId: string;
  browserPageId: string;
  operation: RuntimeSharedBrowserApprovalOperation;
  sourceOrigin: string | null;
  destinationOrigin: string | null;
  destinationFingerprint: string;
  snapshotId: string | null;
  targetFingerprint: string | null;
  payloadFingerprint: string | null;
  requestedAtMs: number;
  expiresAtMs: number;
  requestFingerprint: string;
  display: {
    label: string;
    destinationOrigin: string | null;
  };
};

export type RuntimeSharedBrowserPendingApproval = {
  runtimeId: string;
  request: RuntimeSharedBrowserApprovalRequest;
};

const APPROVAL_KINDS = new Set<RuntimeSharedBrowserApprovalKind>(["origin", "action"]);
const APPROVAL_OPERATIONS = new Set<RuntimeSharedBrowserApprovalOperation>([
  "approve-origin",
  "navigate",
  "click",
  "type",
  "form-submit",
  "press-key",
  "press-enter",
  "press-space",
]);
const APPROVAL_DECISIONS = new Set<RuntimeSharedBrowserApprovalDecision>([
  "allow_origin",
  "allow_once",
  "deny",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const APPROVAL_REQUEST_KEYS = new Set([
  "version",
  "approvalId",
  "kind",
  "ownerId",
  "runId",
  "initiatorUserId",
  "browserPageId",
  "operation",
  "sourceOrigin",
  "destinationOrigin",
  "destinationFingerprint",
  "snapshotId",
  "targetFingerprint",
  "payloadFingerprint",
  "requestedAtMs",
  "expiresAtMs",
  "requestFingerprint",
  "display",
]);

function buildOriginEndpointUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function hasExactKeys(record: Record<string, unknown>, keys: Set<string>): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableSha256(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SHA256_PATTERN.test(value));
}

export function mapRuntimeSharedBrowserPendingApprovalPayload(
  payload: unknown,
): RuntimeSharedBrowserPendingApproval | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const envelope = payload as Record<string, unknown>;
  if (!hasExactKeys(envelope, new Set(["pending"]))) {
    return null;
  }
  if (envelope.pending === null) {
    return null;
  }
  if (!envelope.pending || typeof envelope.pending !== "object") {
    return null;
  }
  const pending = envelope.pending as Record<string, unknown>;
  if (!hasExactKeys(pending, new Set(["runtimeId", "request"]))) {
    return null;
  }
  const runtimeId = typeof pending.runtimeId === "string" ? pending.runtimeId : "";
  if (!UUID_PATTERN.test(runtimeId) || !pending.request || typeof pending.request !== "object") {
    return null;
  }

  const request = pending.request as Record<string, unknown>;
  const display = request.display;
  if (
    !hasExactKeys(request, APPROVAL_REQUEST_KEYS) ||
    !display ||
    typeof display !== "object" ||
    !hasExactKeys(display as Record<string, unknown>, new Set(["label", "destinationOrigin"]))
  ) {
    return null;
  }
  const displayRecord = display as Record<string, unknown>;
  const kind = request.kind;
  const operation = request.operation;
  const requestedAtMs = request.requestedAtMs;
  const expiresAtMs = request.expiresAtMs;
  if (
    request.version !== 1 ||
    typeof request.approvalId !== "string" ||
    !UUID_PATTERN.test(request.approvalId) ||
    typeof kind !== "string" ||
    !APPROVAL_KINDS.has(kind as RuntimeSharedBrowserApprovalKind) ||
    typeof request.ownerId !== "string" ||
    !UUID_PATTERN.test(request.ownerId) ||
    typeof request.runId !== "string" ||
    !UUID_PATTERN.test(request.runId) ||
    typeof request.initiatorUserId !== "string" ||
    !UUID_PATTERN.test(request.initiatorUserId) ||
    typeof request.browserPageId !== "string" ||
    !request.browserPageId ||
    typeof operation !== "string" ||
    !APPROVAL_OPERATIONS.has(operation as RuntimeSharedBrowserApprovalOperation) ||
    !isNullableString(request.sourceOrigin) ||
    !isNullableString(request.destinationOrigin) ||
    typeof request.destinationFingerprint !== "string" ||
    !SHA256_PATTERN.test(request.destinationFingerprint) ||
    !isNullableSha256(request.snapshotId) ||
    !isNullableSha256(request.targetFingerprint) ||
    !isNullableSha256(request.payloadFingerprint) ||
    !Number.isSafeInteger(requestedAtMs) ||
    !Number.isSafeInteger(expiresAtMs) ||
    (expiresAtMs as number) <= (requestedAtMs as number) ||
    typeof request.requestFingerprint !== "string" ||
    !SHA256_PATTERN.test(request.requestFingerprint) ||
    typeof displayRecord.label !== "string" ||
    !isNullableString(displayRecord.destinationOrigin)
  ) {
    return null;
  }
  if (
    (kind === "origin" && operation !== "approve-origin") ||
    (kind === "action" && operation === "approve-origin")
  ) {
    return null;
  }

  return {
    runtimeId,
    request: {
      version: 1,
      approvalId: request.approvalId,
      kind: kind as RuntimeSharedBrowserApprovalKind,
      ownerId: request.ownerId as string,
      runId: request.runId as string,
      initiatorUserId: request.initiatorUserId as string,
      browserPageId: request.browserPageId as string,
      operation: operation as RuntimeSharedBrowserApprovalOperation,
      sourceOrigin: request.sourceOrigin as string | null,
      destinationOrigin: request.destinationOrigin as string | null,
      destinationFingerprint: request.destinationFingerprint,
      snapshotId: request.snapshotId as string | null,
      targetFingerprint: request.targetFingerprint as string | null,
      payloadFingerprint: request.payloadFingerprint as string | null,
      requestedAtMs: requestedAtMs as number,
      expiresAtMs: expiresAtMs as number,
      requestFingerprint: request.requestFingerprint,
      display: {
        label: displayRecord.label,
        destinationOrigin: displayRecord.destinationOrigin as string | null,
      },
    },
  };
}

export async function fetchRuntimeSharedBrowserPendingApproval(params: {
  originEndpoint: string;
  originAccessToken: string;
  runtimeId: string;
  browserPageId: string;
  signal?: AbortSignal;
}): Promise<RuntimeSharedBrowserPendingApproval | null> {
  const originEndpoint = params.originEndpoint.trim();
  const originAccessToken = params.originAccessToken.trim();
  const runtimeId = params.runtimeId.trim();
  const browserPageId = params.browserPageId.trim();
  if (!originEndpoint || !originAccessToken || !UUID_PATTERN.test(runtimeId) || !browserPageId) {
    return null;
  }

  const endpoint = new URL(buildOriginEndpointUrl(originEndpoint, "/browser/approval/pending"));
  endpoint.searchParams.set("runtimeId", runtimeId);
  endpoint.searchParams.set("browserPageId", browserPageId);
  const response = await fetch(endpoint, {
    cache: "no-store",
    headers: {
      authorization: `Bearer ${originAccessToken}`,
      accept: "application/json",
    },
    signal: params.signal,
  });
  // A missing/gone session has no approval to display. Gateway failures are
  // transient, though: throw them so the polling hook preserves an already
  // visible request and shows its reconnecting state instead of clearing it.
  if (response.status === 404 || response.status === 410) {
    return null;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`browser approval request failed (${response.status}): ${text}`);
  }

  const pending = mapRuntimeSharedBrowserPendingApprovalPayload((await response.json()) as unknown);
  if (
    !pending ||
    pending.runtimeId !== runtimeId ||
    pending.request.browserPageId !== browserPageId
  ) {
    return null;
  }
  return pending;
}

export async function decideRuntimeSharedBrowserApproval(params: {
  originEndpoint: string;
  originAccessToken: string;
  pending: RuntimeSharedBrowserPendingApproval;
  decision: RuntimeSharedBrowserApprovalDecision;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { request, runtimeId } = params.pending;
  const originEndpoint = params.originEndpoint.trim();
  const originAccessToken = params.originAccessToken.trim();
  if (
    !originEndpoint ||
    !originAccessToken ||
    !APPROVAL_DECISIONS.has(params.decision) ||
    (params.decision === "allow_origin" && request.kind !== "origin") ||
    (params.decision === "allow_once" && request.kind !== "action")
  ) {
    return false;
  }
  const response = await fetch(buildOriginEndpointUrl(originEndpoint, "/browser/approval/decision"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${originAccessToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: 1,
      runtimeId,
      ownerId: request.ownerId,
      runId: request.runId,
      browserPageId: request.browserPageId,
      approvalId: request.approvalId,
      requestFingerprint: request.requestFingerprint,
      decision: params.decision,
    }),
    signal: params.signal,
  });
  if (response.status === 404 || response.status === 409 || response.status === 410) {
    return false;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`browser approval decision failed (${response.status}): ${text}`);
  }
  const payload = (await response.json()) as unknown;
  return (
    Boolean(payload) &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).accepted === true &&
    (payload as Record<string, unknown>).approvalId === request.approvalId
  );
}
