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

// `[N, M]` for a lowercase `gpt-N[.M]…` id (gpt-6.1-sol is 6.1, gpt-5.10 is
// 5.10), null for an id without a version.
function openAiVersion(model: string): [number, number] | null {
  const match = /^gpt-(\d+)(?:\.(\d+))?/u.exec(model);
  return match ? [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])] : null;
}

// The tiers the Codex catalog names after an OpenAI id's version, cheapest
// first, as in runtime-contracts' OPENAI_TIERS.
const OPENAI_TIERS = ["luna", "terra", "sol", "astra"];

// The rank in OPENAI_TIERS of the word after a lowercase id's version
// (gpt-6-astra and gpt-6-astra-mini are Astra), -1 for a word that is not a
// tier.
function openAiTier(model: string): number {
  const match = /^gpt-\d+(?:\.\d+)?-([^-]+)/u.exec(model);
  return match ? OPENAI_TIERS.indexOf(match[1]!) : -1;
}

// Own AI runs at least its default: the controller raises a bare OpenAI id of
// an older version than the default when a job runs (runtime-contracts'
// own_ai_model_floor), Luna, mini and nano ids included, and o-series ids
// always. The exceptions are OWN_AI_SMALL_MODEL_ID, the cheaper model a
// person picks on purpose, and an older id of a higher tier than the
// default's (gpt-6-astra under a Sol default), which raising would lower.
// Studio shows the model that runs, so it applies the same rule; both are
// checked against runtime-contracts' own_ai_model_fixtures.json.
// `defaultModel` is a parameter only so the tests can check a later bump.
export function ownAiModelFloor(
  model: string,
  defaultModel: string = DEFAULT_PROJECT_AI_MODEL,
): string | null {
  const defaultId = defaultModel.trim().toLowerCase();
  const floor = openAiVersion(defaultId);
  if (!floor) {
    return null;
  }
  const normalized = model.trim().toLowerCase();
  if (normalized === OWN_AI_SMALL_MODEL_ID) {
    return null;
  }
  const version = openAiVersion(normalized);
  const defaultTier = openAiTier(defaultId);
  const higherTier = defaultTier >= 0 && openAiTier(normalized) > defaultTier;
  const older = version
    ? (version[0] < floor[0] || (version[0] === floor[0] && version[1] < floor[1])) &&
      !higherTier
    : /^o\d/u.test(normalized);
  return older ? defaultModel : null;
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
