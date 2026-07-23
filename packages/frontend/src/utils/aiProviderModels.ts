import { DEFAULT_OPENAI_MODEL_OPTION } from "../ai/modelDefaults";

export type AiProviderId = "openai" | "deepseek" | "zai" | "gemini";

export type AiModelOption = {
  id: string;
  label: string;
};

export type AiProviderOption = {
  id: AiProviderId;
  label: string;
};

export const AI_PROVIDER_OPTIONS: AiProviderOption[] = [
  { id: "openai", label: "OpenAI" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "zai", label: "z.ai" },
  { id: "gemini", label: "Gemini" },
];

// Anything below gpt-5.5 is no longer served upstream; saved selections
// migrate to the closest current model instead of failing at run time.
const OPENAI_MODEL_MIGRATIONS: Record<string, string> = {
  "gpt-5.4": "gpt-5.5",
  "gpt-5.4-mini": "gpt-5.5-mini",
  "gpt-5-codex": "gpt-5.5",
  "gpt-5.3-codex": "gpt-5.5",
  "gpt-5.2-codex": "gpt-5.5",
  "gpt-5.2": "gpt-5.5",
  "gpt-5.1-codex-max": "gpt-5.5",
  "gpt-5.1-codex": "gpt-5.5",
  "gpt-5.1-codex-mini": "gpt-5.5-mini",
  "gpt-4.5": "gpt-5.5",
  "o3-mini": "gpt-5.5-mini",
};

const OPENAI_MODEL_OPTIONS: AiModelOption[] = [
  DEFAULT_OPENAI_MODEL_OPTION,
  { id: "gpt-5.5-mini", label: "gpt-5.5-mini" },
];

const DEEPSEEK_MODEL_OPTIONS: AiModelOption[] = [
  { id: "deepseek-chat", label: "deepseek-chat" },
  { id: "deepseek-reasoner", label: "deepseek-reasoner" },
];

const ZAI_MODEL_OPTIONS: AiModelOption[] = [
  { id: "glm-5", label: "glm-5" },
];

const GEMINI_MODEL_OPTIONS: AiModelOption[] = [
  { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
  { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
];

export function modelOptionsForProvider(provider: AiProviderId): AiModelOption[] {
  switch (provider) {
    case "deepseek":
      return DEEPSEEK_MODEL_OPTIONS;
    case "zai":
      return ZAI_MODEL_OPTIONS;
    case "gemini":
      return GEMINI_MODEL_OPTIONS;
    case "openai":
    default:
      return OPENAI_MODEL_OPTIONS;
  }
}

export function normalizeAiProviderId(value: unknown): AiProviderId {
  if (typeof value !== "string") {
    return "openai";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "z.ai") {
    return "zai";
  }
  if (
    normalized === "google" ||
    normalized === "google-ai" ||
    normalized === "google_gemini" ||
    normalized === "google-gemini"
  ) {
    return "gemini";
  }
  if (
    normalized === "deepseek" ||
    normalized === "zai" ||
    normalized === "openai" ||
    normalized === "gemini"
  ) {
    return normalized;
  }
  return "openai";
}

export function normalizeAiModelId(
  provider: AiProviderId,
  value: unknown,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (provider === "openai") {
    return OPENAI_MODEL_MIGRATIONS[normalized] ?? normalized;
  }
  return normalized;
}
