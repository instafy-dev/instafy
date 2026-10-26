import {
  DEFAULT_OPENAI_MODEL_OPTION,
  DEFAULT_PROJECT_AI_MODEL,
  OWN_AI_SMALL_MODEL_ID,
} from "../ai/modelDefaults";

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

// Own AI runs at least GPT-6: the controller raises any bare OpenAI id below
// it when a job runs (own_ai_model_floor in model_defaults.rs), to the small
// tier for Luna, mini and nano ids and to the own-AI default otherwise. Studio
// shows the model that runs, so it applies the same rule; both are checked
// against runtime-contracts' own_ai_model_fixtures.json.
export function ownAiModelFloor(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  const match = /^(?:gpt-(\d+)|o(?=\d))(.*)$/u.exec(normalized);
  if (!match) {
    return null;
  }
  const [, major, afterVersion] = match;
  if (major !== undefined && Number(major) >= 6) {
    return null;
  }
  const small = afterVersion
    .split(/[^a-z0-9]/u)
    .some((part) => part === "luna" || part === "mini" || part === "nano");
  return small ? OWN_AI_SMALL_MODEL_ID : DEFAULT_PROJECT_AI_MODEL;
}

const OPENAI_MODEL_OPTIONS: AiModelOption[] = [
  DEFAULT_OPENAI_MODEL_OPTION,
  { id: OWN_AI_SMALL_MODEL_ID, label: OWN_AI_SMALL_MODEL_ID },
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
    return ownAiModelFloor(normalized) ?? normalized;
  }
  return normalized;
}
