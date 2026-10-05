/**
 * Structured errors from workspace origins (the hosted gateway, Desktop
 * origins and hosted runtimes, all reached through the controller's origin
 * proxy).
 *
 * Origins answer failures as JSON `{error, code?, paths?, ...}`; a publish
 * that kept work aside also carries its publish report in the same object.
 * The controller's own errors are `{message, code?}`, and its proxy answers
 * an unknown route with 404 "origin path not found". Every shape is optional
 * here: older origins send plain text or no body at all.
 */

export type KnownOriginErrorCode =
  // 409
  | "head_moved"
  | "path_type_conflict"
  | "main_busy"
  | "revert_conflict"
  | "restore_conflict"
  | "rev_not_on_main"
  | "idempotency_conflict"
  | "recovery_ref_moved"
  | "salvage_ref_kept"
  | "dirty_paths"
  | "not_saved"
  // 422
  | "excluded_path"
  | "ignored_path"
  | "policy_rejected"
  | "dismissal_not_applied"
  // 400
  | "unsupported_entry"
  | "delete_requires_base_rev"
  | "invalid_ref"
  | "invalid_rev"
  | "not_supported"
  | "idempotency_requires_import"
  // 404 / 413
  | "rev_not_found"
  | "not_found"
  | "too_large"
  // 502 / 503
  | "canonical_unreachable"
  | "push_rejected"
  | OriginRetryLaterCode
  | "workspace_stopping"
  // Client-side codes (never sent by a server).
  | "lease_conflict"
  | "lease_failed"
  | "token_unavailable"
  | "network_error"
  | "timeout"
  | "invalid_request";

export type OriginErrorCode = KnownOriginErrorCode | (string & Record<never, never>);

/**
 * The stateless gateway's 503 answers, each with `Retry-After`. None of them
 * wrote anything:
 * - `fetch_pending`: the space's saved versions are still being fetched;
 * - `writes_busy`: every write slot stayed taken while the request waited;
 * - `mirror_reset`: the gateway's copy of the space was damaged and is
 *   being made again;
 * - `disk_full`: the gateway's disk is full.
 */
export type OriginRetryLaterCode = "fetch_pending" | "writes_busy" | "mirror_reset" | "disk_full";

const RETRY_LATER_CODES: ReadonlySet<string> = new Set<OriginRetryLaterCode>([
  "fetch_pending",
  "writes_busy",
  "mirror_reset",
  "disk_full",
]);

/**
 * The ones that clear by themselves within seconds (a fetch finishing, a
 * write slot freeing, a copy made again), so a client may ask once more on
 * its own. `disk_full` is not one: a full disk does not clear in seconds,
 * and asking again only adds work for a server that is out of room.
 */
const AUTO_RETRY_CODES: ReadonlySet<string> = new Set<OriginRetryLaterCode>([
  "fetch_pending",
  "writes_busy",
  "mirror_reset",
]);

export function isOriginRetryLaterCode(code: string | null | undefined): code is OriginRetryLaterCode {
  return typeof code === "string" && RETRY_LATER_CODES.has(code);
}

export function isOriginAutoRetryCode(code: string | null | undefined): boolean {
  return typeof code === "string" && AUTO_RETRY_CODES.has(code);
}

/** How long a client waits before the one retry it makes on its own. */
export interface OriginAutoRetryBudget {
  /** The wait when the answer carries no `Retry-After`. */
  defaultDelayMs: number;
  /** The longest wait, whatever `Retry-After` asks for. */
  maxDelayMs: number;
}

/**
 * The wait before asking again on its own, after an answer that clears by
 * itself: the origin's `Retry-After`, or the budget's default, never more
 * than the budget's cap. Null for every other answer (`disk_full`
 * included), which only the user retries.
 */
export function originAutoRetryDelayMs(
  error: Pick<OriginError, "code" | "retryAfterMs"> | null | undefined,
  budget: OriginAutoRetryBudget,
): number | null {
  if (!isOriginAutoRetryCode(error?.code)) {
    return null;
  }
  const retryAfter = error?.retryAfterMs;
  const delay =
    typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0
      ? retryAfter
      : budget.defaultDelayMs;
  return Math.max(0, Math.min(delay, budget.maxDelayMs));
}

export type OriginPublishStatus = "published" | "partial" | "unchanged" | "unpublished";

