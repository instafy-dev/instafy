// The bring-your-own OpenAI default ("your own AI": an API key, a ChatGPT
// login or Codex on this computer), equal to runtime-contracts'
// OWN_AI_DEFAULT_MODEL_ID; aiProviderModels.test.ts checks this copy against
// own_ai_model_fixtures.json. The credits-funded managed tier's model comes
// from the controller (credential requirements' managedAi.modelId and
// modelLabel); Studio keeps no copy of it.
export const DEFAULT_PROJECT_AI_MODEL = "gpt-6.1-sol";
// A cheaper model a person may pick for their own AI on purpose, equal to
// runtime-contracts' OWN_AI_SMALL_MODEL_ID (checked against the same fixture).
// Instafy never picks it on its own: defaults and older picks run
// DEFAULT_PROJECT_AI_MODEL, and the floor keeps only this exact id. Codex's
// catalog does not list it for ChatGPT's Pro (Max) plan, and Studio cannot
// see a login's plan, so the picker shows it by id only and claims nothing
// about availability.
export const OWN_AI_SMALL_MODEL_ID = "gpt-6-luna";
export const DEFAULT_OPENAI_MODEL_OPTION = {
  id: DEFAULT_PROJECT_AI_MODEL,
  label: DEFAULT_PROJECT_AI_MODEL,
} as const;
