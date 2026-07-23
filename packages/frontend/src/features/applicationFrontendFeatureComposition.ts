import { APPLICATION_FRONTEND_FEATURE_MODULES } from "virtual:instafy/frontend-feature-manifest";
import { createFrontendApplicationComposition } from "./frontendApplicationComposition";

export const APPLICATION_FRONTEND_FEATURE_COMPOSITION =
  createFrontendApplicationComposition(
    APPLICATION_FRONTEND_FEATURE_MODULES,
  );

export const APPLICATION_FRONTEND_FEATURES =
  APPLICATION_FRONTEND_FEATURE_COMPOSITION.features;

export const APPLICATION_FRONTEND_REGISTRATION_INPUTS =
  APPLICATION_FRONTEND_FEATURE_COMPOSITION.registrations;
