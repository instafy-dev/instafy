const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";

const PROJECT_RUNTIME_IDS_PATTERN = new RegExp(
  `project\\s+(${UUID_PATTERN})\\s*,\\s*runtime\\s+(${UUID_PATTERN})`,
  "i",
);

const RUNTIME_LABEL_PATTERN = /Active runtime "([^"]+)"/i;
const PROJECT_LABEL_PATTERN = /attached to project "([^"]+)"/i;
const ACTIVE_COUNT_PATTERN = /\((\d+)\s+active\s*;\s*max\s+(\d+)\)/i;

export interface HostedRuntimeLimitErrorDetails {
  limitReached: boolean;
  activeCount: number | null;
  maxActiveCount: number | null;
  blockerRuntimeId: string | null;
  blockerProjectId: string | null;
  blockerRuntimeLabel: string | null;
  blockerProjectLabel: string | null;
}

interface RuntimeLimitErrorLike {
  code?: unknown;
  details?: unknown;
}

function normalizeLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function emptyHostedRuntimeLimitErrorDetails(
  limitReached = false,
): HostedRuntimeLimitErrorDetails {
  return {
    limitReached,
    activeCount: null,
    maxActiveCount: null,
    blockerRuntimeId: null,
    blockerProjectId: null,
    blockerRuntimeLabel: null,
    blockerProjectLabel: null,
  };
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

export function parseHostedRuntimeLimitDetails(
  details: unknown,
): HostedRuntimeLimitErrorDetails | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const record = details as Record<string, unknown>;
  const activeCount = normalizeNumber(record.activeCount);
  const maxActiveCount = normalizeNumber(record.maxActiveCount);
  const hasLimitCounts =
    typeof activeCount === "number" || typeof maxActiveCount === "number";
  const blockerRuntimeId = normalizeLabel(
    typeof record.blockerRuntimeId === "string" ? record.blockerRuntimeId : null,
  );
  const blockerProjectId = normalizeLabel(
    typeof record.blockerProjectId === "string" ? record.blockerProjectId : null,
  );
  const blockerRuntimeLabel = normalizeLabel(
    typeof record.blockerRuntimeLabel === "string"
      ? record.blockerRuntimeLabel
      : null,
  );
  const blockerProjectLabel = normalizeLabel(
    typeof record.blockerProjectLabel === "string"
      ? record.blockerProjectLabel
      : null,
  );
  if (
    !hasLimitCounts &&
    !blockerRuntimeId &&
    !blockerProjectId &&
    !blockerRuntimeLabel &&
    !blockerProjectLabel
  ) {
    return null;
  }
  return {
    limitReached: true,
    activeCount,
    maxActiveCount,
    blockerRuntimeId,
    blockerProjectId,
    blockerRuntimeLabel,
    blockerProjectLabel,
  };
}

export function hostedRuntimeLimitDetailsFromError(
  error: unknown,
): HostedRuntimeLimitErrorDetails | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = error as RuntimeLimitErrorLike;
  if (candidate.code !== "runtime_limit_reached") {
    return null;
  }
  return parseHostedRuntimeLimitDetails(candidate.details);
}

export function parseHostedRuntimeLimitError(
  runtimeEnsureError: string | null | undefined,
  structuredDetails?: HostedRuntimeLimitErrorDetails | null,
): HostedRuntimeLimitErrorDetails {
  if (structuredDetails?.limitReached) {
    return structuredDetails;
  }
  const message =
    typeof runtimeEnsureError === "string" ? runtimeEnsureError.trim() : "";
  if (!message) {
    return emptyHostedRuntimeLimitErrorDetails();
  }

  const lower = message.toLowerCase();
  const limitReached = lower.includes("runtime limit reached");
  if (!limitReached) {
    return emptyHostedRuntimeLimitErrorDetails();
  }

  const countMatch = message.match(ACTIVE_COUNT_PATTERN);
  const activeCount = countMatch?.[1] ? Number.parseInt(countMatch[1], 10) : null;
  const maxActiveCount = countMatch?.[2] ? Number.parseInt(countMatch[2], 10) : null;
  const idsMatch = message.match(PROJECT_RUNTIME_IDS_PATTERN);
  const blockerProjectId = normalizeLabel(idsMatch?.[1] ?? null);
  const blockerRuntimeId = normalizeLabel(idsMatch?.[2] ?? null);
  const runtimeLabel = normalizeLabel(message.match(RUNTIME_LABEL_PATTERN)?.[1] ?? null);
  const projectLabel = normalizeLabel(message.match(PROJECT_LABEL_PATTERN)?.[1] ?? null);

  return {
    limitReached: true,
    activeCount,
    maxActiveCount,
    blockerRuntimeId,
    blockerProjectId,
    blockerRuntimeLabel: runtimeLabel,
    blockerProjectLabel: projectLabel,
  };
}
