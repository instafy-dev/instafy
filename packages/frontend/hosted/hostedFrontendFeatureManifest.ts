import { PUBLIC_CORE_FRONTEND_FEATURE_MODULE } from "../src/features/publicCoreFrontendFeatureModule";
import { CLAUDE_CODE_FRONTEND_FEATURE_MODULE } from "../src/features/claudeCode/claudeCodeFeatureModule";
import { STUDIO_PERFORMANCE_FEATURE_MODULE } from "./performance/featureModule";

export const APPLICATION_FRONTEND_FEATURE_MODULES = Object.freeze([
  PUBLIC_CORE_FRONTEND_FEATURE_MODULE,
  CLAUDE_CODE_FRONTEND_FEATURE_MODULE,
  STUDIO_PERFORMANCE_FEATURE_MODULE,
]);
