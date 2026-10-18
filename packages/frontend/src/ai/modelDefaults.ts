export const DEFAULT_PROJECT_AI_MODEL = "gpt-5.6-sol";
// This is the bring-your-own OpenAI default. The credits-funded managed tier's
// model comes from the controller (credential requirements' managedAi.modelId
// and modelLabel); Studio keeps no copy of it.
export const DEFAULT_OPENAI_MODEL_OPTION = {
  id: DEFAULT_PROJECT_AI_MODEL,
  label: DEFAULT_PROJECT_AI_MODEL,
} as const;
