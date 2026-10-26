// The bring-your-own OpenAI default ("your own AI": an API key, a ChatGPT
// login or Codex on this computer), equal to runtime-contracts'
// OWN_AI_DEFAULT_MODEL_ID; aiProviderModels.test.ts checks this copy against
// own_ai_model_fixtures.json. The credits-funded managed tier's model comes
// from the controller (credential requirements' managedAi.modelId and
// modelLabel); Studio keeps no copy of it.
export const DEFAULT_PROJECT_AI_MODEL = "gpt-6-sol";
// A cheaper model a person may pick for their own AI. Instafy never picks it
// on its own: defaults and older picks run DEFAULT_PROJECT_AI_MODEL. The
// picker offers only models that run as picked, so aiProviderModels.test.ts
// fails if a bump of the default would raise this one.
export const OWN_AI_SMALL_MODEL_ID = "gpt-6-luna";
export const DEFAULT_OPENAI_MODEL_OPTION = {
  id: DEFAULT_PROJECT_AI_MODEL,
  label: DEFAULT_PROJECT_AI_MODEL,
} as const;
