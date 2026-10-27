declare module "virtual:instafy/desktop-feature-manifest" {
  import type { DesktopExtensionFeatureModule } from "./desktopExtensionRegistry";

  export const APPLICATION_DESKTOP_FEATURE_MODULES: readonly DesktopExtensionFeatureModule[];
}

// The instafy-web-research skill's link-only-sites.json, bundled from the
// runtime-agent assets at build time (see tsup.config.ts).
declare module "virtual:instafy/link-only-sites" {
  const data: unknown;
  export default data;
}

// The instafy-web-research skill's search-engines.json (address-bar search in
// the Personal Browser), bundled the same way.
declare module "virtual:instafy/search-engines" {
  const data: unknown;
  export default data;
}
