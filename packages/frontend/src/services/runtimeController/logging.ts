const CONTROLLER_CONNECTION_ERROR_PATTERNS = [
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

export function getControllerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortLikeControllerError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function isLikelyControllerConnectionNoise(
  message: string | null | undefined,
): boolean {
  const normalized = normalizeMessage(message).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === "event stream error") {
    return true;
  }
  if (CONTROLLER_CONNECTION_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return true;
  }
  return /\b(?:500|502|503|504)\b/.test(normalized);
}

export function isAutomationBrowser(): boolean {
  return typeof navigator !== "undefined" && navigator.webdriver === true;
}

export function logControllerRequestError(
  label: string,
  error: unknown,
  options?: {
    suppressLikelyConnectionNoise?: boolean;
  },
): void {
  if (isAbortLikeControllerError(error)) {
    return;
  }
  const message = getControllerErrorMessage(error);
  if (
    options?.suppressLikelyConnectionNoise &&
    isLikelyControllerConnectionNoise(message) &&
    isAutomationBrowser()
  ) {
    return;
  }
  console.warn(label, message);
}
