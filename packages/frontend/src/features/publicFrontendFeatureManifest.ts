import { PUBLIC_CORE_FRONTEND_FEATURE_MODULE } from "./publicCoreFrontendFeatureModule";
import { CLAUDE_CODE_FRONTEND_FEATURE_MODULE } from "./claudeCode/claudeCodeFeatureModule";

export const APPLICATION_FRONTEND_FEATURE_MODULES = Object.freeze([
  PUBLIC_CORE_FRONTEND_FEATURE_MODULE,
  CLAUDE_CODE_FRONTEND_FEATURE_MODULE,
]);