export interface OriginRejectedPath {
  path: string;
  /** excluded, secret, attachment, ignored, too_large, policy, unsupported (or a newer reason). */
  reason: string | null;
  /** The saved version kept its own copy of this path. */
  keptSavedVersion: boolean;
}

export interface OriginRecoveryRefReport {
  reference: string;
  rev: string | null;
  kind: string | null;
  name: string | null;
  pushed: boolean;
  created: boolean;
  paths: string[];
}

/** The report a Desktop or runtime origin returns for a publish (`/git/sync`, revert). */
export interface OriginPublishReport {
  rev: string | null;
  baseRev: string | null;
  localRev: string | null;
  gitSyncStatus: OriginPublishStatus | null;
  recoveryRef: string | null;
  recoveryRefs: OriginRecoveryRefReport[];
  conflictedPaths: string[];
  rejectedPaths: OriginRejectedPath[];
  checkoutMoved: boolean;
  unpushedRefs: number;
  failure: string | null;
  retryable: boolean;
}

export interface OriginError {
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  code?: OriginErrorCode;
  message: string;
  paths?: string[];
  reason?: string;
  head?: string;
  retryAfterMs?: number;
  retryable?: boolean;
  report?: OriginPublishReport;
  /** The route does not exist on this controller or origin (an older server). */
  routeUnavailable: boolean;
}

export const ORIGIN_PROXY_ROUTE_NOT_FOUND = "origin path not found";

const LEASE_CONFLICT_PATTERN = /currently leased by/i;
const LEASE_CONFLICT_MESSAGE = "Another save is in progress. Try again in a moment.";

const PUBLISH_STATUSES: ReadonlySet<string> = new Set([
  "published",
  "partial",
  "unchanged",
  "unpublished",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

/** A list of path strings; objects with a `path` field are accepted too. */
export function readOriginPathList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      paths.push(item);
      continue;
    }
    const record = asRecord(item);
    const path = record ? readString(record, "path") : null;
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}

function parseRejectedPaths(value: unknown): OriginRejectedPath[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rejected: OriginRejectedPath[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      rejected.push({ path: item, reason: null, keptSavedVersion: false });
      continue;
    }
    const record = asRecord(item);
    const path = record ? readString(record, "path") : null;
    if (!record || !path) {
      continue;
    }
    rejected.push({
      path,
      reason: readString(record, "reason"),
      keptSavedVersion: readBoolean(record, "keptSavedVersion", "kept_saved_version") === true,
    });
  }
  return rejected;
}

function parseRecoveryRefs(value: unknown): OriginRecoveryRefReport[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: OriginRecoveryRefReport[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const reference = record ? readString(record, "reference", "ref") : null;
    if (!record || !reference) {
      continue;
    }
    refs.push({
      reference,
      rev: readString(record, "rev"),
      kind: readString(record, "kind"),
      name: readString(record, "name"),
      pushed: readBoolean(record, "pushed") === true,
      created: readBoolean(record, "created") === true,
      paths: readOriginPathList(record.paths),
    });
  }
  return refs;
}

const REPORT_MARKER_KEYS = [
  "gitSyncStatus",
  "git_sync_status",
  "conflictedPaths",
  "conflicted_paths",
  "rejectedPaths",
  "rejected_paths",
  "recoveryRef",
  "recovery_ref",
  "recoveryRefs",
  "recovery_refs",
];

/**
 * The publish report of a Desktop or runtime origin. Returns null for
 * payloads that carry none of its fields (the old gateway answers `{rev}`,
 * the stateless gateway `{rev, baseRev, committed}`).
 */
