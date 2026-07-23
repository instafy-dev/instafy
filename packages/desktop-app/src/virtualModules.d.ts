declare module "virtual:instafy/desktop-feature-manifest" {
  import type { DesktopExtensionFeatureModule } from "./desktopExtensionRegistry";

  export const APPLICATION_DESKTOP_FEATURE_MODULES: readonly DesktopExtensionFeatureModule[];
}
