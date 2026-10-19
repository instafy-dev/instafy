import { DEFAULT_PROJECT_AI_MODEL } from "../../../src/ai/modelDefaults.js";

/**
 * The one model id end-to-end specs ask for when a spec-specific variable is
 * unset. It follows the app's own default (`src/ai/modelDefaults.ts`) so specs
 * never pin an id upstream has retired; override every spec at once with
 * E2E_MODEL. Never read the shell's CODEX_MODEL here: that is a runtime
 * launch value, not a test choice.
 */
export const E2E_MODEL = (process.env.E2E_MODEL ?? "").trim() || DEFAULT_PROJECT_AI_MODEL;

/** First non-empty of the named variables, else {@link E2E_MODEL}. */
export function e2eModelFromEnv(...names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value) return value;
  }
  return E2E_MODEL;
}