export function parsePublishReport(payload: unknown): OriginPublishReport | null {
  const record = asRecord(payload);
  if (!record || !REPORT_MARKER_KEYS.some((key) => key in record)) {
    return null;
  }
  const statusRaw = readString(record, "gitSyncStatus", "git_sync_status");
  const unpushedRaw = record.unpushedRefs ?? record.unpushed_refs;
  const unpushedRefs =
    typeof unpushedRaw === "number" && Number.isFinite(unpushedRaw)
      ? Math.max(0, Math.floor(unpushedRaw))
      : Array.isArray(unpushedRaw)
        ? unpushedRaw.length
        : 0;
  return {
    rev: readString(record, "rev"),
    baseRev: readString(record, "baseRev", "base_rev"),
    localRev: readString(record, "localRev", "local_rev"),
    gitSyncStatus:
      statusRaw && PUBLISH_STATUSES.has(statusRaw) ? (statusRaw as OriginPublishStatus) : null,
    recoveryRef: readString(record, "recoveryRef", "recovery_ref"),
    recoveryRefs: parseRecoveryRefs(record.recoveryRefs ?? record.recovery_refs),
    conflictedPaths: readOriginPathList(record.conflictedPaths ?? record.conflicted_paths),
    rejectedPaths: parseRejectedPaths(record.rejectedPaths ?? record.rejected_paths),
    checkoutMoved: readBoolean(record, "checkoutMoved", "checkout_moved") === true,
    unpushedRefs,
    failure: readString(record, "failure"),
    retryable: readBoolean(record, "retryable") === true,
  };
}

/** `Retry-After` as milliseconds (delta seconds or an HTTP date). */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.max(0, at - now);
}

/** The error for a controller lease refusal; the holder's id is never kept. */
export function leaseConflictError(): OriginError {
  return {
    status: 409,
    code: "lease_conflict",
    message: LEASE_CONFLICT_MESSAGE,
    routeUnavailable: false,
  };
}

export function isLeaseConflictMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && LEASE_CONFLICT_PATTERN.test(message);
}

const LEASE_HOLDER_PATTERN = /(currently leased by )(.+?)( until |$)/i;

/**
 * Drop the holder from the controller's lease refusal ("project currently
 * leased by <user id> until <time>"), so another member's id never reaches
 * an error message, a toast or a log.
 */
export function redactLeaseHolder(message: string): string {
  return message.replace(LEASE_HOLDER_PATTERN, "$1another session$3");
}

/**
 * Parse an error answer from its status, body text and headers. Never throws.
 */
export function parseOriginErrorText(
  status: number,
  text: string,
  headers?: Pick<Headers, "get"> | null,
): OriginError {
  const body = text ?? "";
  let record: Record<string, unknown> | null = null;
  if (body.trim().length > 0) {
    try {
      record = asRecord(JSON.parse(body));
    } catch (_error) {
      record = null;
    }
  }

  const bodyMessage = record ? readString(record, "error", "message") : null;
  const plainText = record ? null : body.trim() || null;
  const message = bodyMessage ?? plainText ?? `origin request failed (${status})`;
  let code: OriginErrorCode | undefined = record ? (readString(record, "code") ?? undefined) : undefined;

  if (!code && status === 409 && isLeaseConflictMessage(message)) {
    return leaseConflictError();
  }
  if (!code && status === 413) {
    code = "too_large";
  }

  const error: OriginError = {
    status,
    message,
    routeUnavailable:
      status === 404 &&
      !code &&
      (message.toLowerCase() === ORIGIN_PROXY_ROUTE_NOT_FOUND || body.trim().length === 0),
  };
  if (code) {
    error.code = code;
  }
  if (record) {
    const paths = readOriginPathList(record.paths);
    if (paths.length > 0) {
      error.paths = paths;
    }
    const reason = readString(record, "reason");
    if (reason) {
      error.reason = reason;
    }
    const head = readString(record, "head");
    if (head) {
      error.head = head;
    }
    const retryable = readBoolean(record, "retryable");
    if (retryable !== null) {
      error.retryable = retryable;
    }
    const report = parsePublishReport(record);
    if (report) {
      error.report = report;
      if (!error.paths && report.conflictedPaths.length > 0) {
        error.paths = report.conflictedPaths;
      }
    }
  }
  const retryAfterMs = parseRetryAfterMs(headers?.get("retry-after"));
  if (retryAfterMs !== undefined) {
    error.retryAfterMs = retryAfterMs;
  }
  return error;
}

/** Read and parse an error response. Consumes the body. */
export async function parseOriginError(response: Response): Promise<OriginError> {
  const text = await response.text().catch(() => "");
  return parseOriginErrorText(response.status, text, response.headers);
}

/** An error for a request that never got an answer (network failure, timeout). */
export function originErrorFromException(error: unknown): OriginError {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      status: 0,
      code: "timeout",
      message: "the request timed out",
      routeUnavailable: false,
    };
  }
  return {
    status: 0,
    code: "network_error",
    message: error instanceof Error ? error.message : String(error),
    routeUnavailable: false,
  };
}
