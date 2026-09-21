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

export const HOSTED_RUNTIME_BLOCKER_SPACE_ERROR_CODE =
  "hosted_runtime_blocker_space_unavailable";

/**
 * Copy for the follow-up after "Stop blocker and retry" could not stop the
 * blocking machine from this space (the controller refused the stop) and the
 * limit still holds. Names the blocking space so the user knows where to go.
 */
export function describeHostedRuntimeBlockerSpace(
  details: Pick<HostedRuntimeLimitErrorDetails, "blockerProjectId" | "blockerProjectLabel">,
): string {
  const space = details.blockerProjectLabel ?? details.blockerProjectId;
  if (!space) {
    return "The blocking machine can't be stopped from here. Open its space and stop it there.";
  }
  return `The blocking machine in "${space}" can't be stopped from here. Open that space and stop it there.`;
}

/** Thrown by the takeover flow when the blocker must be stopped from its own space. */
export class HostedRuntimeBlockerSpaceError extends Error {
  readonly code = HOSTED_RUNTIME_BLOCKER_SPACE_ERROR_CODE;
  readonly blockerProjectId: string | null;
  readonly blockerProjectLabel: string | null;

  constructor(
    details: Pick<HostedRuntimeLimitErrorDetails, "blockerProjectId" | "blockerProjectLabel">,
  ) {
    super(describeHostedRuntimeBlockerSpace(details));
    this.name = "HostedRuntimeBlockerSpaceError";
    this.blockerProjectId = details.blockerProjectId;
    this.blockerProjectLabel = details.blockerProjectLabel;
  }
}

export function isHostedRuntimeBlockerSpaceError(
  error: unknown,
): error is HostedRuntimeBlockerSpaceError {
  return (
    error instanceof HostedRuntimeBlockerSpaceError ||
    (Boolean(error) &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === HOSTED_RUNTIME_BLOCKER_SPACE_ERROR_CODE)
  );
}
