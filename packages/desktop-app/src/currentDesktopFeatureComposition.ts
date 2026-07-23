import { createDesktopExtensionRegistry } from "./desktopExtensionRegistry";
import {
  APPLICATION_DESKTOP_FEATURE_MODULES,
} from "virtual:instafy/desktop-feature-manifest";

export const CURRENT_DESKTOP_FEATURE_MODULES =
  APPLICATION_DESKTOP_FEATURE_MODULES;

export const CURRENT_DESKTOP_EXTENSION_REGISTRY =
  createDesktopExtensionRegistry(CURRENT_DESKTOP_FEATURE_MODULES);
