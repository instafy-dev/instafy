import { APPLICATION_FRONTEND_FEATURE_MODULES } from "virtual:instafy/frontend-feature-manifest";
import { createFrontendApplicationComposition } from "./frontendApplicationComposition";
import { registerTurnEngines } from "./turnEngineRegistry";

export const APPLICATION_FRONTEND_FEATURE_COMPOSITION =
  createFrontendApplicationComposition(
    APPLICATION_FRONTEND_FEATURE_MODULES,
  );

export const APPLICATION_FRONTEND_FEATURES =
  APPLICATION_FRONTEND_FEATURE_COMPOSITION.features;

// Core code words turn-engine turns from this registry, never from this
// module, whose manifest only the application's Vite configurations resolve.
registerTurnEngines(APPLICATION_FRONTEND_FEATURES.turnEngines);

export const APPLICATION_FRONTEND_REGISTRATION_INPUTS =
  APPLICATION_FRONTEND_FEATURE_COMPOSITION.registrations;
