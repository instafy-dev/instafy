/**
 * Whether the chat's AI connect prompt is open, kept per conversation so a
 * reload shows it again. The prompt itself only hands off to the Add AI
 * connection modal.
 */
import { isRecord } from "../../../utils/isRecord";

export type AiConnectWizardMode = "default" | "personal_only";

export type AiConnectWizardStoredStateV1 = {
  version: 1;
  open: boolean;
  mode: AiConnectWizardMode;
  updatedAt: number;
};

const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function normalizeMode(value: unknown): AiConnectWizardMode {
  return value === "personal_only" ? "personal_only" : "default";
}

export function defaultAiConnectWizardState(): AiConnectWizardStoredStateV1 {
  return {
    version: 1,
    open: false,
    mode: "default",
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
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1) return null;

    const open = typeof parsed.open === "boolean" ? parsed.open : false;
    const mode = normalizeMode(parsed.mode);
    const updatedAtRaw = parsed.updatedAt;
    const updatedAt =
      typeof updatedAtRaw === "number" && Number.isFinite(updatedAtRaw) ? Math.floor(updatedAtRaw) : null;

    if (updatedAt === null) {
      return null;
    }
    if (Date.now() - updatedAt > MAX_AGE_MS) {
      return null;
    }

    return {
      version: 1,
      open,
      mode,
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
