import { CLAUDE_CODE_DESKTOP_FEATURE_MODULE } from "./claudeCode";
import type { DesktopExtensionFeatureModule } from "./desktopExtensionRegistry";

export const APPLICATION_DESKTOP_FEATURE_MODULES: readonly DesktopExtensionFeatureModule[] =
  Object.freeze([CLAUDE_CODE_DESKTOP_FEATURE_MODULE]);
