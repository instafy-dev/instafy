const GENERIC_STREAM_ERROR = "event stream error";

const CONNECTION_ERROR_PATTERNS = [
  "failed to fetch",
  "fetch failed",
  "load failed",
  "networkerror",
  "network request failed",
  "service unavailable",
  "gateway",
  "timed out",
  "timeout",
  "connection refused",
  "connection reset",
  "econnrefused",
  "econnreset",
];

function normalizeMessage(message: string | null | undefined): string {
  return typeof message === "string" ? message.trim() : "";
}

export function isGenericRuntimeStreamError(
  message: string | null | undefined,
): boolean {
  return normalizeMessage(message).toLowerCase() === GENERIC_STREAM_ERROR;
}

export function isLikelyControllerConnectionError(
  message: string | null | undefined,
): boolean {
  const normalized = normalizeMessage(message).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (isGenericRuntimeStreamError(normalized)) {
    return true;
  }
  if (CONNECTION_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return true;
  }
  return /\b(?:500|502|503|504)\b/.test(normalized);
}

export function formatRuntimeStreamDisconnectedMessage(
  message: string | null | undefined,
): string {
  const normalized = normalizeMessage(message);
  if (!normalized || isLikelyControllerConnectionError(normalized)) {
    return "Lost live runtime updates. Retrying…";
  }
  return `Lost live runtime updates. ${normalized}`;
}

export function formatControllerUnavailableDetail(
  message: string | null | undefined,
): string {
  const normalized = normalizeMessage(message);
  if (!normalized || isLikelyControllerConnectionError(normalized)) {
    return "Retry after the local stack is ready. Your AI credentials may still be fine.";
  }
  return normalized;
}
