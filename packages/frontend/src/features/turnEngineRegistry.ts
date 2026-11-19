import type { FrontendTurnEngineAgentAi, FrontendTurnEngineContribution } from "./frontendFeatureModule";

/**
 * The turn engines of this Studio's feature composition, for core code that
 * words their turns (conversations/runFailurePresentation.ts) and names an
 * agent's AI.
 *
 * The application's composition (applicationFrontendFeatureComposition.ts)
 * registers them when it is built, at startup. Core code reads them here
 * instead of importing that composition, whose virtual feature manifest only
 * the application's Vite configurations resolve: the browser-component lane
 * (vite.ci-ui.config.ts) mounts core components without it, and there they see
 * no turn engines, as a Studio built without any.
 */
let registeredEngines: readonly FrontendTurnEngineContribution[] = Object.freeze([]);

/** Sets the turn engines of the application's composition. */
export function registerTurnEngines(engines: readonly FrontendTurnEngineContribution[]): void {
  registeredEngines = Object.freeze([...engines]);
}

/** The turn engines this Studio was built with: none until the composition registers them. */
export function registeredTurnEngines(): readonly FrontendTurnEngineContribution[] {
  return registeredEngines;
}

/**
 * The turn engine an agent's `provider` names as its AI, with how the agent
 * editor and the lists of agents name it (docs/Local-Engine-Turns.md 11.3);
 * null for any other provider, and for an engine this Studio was built
 * without.
 */
export function turnEngineAgentAiOf(
  provider: string | null | undefined,
): { engineId: string; agentAi: FrontendTurnEngineAgentAi } | null {
  const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (!normalized) {
    return null;
  }
  const engine = registeredEngines.find((candidate) => candidate.id === normalized && candidate.agentAi);
  return engine?.agentAi ? { engineId: engine.id, agentAi: engine.agentAi } : null;
}
