export const DEFAULT_PROJECT_AI_MODEL = "gpt-5.6-sol";
// Mirrors the controller's DEFAULT_MANAGED_AI_MODEL_LABEL (the credits-funded
// managed tier). The project default model above is the bring-your-own OpenAI
// default and deliberately stays on gpt-5.6-sol.
export const DEFAULT_MANAGED_AI_MODEL_LABEL = "GPT-6 Luna";
export const DEFAULT_OPENAI_MODEL_OPTION = {
  id: DEFAULT_PROJECT_AI_MODEL,
  label: DEFAULT_PROJECT_AI_MODEL,
} as const;
