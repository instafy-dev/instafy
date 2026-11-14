import type { FrontendTurnEngineContribution } from "./frontendFeatureModule";

/**
 * The turn engines of this Studio's feature composition, for core code that
 * words their turns (conversations/runFailurePresentation.ts).
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
