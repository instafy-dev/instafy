import { PUBLIC_CORE_FRONTEND_FEATURE_MODULE } from "../src/features/publicCoreFrontendFeatureModule";
import { STUDIO_PERFORMANCE_FEATURE_MODULE } from "./performance/featureModule";

export const APPLICATION_FRONTEND_FEATURE_MODULES = Object.freeze([
  PUBLIC_CORE_FRONTEND_FEATURE_MODULE,
  STUDIO_PERFORMANCE_FEATURE_MODULE,
]);
