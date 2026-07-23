export type AiConnectWizardStep =
  | "provider"
  | "openai-auth"
  | "openai-login"
  | "openai-api-key"
  | "openai-upload"
  | "gemini-auth"
  | "deepseek-api-key"
  | "zai-api-key"
  | "gemini-api-key";

export type AiConnectWizardProvider = "openai" | "deepseek" | "zai" | "gemini";

export type AiConnectWizardMode = "default" | "personal_only";

export type AiConnectWizardDeviceAuthStatus = "pending" | "completed" | "failed" | "cancelled";

export type AiConnectWizardDeviceAuthSession = {
  sessionId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  status: AiConnectWizardDeviceAuthStatus;
  error?: string | null;
};

export type AiConnectWizardStoredStateV1 = {
  version: 1;
  open: boolean;
  mode: AiConnectWizardMode;
  provider: AiConnectWizardProvider | null;
  step: AiConnectWizardStep;
  deviceAuthSession: AiConnectWizardDeviceAuthSession | null;
  deviceAuthError: string | null;
  updatedAt: number;
};

const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStep(value: unknown): AiConnectWizardStep | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  switch (normalized) {
    case "provider":
    case "openai-auth":
    case "openai-login":
    case "openai-api-key":
    case "openai-upload":
    case "gemini-auth":
    case "deepseek-api-key":
    case "zai-api-key":
    case "gemini-api-key":
      return normalized;
    case "gemini-login":
      return "gemini-api-key";
    default:
      return null;
  }
}

function normalizeProvider(value: unknown): AiConnectWizardProvider | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "openai" ||
    normalized === "deepseek" ||
    normalized === "zai" ||
    normalized === "gemini"
  ) {
    return normalized;
  }
  return null;
}

function normalizeMode(value: unknown): AiConnectWizardMode {
  return value === "personal_only" ? "personal_only" : "default";
}

function normalizeDeviceAuthStatus(value: unknown): AiConnectWizardDeviceAuthStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "pending" ||
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "cancelled"
  ) {
    return normalized;
  }
  return null;
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDeviceAuthSession(value: unknown): AiConnectWizardDeviceAuthSession | null {
  if (!isObject(value)) return null;
  const sessionId = normalizeNullableString(value.sessionId);
  const verificationUrl = normalizeNullableString(value.verificationUrl);
  const userCode = normalizeNullableString(value.userCode);
  const expiresAt = normalizeNullableString(value.expiresAt);
  const pollIntervalSecondsRaw = value.pollIntervalSeconds;
  const pollIntervalSeconds =
    typeof pollIntervalSecondsRaw === "number" && Number.isFinite(pollIntervalSecondsRaw)
      ? Math.max(1, Math.floor(pollIntervalSecondsRaw))
      : null;
  const status = normalizeDeviceAuthStatus(value.status);
  const error = normalizeNullableString(value.error);

  if (!sessionId || !verificationUrl || !userCode || !expiresAt || pollIntervalSeconds === null || !status) {
    return null;
  }

  return {
    sessionId,
    verificationUrl,
    userCode,
    expiresAt,
    pollIntervalSeconds,
    status,
    error,
  };
}

export function defaultAiConnectWizardState(): AiConnectWizardStoredStateV1 {
  return {
    version: 1,
    open: false,
    mode: "default",
    provider: null,
    step: "provider",
    deviceAuthSession: null,
    deviceAuthError: null,
    updatedAt: Date.now(),
  };
}

export function readAiConnectWizardState(storageKey: string): AiConnectWizardStoredStateV1 | null {
  if (!storageKey || typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) return null;
    if (parsed.version !== 1) return null;

    const step = normalizeStep(parsed.step);
    const provider = parsed.provider === null ? null : normalizeProvider(parsed.provider);
    const open = typeof parsed.open === "boolean" ? parsed.open : false;
    const mode = normalizeMode(parsed.mode);
    const deviceAuthSession =
      parsed.deviceAuthSession === null || parsed.deviceAuthSession === undefined
        ? null
        : parseDeviceAuthSession(parsed.deviceAuthSession);
    const deviceAuthError = normalizeNullableString(parsed.deviceAuthError);
    const updatedAtRaw = parsed.updatedAt;
    const updatedAt =
      typeof updatedAtRaw === "number" && Number.isFinite(updatedAtRaw) ? Math.floor(updatedAtRaw) : null;

    if (!step || updatedAt === null) {
      return null;
    }
    if (Date.now() - updatedAt > MAX_AGE_MS) {
      return null;
    }

    return {
      version: 1,
      open,
      mode,
      provider,
      step,
      deviceAuthSession,
      deviceAuthError,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function writeAiConnectWizardState(
  storageKey: string,
  value: AiConnectWizardStoredStateV1 | null
): void {
  if (!storageKey || typeof window === "undefined") {
    return;
  }
  try {
    if (!value) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
}
